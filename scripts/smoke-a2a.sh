#!/usr/bin/env bash
# End-to-end smoke test for the A2A OBO chain + privileged restart THROUGH the
# agentgateway.
#
# Topology (post-agentgateway): the specialist no longer exchanges directly to
# aud=mcp-ops. It mints an aud=mcp-gateway token (scope ops:write) and calls the
# gateway's /ops/mcp route; the gateway validates the JWT, applies per-tool RBAC,
# and (via the co-located exchange-shim) re-exchanges to aud=mcp-ops — inserting
# the gateway's SPIFFE ID into the act chain — before forwarding to mcp-ops, which
# validates the grown chain [agentgateway, agent-specialist, agent-copilot] and
# re-exchanges again to ops-api.
#
# Assertions:
#   [A] copilot exchanges user → aud=agent-specialist (act.sub=copilot).
#   [B] specialist re-exchanges → aud=mcp-gateway (scope ops:write); the token's
#       act chain is depth-2 [specialist, copilot] (the gateway position is added
#       by the shim at call time, downstream — not in this token).
#   [C] positive: that mcp-gateway token drives tools/call restart_deployment
#       through the gateway → HTTP 200. mcp-ops accepts the grown act chain
#       [agentgateway, specialist, copilot].
#   [D1] negative: a user-aud (agent-copilot) token to the gateway /ops/mcp is
#        rejected at the gateway (aud≠mcp-gateway) → 401.
#   [D2] negative: a depth-1 specialist-aud (agent-specialist) token to /ops/mcp
#        is likewise rejected at the gateway (aud≠mcp-gateway) → 401.
#   [D3] negative: Curity refuses to MINT a wrong path at all — copilot cannot
#        exchange directly to aud=mcp-ops.
#
# The gateway authenticates on the JWT audience (aud=mcp-gateway), not mTLS source
# identity, so the calls below can run from any in-mesh pod; we use the specialist
# pod for parity with the real caller. The app-level act-chain + step-up checks
# still run in the resource-server middleware (exercised fully by smoke-stepup.sh).
#
# Pre-reqs:
#   - kubectl context points at the demo cluster; `make apply` + `make routing` ran.
#   - agentgateway, mcp-ops, agent-specialist Deployments are Ready.
#   - $SMOKE_SUBJECT_TOKEN set to a fresh Curity access token for Alice
#     (per docs/curity-seed.md or /api/whoami with AUTH_DEBUG=true).
#
# Exit codes: 0 on success, non-zero on any failed assertion.

set -euo pipefail

CURITY_TOKEN_URL="${CURITY_TOKEN_URL:-https://curity.localtest.me/oauth/v2/oauth-token}"
GATEWAY_OPS_URL="${GATEWAY_OPS_URL:-http://agentgateway.mcp.svc.cluster.local:8080/ops/mcp}"
CACERT="$(mkcert -CAROOT)/rootCA.pem"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COPILOT_CLIENT_ID="${COPILOT_CLIENT_ID:-https://copilot.localtest.me/.well-known/oauth-client}"
SPECIALIST_CLIENT_ID="${SPECIALIST_CLIENT_ID:-https://specialist.localtest.me/.well-known/oauth-client}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '==> %s\n' "$*"; }

