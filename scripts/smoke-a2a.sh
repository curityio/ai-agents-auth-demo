#!/usr/bin/env bash
# End-to-end smoke test for the OBO chain + privileged restart.
#
# Assertions:
#   - positive: copilot exchanges to aud=agent-specialist; specialist
#     re-exchanges to aud=mcp-ops; mcp-ops's middleware accepts the depth-2
#     `act` chain and PATCHes the order-service Deployment — which in turn flows
#     through the apis waypoint to ops-api.
#   - negative 1: a user-aud token presented to mcp-ops is denied at the mcp
#     waypoint (wrong audience) before it reaches the app → 403.
#   - negative 2: a depth-1 specialist-aud token is likewise denied at the
#     waypoint (wrong audience) → 403.
#   - negative 3: Curity refuses to MINT a wrong-order chain at all (copilot
#     can't exchange directly to mcp-ops).
#
# The mcp/apis waypoints (k8s/istio/{mcp,apis}-l7-authz.yaml) pin the caller's
# mTLS identity, so the mcp-ops HTTP calls below run from the agent-specialist
# pod. The waypoint also coarse-checks audience+scope, which fires BEFORE the
# resource server's act-chain middleware — so the wrong-audience negatives (1, 2)
# are caught at the waypoint. The app-level act-chain checks (act_required /
# act_chain_length / act_chain_order) still run for tokens that pass the waypoint,
# but can't be negative-tested from outside because Curity won't mint an mcp-ops
# token with a bad chain — which is exactly what negative 3 demonstrates.
#
# Pre-reqs:
#   - kubectl context points at the demo cluster
#   - mcp-ops + agent-specialist Deployments are Ready (`make apply` ran)
#   - $SMOKE_SUBJECT_TOKEN set to a fresh Curity access token for Alice
#     (per docs/curity-seed.md or /api/whoami with AUTH_DEBUG=true)
#
# Exit codes: 0 on success, non-zero on any failed assertion.

set -euo pipefail

CURITY_TOKEN_URL="${CURITY_TOKEN_URL:-https://curity.localtest.me/oauth/v2/oauth-token}"
SPECIALIST_A2A_URL="${SPECIALIST_A2A_URL:-http://agent-specialist.agents.svc.cluster.local:8082/a2a}"
MCP_OPS_URL="${MCP_OPS_URL:-http://mcp-ops.mcp.svc.cluster.local:8080/mcp}"
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

# ----- Step B: specialist re-exchange → aud=mcp-ops ----------------------
note "[B] Exchange specialist-bound token → mcp-ops (specialist client + specialist SVID)"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$SPECIALIST_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(specialist_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SPECIALIST_BEARER" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SPECIALIST_SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-ops" \
  -d "scope=ops:write" \
  "$CURITY_TOKEN_URL")
OPS_BEARER=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$OPS_BEARER" ]] || { red "no token in B: $(echo "$RESP" | redact)"; exit 1; }

PAYLOAD=$(echo "$OPS_BEARER" | decode_jwt_payload)
OUTER_SUB=$(echo "$PAYLOAD" | jq -r '.act.sub // empty')
INNER_SUB=$(echo "$PAYLOAD" | jq -r '.act.act.sub // empty')
[[ "$OUTER_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-specialist" ]] \
  || { red "outer act.sub wrong: $OUTER_SUB"; exit 1; }
[[ "$INNER_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "inner act.act.sub wrong: $INNER_SUB"; exit 1; }
green "  OK (depth-2 chain: outer=specialist, inner=copilot)"

# ----- Step C: mcp-ops restart_deployment with depth-2 token --------------
note "[C] Positive: mcp-ops restart_deployment with depth-2 chain"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"smoke","version":"0"},"capabilities":{}}}'
CALL='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod","reason":"a2a smoke"}}}'
# Single Streamable HTTP transport per request — mcp-ops is stateless. Runs from
# the agent-specialist pod so the mTLS caller identity matches the mcp waypoint's
# pinned principal (cluster.local/ns/agents/sa/agent-specialist).
STATUS=$(kubectl -n agents exec deploy/agent-specialist -c agent -- node -e "
(async () => {
  const init = '$INIT';
  const call = '$CALL';
  const headers = { authorization: 'Bearer $OPS_BEARER', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const r1 = await fetch('$MCP_OPS_URL', { method: 'POST', headers, body: init });
  if (!r1.ok) { process.stdout.write('INIT_'+r1.status); return; }
  const r2 = await fetch('$MCP_OPS_URL', { method: 'POST', headers, body: call });
  process.stdout.write(String(r2.status)+':'+(await r2.text()).slice(0, 240));
})().catch(e => process.stdout.write('ERR:'+e.message));
" 2>/dev/null || true)
case "$STATUS" in
  200*) green "  OK (mcp-ops accepted: $STATUS)" ;;
  *)    red "  unexpected response: $STATUS"; exit 1 ;;
