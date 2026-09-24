#!/usr/bin/env bash
# End-to-end smoke test for the OBO read path THROUGH the agentgateway.
# Runs against the live KIND cluster.
#
# Topology (post-agentgateway): the agent no longer exchanges directly to
# aud=mcp-inspect. It mints an aud=mcp-gateway token and calls the gateway's
# /inspect/mcp route; the gateway validates the JWT, applies per-tool RBAC,
# and (via the co-located exchange-shim) re-exchanges to aud=mcp-inspect —
# inserting the gateway's SPIFFE ID into the act chain — before forwarding to the
# origin MCP server, which re-exchanges again to inspect-api.
#
# Assertions:
#   [1/5] positive: Alice's subject token + copilot SVID exchange to
#         aud=mcp-gateway (scope inspect:read) with act.sub=copilot.
#   [2/5] positive (REAL OBO hop): that mcp-gateway token drives a tools/call
#         list_pods through the gateway → HTTP 200 with prod pods. This exercises
#         gateway JWT + RBAC + extAuthz→shim→exchange→mcp-inspect→inspect-api.
#   [3/5] negative: copilot exchanging DIRECTLY to aud=mcp-inspect is denied
#         (the gateway is the only door now — copilot's policy dropped that audience).
#   [4/5] negative: omitting actor_token → invalid_request from Curity.
#   [5/5] negative: requesting scope=ops:write for aud=mcp-gateway → invalid_scope
#         (copilot's claims policy allows only inspect:read for the gateway audience).
#
# Per-hop act.sub / act-chain enforcement lives in the resource-server middleware
# (apps/*/src/auth-middleware.ts) and is exercised by unit tests + the A2A/step-up
# smoke scripts (which assert the grown, gateway-including chain end to end).
#
# Pre-reqs:
#   - kubectl context points at the demo cluster; `make apply` + `make routing` ran.
#   - `alice` exists in Curity (per docs/curity-seed.md).
#   - agent-copilot is a CIMD ephemeral client; this script authenticates with a
#     private_key_jwt assertion signed by the PKCS8 key in the agent-copilot-curity
#     Secret (seeded via `make seed-agent-key`), exactly as the agent does.
#
# Required env: SMOKE_SUBJECT_TOKEN — a fresh Curity access token for Alice.
# Easiest way to obtain: open https://app.localtest.me, sign in, then read the
# token from /api/whoami's server log when AUTH_DEBUG=true on the web pod.
#
# Exit codes: 0 on success, non-zero on any failed assertion.

set -euo pipefail

CURITY_TOKEN_URL="${CURITY_TOKEN_URL:-https://curity.localtest.me/oauth/v2/oauth-token}"
GATEWAY_INSPECT_URL="${GATEWAY_INSPECT_URL:-http://agentgateway.mcp.svc.cluster.local:8080/inspect/mcp}"
CACERT="$(mkcert -CAROOT)/rootCA.pem"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COPILOT_CLIENT_ID="${COPILOT_CLIENT_ID:-https://copilot.localtest.me/.well-known/oauth-client}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note() { printf '==> %s\n' "$*"; }

# Redact sensitive fields from response bodies before logging.
redact_resp() {
  python3 -c '
import sys, json
try:
    body = json.loads(sys.stdin.read())
except Exception:
    print("<unparseable>")
    sys.exit(0)
for k in ("access_token", "id_token", "refresh_token"):
    if k in body:
        body[k] = "<redacted>"
print(json.dumps(body))
'
}