redact() {
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

decode_jwt_payload() {
  python3 -c '
import sys, base64, json
parts = sys.stdin.read().strip().split(".")
if len(parts) < 2:
    print("{}"); sys.exit(0)
s = parts[1]
s += "=" * (-len(s) % 4)
print(json.dumps(json.loads(base64.urlsafe_b64decode(s))))
'
}

# mcp_call: drive an MCP Streamable HTTP request through the gateway from a pod.
# Runs initialize (capturing mcp-session-id + notifications/initialized) then the
# requested method; echoes "<status>:<body-slice>" (or "INIT_<status>:..." if the
# initialize handshake itself is rejected — e.g. the gateway 401 on a bad audience).
#   $1 ns  $2 deploy  $3 container  $4 url  $5 bearer  $6 method  $7 params-json
mcp_call() {
  kubectl -n "$1" exec "deploy/$2" -c "$3" -- \
    env U="$4" B="$5" M="$6" P="$7" node -e '
(async () => {
  const url = process.env.U, bearer = process.env.B, method = process.env.M;
  const params = process.env.P ? JSON.parse(process.env.P) : {};
  const base = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer " + bearer };
  const initBody = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", clientInfo: { name: "smoke", version: "0" }, capabilities: {} } });
  const r1 = await fetch(url, { method: "POST", headers: base, body: initBody });
  if (!r1.ok) { process.stdout.write("INIT_" + r1.status + ":" + (await r1.text()).slice(0, 300)); return; }
  const sid = r1.headers.get("mcp-session-id");
  const h2 = sid ? Object.assign({}, base, { "mcp-session-id": sid }) : base;
  if (sid) { await fetch(url, { method: "POST", headers: h2, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) }); }
  const r2 = await fetch(url, { method: "POST", headers: h2, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) });
  // Correctness constraint, not display — see the note in smoke-stepup.sh: callers
  // pattern-match this string, so a truncated body reads as a missing value.
  process.stdout.write(String(r2.status) + ":" + (await r2.text()).slice(0, 20000));
})().catch(e => process.stdout.write("ERR:" + e.message));
' 2>/dev/null || true
}

if [[ -z "${SMOKE_SUBJECT_TOKEN:-}" ]]; then
  red "SMOKE_SUBJECT_TOKEN is required (see scripts/smoke-token-exchange.sh for how)."
  exit 78
fi
SUBJECT_TOKEN="$SMOKE_SUBJECT_TOKEN"

note "Pulling SVIDs and CIMD private keys from in-cluster Secrets"
COPILOT_SVID=$(kubectl -n agents exec deploy/agent-copilot -c agent -- \
  cat /run/spiffe/curity-actor.jwt | tr -d '\n')
[[ -n "$COPILOT_SVID" ]] || { red "no copilot SVID"; exit 1; }
SPECIALIST_SVID=$(kubectl -n agents exec deploy/agent-specialist -c agent -- \
  cat /run/spiffe/curity-actor.jwt | tr -d '\n')
[[ -n "$SPECIALIST_SVID" ]] || { red "no specialist SVID"; exit 1; }
COPILOT_PEM=$(kubectl -n agents get secret agent-copilot-curity \
  -o jsonpath='{.data.CURITY_AGENT_PRIVATE_KEY_PEM}' \
  | python3 -c 'import sys,base64;print(base64.b64decode(sys.stdin.read()).decode(),end="")')
SPECIALIST_PEM=$(kubectl -n agents get secret agent-specialist-curity \
  -o jsonpath='{.data.CURITY_AGENT_PRIVATE_KEY_PEM}' \
  | python3 -c 'import sys,base64;print(base64.b64decode(sys.stdin.read()).decode(),end="")')
[[ -n "$COPILOT_PEM" && -n "$SPECIALIST_PEM" ]] || { red "missing CIMD private key"; exit 1; }

# Fresh private_key_jwt assertion (unique jti) per token call, per client.
copilot_assertion() {
  printf '%s' "$COPILOT_PEM" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" "$COPILOT_CLIENT_ID" "$CURITY_TOKEN_URL"
}
specialist_assertion() {
  printf '%s' "$SPECIALIST_PEM" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" "$SPECIALIST_CLIENT_ID" "$CURITY_TOKEN_URL"
}