esac

# ----- Negative 1: user-aud token to mcp-ops → denied at the waypoint -----
note "[D1] Negative: user-aud token to mcp-ops → expect waypoint 403 (wrong audience)"
STATUS=$(kubectl -n agents exec deploy/agent-specialist -c agent -- node -e "
fetch('$MCP_OPS_URL', { method: 'POST', headers: { authorization: 'Bearer $SUBJECT_TOKEN', 'content-type': 'application/json' }, body: '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}' })
  .then(async r => process.stdout.write(String(r.status)+':'+(await r.text()).slice(0,160)))
  .catch(e => process.stdout.write('ERR:'+e.message));
" 2>/dev/null || true)
# aud=agent-copilot ≠ mcp-ops, so the waypoint's audience `when` clause denies it
# (403 RBAC) before the app's act-chain middleware ever sees it. An expired token
# would 401 at the RequestAuthentication — both are valid "denied" outcomes.
case "$STATUS" in
  403*|401*) green "  OK (denied before the app: $STATUS)" ;;
  *) red "  expected 403 (waypoint audience denial) or 401, got: $STATUS"; exit 1 ;;
esac

# ----- Negative 2: depth-1 specialist-aud token to mcp-ops → waypoint 403 --
note "[D2] Negative: depth-1 specialist-aud token to mcp-ops → expect waypoint 403 (wrong audience)"
STATUS=$(kubectl -n agents exec deploy/agent-specialist -c agent -- node -e "
fetch('$MCP_OPS_URL', { method: 'POST', headers: { authorization: 'Bearer $SPECIALIST_BEARER', 'content-type': 'application/json' }, body: '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}' })
  .then(async r => process.stdout.write(String(r.status)+':'+(await r.text()).slice(0,200)))
  .catch(e => process.stdout.write('ERR:'+e.message));
" 2>/dev/null || true)
# aud=agent-specialist ≠ mcp-ops → same waypoint audience denial. (The app-level
# act_chain_length check this used to probe is now shadowed by the waypoint.)
case "$STATUS" in
  403*|401*) green "  OK (denied before the app: $STATUS)" ;;
  *) red "  expected 403 (waypoint audience denial) or 401, got: $STATUS"; exit 1 ;;
esac

# ----- Negative 3: chain in wrong order → act_chain_order ----------------
note "[D3] Negative: forge a chain with copilot as the outer actor → expect act_chain_order"
# Reuse copilot's depth-1 trick: exchange user→mcp-ops directly using
# copilot as client + copilot SVID. Curity will fail this (mcp-ops isn't
# on copilot's allowed audiences) so we synthesize the negative by asking
# *specialist* to exchange a NEW user→mcp-ops chain where it presents itself
# as actor TWICE. That's also blocked by Curity policy. Both produce a
# "wrong actor at outer position" signal that mcp-ops's middleware turns
# into act_chain_order — but the Curity-side block happens FIRST.
# So this assertion verifies the broader invariant: a forged-wrong-order
# attempt cannot mint a token at all.
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
  invalid_request|invalid_audience|access_denied)
    green "  OK (Curity refused outright: error=$ERR description='$DESC')" ;;
  invalid_scope)
    green "  OK (Curity refused via scope path: error=$ERR description='$DESC')" ;;
  *)
    red "  expected Curity to deny copilot exchanging directly to mcp-ops, got: $(echo "$RESP" | redact)"
    exit 1 ;;
esac

echo
green "ALL A2A SMOKE CHECKS PASSED"