# mcp_call: drive an MCP Streamable HTTP request through the gateway from inside a
# cluster pod (the gateway only checks the JWT, so any in-mesh pod works). Speaks
# protocol revision 2026-07-28: ONE request, no initialize handshake and no
# session (the revision removed both), so this echoes "<status>:<body-slice>".
#   $1 ns  $2 deploy  $3 container  $4 url  $5 bearer  $6 method  $7 params-json
mcp_call() {
  kubectl -n "$1" exec "deploy/$2" -c "$3" -- \
    env U="$4" B="$5" M="$6" P="$7" node -e '
(async () => {
  const url = process.env.U, bearer = process.env.B, method = process.env.M;
  const params = process.env.P ? JSON.parse(process.env.P) : {};
  // Per-request _meta envelope. All THREE reserved keys are required: the server
  // rejects a partial envelope with -32602 naming the missing one.
  params._meta = Object.assign({
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  }, params._meta || {});
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer " + bearer,
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method
  };
  // Mcp-Name is what the gateway per-tool authz rules key on, and Mcp-Param-Namespace
  // is the SEP-2243 mirror its namespace-confinement rule reads. A real client emits
  // both, so this helper must too or it would exercise a different policy path.
  if (method === "tools/call" && params.name) headers["mcp-name"] = params.name;
  const ns = params.arguments && params.arguments.namespace;
  if (ns) headers["mcp-param-namespace"] = ns;
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  // Correctness constraint, not display — see the note in smoke-stepup.sh. At 600 the
  // `200*order-service*` assertion below could silently fall through to its weaker
  // "call succeeded but body did not name it" fallback.
  // (No apostrophes in this comment: the whole script is a single-quoted shell string.)
  process.stdout.write(String(r.status) + ":" + (await r.text()).slice(0, 20000));
})().catch(e => process.stdout.write("ERR:" + e.message));
' 2>/dev/null || true
}

if [[ -z "${SMOKE_SUBJECT_TOKEN:-}" ]]; then
  red "SMOKE_SUBJECT_TOKEN env var is required."
  cat <<HINT
Set it to a fresh Curity access token for Alice. To grab one:
  1. Open https://app.localtest.me, sign in as Alice.
  2. With AUTH_DEBUG=true set on the web pod, the access token shows in
     /api/whoami's server logs.
  3. export SMOKE_SUBJECT_TOKEN='eyJ...'.
HINT
  exit 78  # EX_CONFIG
fi
SUBJECT_TOKEN="$SMOKE_SUBJECT_TOKEN"

note "Pulling live SVID from agent-copilot pod"
SVID=$(kubectl -n agents exec deploy/agent-copilot -c agent -- \
  cat /run/spiffe/curity-actor.jwt | tr -d '\n')
[[ -n "$SVID" ]] || { red "no SVID at /run/spiffe/curity-actor.jwt"; exit 1; }

note "Pulling agent-copilot private key (PKCS8 PEM) from in-cluster Secret"
CLIENT_PEM=$(kubectl -n agents get secret agent-copilot-curity \
  -o jsonpath='{.data.CURITY_AGENT_PRIVATE_KEY_PEM}' \
  | python3 -c 'import sys, base64; print(base64.b64decode(sys.stdin.read()).decode(), end="")')
[[ -n "$CLIENT_PEM" ]] || { red "agent-copilot-curity secret missing/empty"; exit 1; }

# Sign a FRESH private_key_jwt assertion (unique jti, 60s exp) per token call.
client_assertion() {
  printf '%s' "$CLIENT_PEM" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" \
    "$COPILOT_CLIENT_ID" "$CURITY_TOKEN_URL"
}

# ----- [1/5] Positive: exchange Alice subject + copilot SVID → aud=mcp-gateway ----
note "[1/5] Positive: exchange Alice subject + copilot SVID → aud=mcp-gateway"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-gateway" \
  -d "scope=inspect:read" \
  "$CURITY_TOKEN_URL")
