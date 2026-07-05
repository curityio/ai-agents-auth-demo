#!/usr/bin/env bash
# End-to-end smoke test for identity-bound LLM egress THROUGH the agentgateway.
# Runs against the live KIND cluster.
#
# Topology: agent-copilot mints an aud=llm-gateway / scope=llm:invoke token via
# the same RFC 8693 exchange it uses for MCP (Alice's subject token + the
# agent's SPIFFE JWT-SVID as actor_token), then calls the gateway's
# /llm/chat/completions route. The gateway validates the JWT, authorizes
# llm:invoke, swaps in the Azure OpenAI API key server-side, and forwards to
# Azure. The agents never hold the Azure key.
#
# Assertions:
#   [1/3] positive: Alice's subject token + copilot SVID exchange to
#         aud=llm-gateway (scope llm:invoke).
#   [2/3] positive (REAL egress): that llm-gateway token drives a chat
#         completion through the gateway → HTTP 200 (proves JWT validate +
#         llm:invoke authz + api-key swap + real Azure round-trip).
#   [3/3] negative: an aud=mcp-gateway / scope=obs:read token (no llm:invoke)
#         is denied AT the gateway (401/403), before any Azure call.
#   plus: AZURE_OPENAI_API_KEY is absent from agent-copilot's env (the
#         credential moved server-side into the gateway).
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
GATEWAY_LLM_URL="${GATEWAY_LLM_URL:-http://agentgateway.mcp.svc.cluster.local:8080/llm/chat/completions}"
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

# llm_call: POST a plain OpenAI-compatible chat-completions request through the
# gateway from inside a cluster pod (the gateway only checks the JWT, so any
# in-mesh pod works). Unlike mcp_call, this is a single plain POST — no MCP
# initialize handshake, no mcp-session-id. Echoes "<status>:<body-slice>".
# Args: $1 ns  $2 deploy  $3 container  $4 url  $5 bearer  $6 json-body
llm_call() {
  kubectl -n "$1" exec "deploy/$2" -c "$3" -- \
    env U="$4" B="$5" D="$6" node -e '
(async () => {
  const url = process.env.U, bearer = process.env.B, data = process.env.D;
  const headers = { "content-type": "application/json", authorization: "Bearer " + bearer };
  const r = await fetch(url, { method: "POST", headers, body: data });
  process.stdout.write(String(r.status) + ":" + (await r.text()).slice(0, 600));
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

# ----- [1/3] Positive: exchange Alice subject + copilot SVID → aud=llm-gateway ----
note "[1/3] Positive: exchange Alice subject + copilot SVID → aud=llm-gateway"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=llm-gateway" \
  -d "scope=llm:invoke" \
  "$CURITY_TOKEN_URL")
LLM_TOKEN=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$LLM_TOKEN" ]] || { red "no access_token in positive response: $(echo "$RESP" | redact_resp)"; exit 1; }
# Decode the payload (base64url + JSON).
read_claim() { echo "$1" | cut -d. -f2 | python3 -c "
import sys, base64, json
s = sys.stdin.read().strip(); s += '=' * (-len(s) % 4)
p = json.loads(base64.urlsafe_b64decode(s))
v = p.get('$2', '')
print(v if isinstance(v, str) else ' '.join(v))"; }
AUD=$(read_claim "$LLM_TOKEN" aud)
SCOPE=$(read_claim "$LLM_TOKEN" scope)
[[ "$AUD" == *"llm-gateway"* ]] || { red "aud mismatch: $AUD"; exit 1; }
[[ "$SCOPE" == *"llm:invoke"* ]] || { red "scope mismatch: $SCOPE"; exit 1; }
green "  OK (aud=$AUD, scope=$SCOPE)"

# ----- [2/3] Positive: real egress through the gateway (REAL Azure call) ---------
note "[2/3] Positive: chat completion through the gateway (REAL Azure round-trip)"
STATUS=$(llm_call agents agent-copilot agent \
  "$GATEWAY_LLM_URL" "$LLM_TOKEN" \
  '{"model":"gpt-4.1","messages":[{"role":"user","content":"ping"}]}')
case "$STATUS" in
  200*) green "  OK (gateway + Azure returned 200: ${STATUS:0:120}...)" ;;
  *) red "  expected 200 through the gateway, got: $STATUS"; exit 1 ;;
esac

# ----- [3/3] Negative: aud=mcp-gateway (no llm:invoke) denied AT the gateway -----
# This proves AUDIENCE confinement, not scope enforcement: jwtAuth on the /llm
# route rejects this token because its aud is mcp-gateway, not llm-gateway —
# it never gets far enough to evaluate the llm:invoke scope rule. A scopeless
# aud=llm-gateway token isn't mintable to test the scope rule in isolation:
# Curity caps the llm-gateway audience to exactly ['llm:invoke'].
note "[3/3] Negative: exchange aud=mcp-gateway / scope=obs:read → expect denied at gateway"
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
  -d "scope=obs:read" \
  "$CURITY_TOKEN_URL")
MCP_TOKEN=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$MCP_TOKEN" ]] || { red "no access_token minting negative token: $(echo "$RESP" | redact_resp)"; exit 1; }
STATUS=$(llm_call agents agent-copilot agent \
  "$GATEWAY_LLM_URL" "$MCP_TOKEN" \
  '{"model":"gpt-4.1","messages":[{"role":"user","content":"ping"}]}')
case "$STATUS" in
  401*|403*) green "  OK (denied at gateway: ${STATUS:0:80})" ;;
  *) red "  expected 401/403 for a non-llm caller, got: $STATUS"; exit 1 ;;
esac

# ----- Credential moved: no Azure key on the agent pods --------------------------
note "Credential moved: asserting no AZURE_OPENAI_API_KEY on agent-copilot"
if ENV_LIST=$(kubectl -n agents set env deploy/agent-copilot --list 2>&1); then
  if echo "$ENV_LIST" | grep -qi AZURE_OPENAI_API_KEY; then
    red "  AZURE_OPENAI_API_KEY still present on agent-copilot"; exit 1
  fi
  green "  OK (no AZURE_OPENAI_API_KEY on agent-copilot)"
else
  note "  (non-fatal) could not read deploy/agent-copilot env: $ENV_LIST"
fi

echo
green "ALL LLM EGRESS SMOKE CHECKS COMPLETED"