# ----- Step A: copilot exchange → aud=agent-specialist -------------------
note "[A] Exchange user → agent-specialist (copilot client + copilot SVID)"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(copilot_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$COPILOT_SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=agent-specialist" \
  -d "scope=obs:read ops:write" \
  "$CURITY_TOKEN_URL")
SPECIALIST_BEARER=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$SPECIALIST_BEARER" ]] || { red "no token in A: $(echo "$RESP" | redact)"; exit 1; }

PAYLOAD=$(echo "$SPECIALIST_BEARER" | decode_jwt_payload)
ACT_SUB=$(echo "$PAYLOAD" | jq -r '.act.sub // empty')
[[ "$ACT_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "expected act.sub=copilot, got: $ACT_SUB"; exit 1; }
green "  OK (specialist-bound token issued, act.sub=copilot)"

# ----- Step B: specialist re-exchange → aud=mcp-gateway ------------------
note "[B] Exchange specialist-bound token → mcp-gateway (specialist client + specialist SVID)"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$SPECIALIST_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(specialist_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SPECIALIST_BEARER" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SPECIALIST_SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-gateway" \
  -d "scope=ops:write" \
  "$CURITY_TOKEN_URL")
GATEWAY_BEARER=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$GATEWAY_BEARER" ]] || { red "no token in B: $(echo "$RESP" | redact)"; exit 1; }

PAYLOAD=$(echo "$GATEWAY_BEARER" | decode_jwt_payload)
AUD=$(echo "$PAYLOAD" | jq -r 'if (.aud|type)=="array" then .aud|join(" ") else .aud end')
OUTER_SUB=$(echo "$PAYLOAD" | jq -r '.act.sub // empty')
INNER_SUB=$(echo "$PAYLOAD" | jq -r '.act.act.sub // empty')
[[ "$AUD" == *"mcp-gateway"* ]] || { red "aud not mcp-gateway: $AUD"; exit 1; }
[[ "$OUTER_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-specialist" ]] \
  || { red "outer act.sub wrong: $OUTER_SUB"; exit 1; }
[[ "$INNER_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "inner act.act.sub wrong: $INNER_SUB"; exit 1; }
green "  OK (aud=mcp-gateway; depth-2 chain: outer=specialist, inner=copilot)"

# ----- Step C: restart_deployment through the gateway /ops/mcp -----------
note "[C] Positive: restart_deployment through the gateway (gateway adds its act position)"
STATUS=$(mcp_call agents agent-specialist agent \
  "$GATEWAY_OPS_URL" "$GATEWAY_BEARER" "tools/call" \
  '{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod","reason":"a2a smoke"}}')
case "$STATUS" in
  200*) green "  OK (gateway → mcp-ops accepted the grown chain: ${STATUS:0:80}...)" ;;
  *)    red "  unexpected response: $STATUS"; exit 1 ;;
esac

# ----- Negative D1: user-aud token to the gateway → 401 (wrong audience) --
note "[D1] Negative: user-aud token to gateway /ops/mcp → expect gateway 401 (aud≠mcp-gateway)"
STATUS=$(mcp_call agents agent-specialist agent \
  "$GATEWAY_OPS_URL" "$SUBJECT_TOKEN" "tools/call" \
  '{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod"}}')
case "$STATUS" in
  INIT_401*|401*) green "  OK (gateway rejected wrong audience: $STATUS)" ;;
  INIT_403*|403*) green "  OK (gateway denied: $STATUS)" ;;
  *) red "  expected 401/403 at the gateway, got: $STATUS"; exit 1 ;;
esac

# ----- Negative D2: depth-1 specialist-aud token to the gateway → 401 -----
note "[D2] Negative: specialist-aud token to gateway /ops/mcp → expect gateway 401 (aud≠mcp-gateway)"
STATUS=$(mcp_call agents agent-specialist agent \
  "$GATEWAY_OPS_URL" "$SPECIALIST_BEARER" "tools/call" \
  '{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod"}}')
case "$STATUS" in
  INIT_401*|401*) green "  OK (gateway rejected wrong audience: $STATUS)" ;;
  INIT_403*|403*) green "  OK (gateway denied: $STATUS)" ;;
  *) red "  expected 401/403 at the gateway, got: $STATUS"; exit 1 ;;
esac

# ----- Negative D3: copilot cannot mint an mcp-ops token at all ----------
note "[D3] Negative: copilot exchanging directly to aud=mcp-ops → expect Curity denial"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(copilot_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$COPILOT_SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-ops" \
  -d "scope=ops:write" \
  "$CURITY_TOKEN_URL")
ERR=$(echo "$RESP" | jq -r '.error // empty')
DESC=$(echo "$RESP" | jq -r '.error_description // empty')
case "$ERR" in
  invalid_request|invalid_audience|invalid_target|access_denied)
    green "  OK (Curity refused outright: error=$ERR description='$DESC')" ;;
  invalid_scope)
    green "  OK (Curity refused via scope path: error=$ERR description='$DESC')" ;;
  *)
    red "  expected Curity to deny copilot exchanging directly to mcp-ops, got: $(echo "$RESP" | redact)"
    exit 1 ;;
esac

echo
green "ALL A2A SMOKE CHECKS PASSED"