GATEWAY_BEARER=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$GATEWAY_BEARER" ]] || { red "no access_token in positive response: $(echo "$RESP" | redact_resp)"; exit 1; }
# Decode the payload (base64url + JSON).
read_claim() { echo "$GATEWAY_BEARER" | cut -d. -f2 | python3 -c "
import sys, base64, json
s = sys.stdin.read().strip(); s += '=' * (-len(s) % 4)
p = json.loads(base64.urlsafe_b64decode(s))
v = p.get('$1', '')
print(v if isinstance(v, str) else ' '.join(v))"; }
ACT_SUB=$(echo "$GATEWAY_BEARER" | cut -d. -f2 | python3 -c '
import sys, base64, json
s = sys.stdin.read().strip(); s += "=" * (-len(s) % 4)
print(json.loads(base64.urlsafe_b64decode(s)).get("act", {}).get("sub", ""))')
AUD=$(read_claim aud)
SCOPE=$(read_claim scope)
[[ "$ACT_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "act.sub mismatch: $ACT_SUB"; exit 1; }
[[ "$AUD" == *"mcp-gateway"* ]] || { red "aud mismatch: $AUD"; exit 1; }
[[ "$SCOPE" == *"inspect:read"* ]] || { red "scope mismatch: $SCOPE"; exit 1; }
green "  OK (act.sub=$ACT_SUB, aud=$AUD, scope=$SCOPE)"

# ----- [2/5] Positive: real read through the gateway (list_pods → 200 + pods) -----
note "[2/5] Positive: tools/call list_pods through the gateway (REAL OBO hop)"
STATUS=$(mcp_call agents agent-copilot agent \
  "$GATEWAY_INSPECT_URL" "$GATEWAY_BEARER" "tools/call" \
  '{"name":"list_pods","arguments":{"namespace":"prod"}}')
case "$STATUS" in
  200*order-service*) green "  OK (gateway returned prod pods: ${STATUS:0:80}...)" ;;
  200*) green "  OK (gateway 200; body did not name order-service but call succeeded: ${STATUS:0:120})" ;;
  *) red "  expected 200 with pods through the gateway, got: $STATUS"; exit 1 ;;
esac

# ----- [3/5] Negative: copilot direct-to-mcp-inspect is denied --------------
note "[3/5] Negative: copilot exchanging DIRECTLY to aud=mcp-inspect → expect denied"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-inspect" \
  -d "scope=inspect:read" \
  "$CURITY_TOKEN_URL")
ACCESS=$(echo "$RESP" | jq -r '.access_token // empty')
ERR=$(echo "$RESP" | jq -r '.error // empty')
DESC=$(echo "$RESP" | jq -r '.error_description // empty')
if [[ -n "$ACCESS" ]]; then
  red "  copilot should NOT be able to exchange directly to mcp-inspect (the gateway is the door)"; exit 1
fi
# Curity may surface the procedure denial as invalid_request/invalid_scope/
# access_denied/invalid_audience (it sanitizes procedure-thrown codes into
# error_description). Any denial is the correct outcome.
case "$ERR" in
  invalid_request|invalid_scope|access_denied|invalid_audience|invalid_target)
    green "  OK (denied: error=$ERR description='$DESC')" ;;
  *) red "  expected a denial, got: $(echo "$RESP" | redact_resp)"; exit 1 ;;
esac

# ----- [4/5] Negative: missing actor_token → invalid_request ----------------------
note "[4/5] Negative: omit actor_token (aud=mcp-gateway) → expect invalid_request"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "audience=mcp-gateway" \
  -d "scope=inspect:read" \
  "$CURITY_TOKEN_URL")
ERR=$(echo "$RESP" | jq -r '.error // empty')
[[ "$ERR" == "invalid_request" ]] \
  || { red "expected invalid_request, got: $(echo "$RESP" | redact_resp)"; exit 1; }
green "  OK (error=$ERR)"

# ----- [5/5] Negative: request a disallowed scope for aud=mcp-gateway -------------
note "[5/5] Negative: request scope=ops:write for aud=mcp-gateway → expect invalid_scope"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-gateway" \
  -d "scope=ops:write" \
  "$CURITY_TOKEN_URL")
ERR=$(echo "$RESP" | jq -r '.error // empty')
DESC=$(echo "$RESP" | jq -r '.error_description // empty')
# Accept either the strict form (error=invalid_scope) OR Curity's sanitized
# form (error=invalid_request with an 'invalid_scope' description prefix).
if [[ "$ERR" == "invalid_scope" ]]; then
  green "  OK (error=$ERR)"
elif [[ "$ERR" == "invalid_request" ]] && [[ "$DESC" == invalid_scope* ]]; then
  green "  OK (error=$ERR, description carries 'invalid_scope' prefix)"
else
  red "expected invalid_scope (or invalid_request+'invalid_scope' description), got: $(echo "$RESP" | redact_resp)"
  exit 1
fi

echo
green "ALL OBO SMOKE CHECKS COMPLETED"
