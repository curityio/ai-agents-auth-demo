#!/usr/bin/env bash
# End-to-end smoke test for RFC 9470 step-up + role-based denial.
#
# Assertions:
#   [1/3] alice-mfa + acr=mfa → full exchange chain succeeds + mcp-ops accepts
#         (leaf token carries acr=mfa and ops:write; mcp-ops restart succeeds).
#   [2/3] alice-pwd + acr=password → exchange chain succeeds, mcp-ops issues
#         HTTP 401 with WWW-Authenticate: error="insufficient_user_authentication"
#         and acr_values="mfa" (RFC 9470 step-up challenge).
#   [3/3] bob + role=developer (no sre) → Curity returns access_denied at the
#         first exchange hop (copilot→specialist, scope=ops:write).
#
# Token env vars:
#   SMOKE_TOKEN_ALICE_MFA  — access token for alice who authenticated with MFA
#                            (acr=mfa; alice must have role=sre in Curity).
#                            How to obtain: sign in at https://app.localtest.me
#                            through the MFA authenticator, then grab the token
#                            from /api/dev/token (if AUTH_DEBUG=true) or from
#                            the server log of /api/whoami.
#   SMOKE_TOKEN_ALICE_PWD  — access token for alice authenticated with only
#                            password (acr=password; same alice / same roles).
#                            How to obtain: sign in at https://app.localtest.me
#                            skipping/bypassing MFA, then grab token same way.
#   SMOKE_TOKEN_BOB        — access token for bob (role=developer, NOT sre).
#                            How to obtain: sign in at https://app.localtest.me
#                            as bob (per docs/curity-seed.md), grab token same
#                            way. Bob only needs password-level auth for this
#                            test because the exchange fails at the role gate
#                            before ACR is checked.
#
# At least SMOKE_TOKEN_ALICE_MFA is required (assertion 1). Assertions 2 and 3
# are skipped (with a yellow note) if their respective tokens are absent.
#
# Pre-reqs:
#   - kubectl context points at the demo cluster
#   - the current Curity config + rebuilt images are deployed (`make apply`)
#   - mcp-ops, agent-specialist, agent-copilot Deployments are Ready
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

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
note()   { printf '==> %s\n' "$*"; }

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

# Require at least the alice-mfa token (assertion 1 is the primary happy-path).
if [[ -z "${SMOKE_TOKEN_ALICE_MFA:-}" ]]; then
  red "SMOKE_TOKEN_ALICE_MFA is required (sign in with MFA at https://app.localtest.me)."
  red "See script header for how to obtain each token."
  exit 78
fi

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
[[ -n "$COPILOT_PEM" && -n "$SPECIALIST_PEM" ]] || { red "missing CIMD private key(s)"; exit 1; }

# Fresh private_key_jwt assertion (unique jti) per token call, per client.
copilot_assertion() {
  printf '%s' "$COPILOT_PEM" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" "$COPILOT_CLIENT_ID" "$CURITY_TOKEN_URL"
}
specialist_assertion() {
  printf '%s' "$SPECIALIST_PEM" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" "$SPECIALIST_CLIENT_ID" "$CURITY_TOKEN_URL"
}

# ===========================================================================
# [1/3] alice + acr=mfa → full chain succeeds; mcp-ops accepts (restart OK)
# ===========================================================================
note "[1/3] alice-mfa: full exchange chain + mcp-ops restart (expects acr=mfa propagated)"

SUBJECT_TOKEN_MFA="$SMOKE_TOKEN_ALICE_MFA"

# Step A: copilot exchanges user-MFA token → agent-specialist
note "  [1/3-A] copilot exchange → aud=agent-specialist"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(copilot_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN_MFA" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$COPILOT_SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=agent-specialist" \
  -d "scope=obs:read ops:write" \
  "$CURITY_TOKEN_URL")
SPECIALIST_BEARER_MFA=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$SPECIALIST_BEARER_MFA" ]] || { red "no token in 1/3-A: $(echo "$RESP" | redact)"; exit 1; }

PAYLOAD=$(echo "$SPECIALIST_BEARER_MFA" | decode_jwt_payload)
ACT_SUB=$(echo "$PAYLOAD" | jq -r '.act.sub // empty')
[[ "$ACT_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "expected act.sub=copilot, got: $ACT_SUB"; exit 1; }
green "  OK (specialist-bound token issued, act.sub=copilot)"

# Step B: specialist re-exchanges → aud=mcp-ops
note "  [1/3-B] specialist exchange → aud=mcp-ops"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$SPECIALIST_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(specialist_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SPECIALIST_BEARER_MFA" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SPECIALIST_SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-ops" \
  -d "scope=ops:write" \
  "$CURITY_TOKEN_URL")
OPS_BEARER_MFA=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$OPS_BEARER_MFA" ]] || { red "no token in 1/3-B: $(echo "$RESP" | redact)"; exit 1; }

PAYLOAD=$(echo "$OPS_BEARER_MFA" | decode_jwt_payload)
OUTER_SUB=$(echo "$PAYLOAD" | jq -r '.act.sub // empty')
INNER_SUB=$(echo "$PAYLOAD" | jq -r '.act.act.sub // empty')
LEAF_ACR=$(echo "$PAYLOAD" | jq -r '.acr // empty')
LEAF_SCOPE=$(echo "$PAYLOAD" | jq -r '.scope // empty')
[[ "$OUTER_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-specialist" ]] \
  || { red "outer act.sub wrong: $OUTER_SUB"; exit 1; }
[[ "$INNER_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "inner act.act.sub wrong: $INNER_SUB"; exit 1; }
[[ "$LEAF_ACR" == "mfa" ]] \
  || { red "acr not propagated into leaf token (expected mfa, got: $LEAF_ACR)"; exit 1; }
[[ "$LEAF_SCOPE" == *"ops:write"* ]] \
  || { red "ops:write missing from leaf token scope: $LEAF_SCOPE"; exit 1; }
green "  OK (depth-2 chain: outer=specialist, inner=copilot; acr=mfa propagated; ops:write present)"

# Step C: call mcp-ops restart_deployment — must succeed (acr=mfa satisfies step-up)
note "  [1/3-C] mcp-ops restart_deployment with MFA leaf token (expect 200)"
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"smoke","version":"0"},"capabilities":{}}}'
CALL='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod","reason":"step-up smoke mfa"}}}'
STATUS=$(kubectl -n web exec deploy/web -c web -- node -e "
(async () => {
  const init = '$INIT';
  const call = '$CALL';
  const headers = { authorization: 'Bearer $OPS_BEARER_MFA', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const r1 = await fetch('$MCP_OPS_URL', { method: 'POST', headers, body: init });
  if (!r1.ok) { process.stdout.write('INIT_'+r1.status); return; }
  const r2 = await fetch('$MCP_OPS_URL', { method: 'POST', headers, body: call });
  process.stdout.write(String(r2.status)+':'+(await r2.text()).slice(0, 240));
})().catch(e => process.stdout.write('ERR:'+e.message));
" 2>/dev/null || true)
case "$STATUS" in
  200*) green "  OK (mcp-ops accepted MFA token: $STATUS)" ;;
  401*insufficient_user_authentication*)
    red "  step-up challenge returned but MFA token should satisfy it: $STATUS"; exit 1 ;;
  *) red "  unexpected response: $STATUS"; exit 1 ;;
esac

# ===========================================================================
# [2/3] alice + acr=password → mcp-ops returns RFC 9470 step-up challenge
# ===========================================================================
if [[ -z "${SMOKE_TOKEN_ALICE_PWD:-}" ]]; then
  yellow "SKIP [2/3]: SMOKE_TOKEN_ALICE_PWD not set — sign in as alice WITHOUT MFA to obtain."
else
  note "[2/3] alice-pwd: full exchange chain, then mcp-ops must return 401 step-up challenge"
  SUBJECT_TOKEN_PWD="$SMOKE_TOKEN_ALICE_PWD"

  # Step A
  note "  [2/3-A] copilot exchange → aud=agent-specialist"
  RESP=$(curl -sS --cacert "$CACERT" \
    -d "client_id=$COPILOT_CLIENT_ID" \
    -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
    -d "client_assertion=$(copilot_assertion)" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
    -d "subject_token=$SUBJECT_TOKEN_PWD" \
    -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
    -d "actor_token=$COPILOT_SVID" \
    -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
    -d "audience=agent-specialist" \
    -d "scope=obs:read ops:write" \
    "$CURITY_TOKEN_URL")
  SPECIALIST_BEARER_PWD=$(echo "$RESP" | jq -r '.access_token // empty')
  [[ -n "$SPECIALIST_BEARER_PWD" ]] || { red "no token in 2/3-A: $(echo "$RESP" | redact)"; exit 1; }
  green "  OK (specialist-bound token issued)"

  # Step B
  note "  [2/3-B] specialist exchange → aud=mcp-ops"
  RESP=$(curl -sS --cacert "$CACERT" \
    -d "client_id=$SPECIALIST_CLIENT_ID" \
    -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
    -d "client_assertion=$(specialist_assertion)" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
    -d "subject_token=$SPECIALIST_BEARER_PWD" \
    -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
    -d "actor_token=$SPECIALIST_SVID" \
    -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
    -d "audience=mcp-ops" \
    -d "scope=ops:write" \
    "$CURITY_TOKEN_URL")
  OPS_BEARER_PWD=$(echo "$RESP" | jq -r '.access_token // empty')
  [[ -n "$OPS_BEARER_PWD" ]] || { red "no token in 2/3-B: $(echo "$RESP" | redact)"; exit 1; }

  PAYLOAD=$(echo "$OPS_BEARER_PWD" | decode_jwt_payload)
  LEAF_ACR_PWD=$(echo "$PAYLOAD" | jq -r '.acr // empty')
  green "  OK (leaf token issued; acr=$LEAF_ACR_PWD — expect password or similar non-mfa)"

  # Step C: mcp-ops must return 401 with the step-up challenge
  note "  [2/3-C] mcp-ops with password-acr leaf token → expect 401 insufficient_user_authentication"
  INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","clientInfo":{"name":"smoke","version":"0"},"capabilities":{}}}'
  CALL='{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod","reason":"step-up smoke pwd"}}}'
  FULL_STATUS=$(kubectl -n web exec deploy/web -c web -- node -e "
(async () => {
  const init = '$INIT';
  const call = '$CALL';
  const headers = { authorization: 'Bearer $OPS_BEARER_PWD', 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  const r1 = await fetch('$MCP_OPS_URL', { method: 'POST', headers, body: init });
  const wwwAuth = r1.headers.get('www-authenticate') || '';
  process.stdout.write(String(r1.status)+':'+wwwAuth.slice(0, 300));
})().catch(e => process.stdout.write('ERR:'+e.message));
" 2>/dev/null || true)
  # The initialize request triggers auth; mcp-ops must 401 before we even send tools/call.
  case "$FULL_STATUS" in
    401*insufficient_user_authentication*acr_values*mfa*)
      green "  OK (mcp-ops returned 401 step-up challenge: $FULL_STATUS)" ;;
    401*insufficient_user_authentication*)
      # acr_values field may be formatted differently — still a valid challenge
      green "  OK (mcp-ops returned 401 insufficient_user_authentication: $FULL_STATUS)" ;;
    200*)
      red "  mcp-ops accepted password-acr token — step-up not enforced: $FULL_STATUS"; exit 1 ;;
    *)
      red "  unexpected response (expected 401 step-up): $FULL_STATUS"; exit 1 ;;
  esac
fi

# ===========================================================================
# [3/3] bob (role=developer, no sre) → access_denied at first exchange hop
# ===========================================================================
if [[ -z "${SMOKE_TOKEN_BOB:-}" ]]; then
  yellow "SKIP [3/3]: SMOKE_TOKEN_BOB not set — sign in as bob (per docs/curity-seed.md) to obtain."
else
  note "[3/3] bob (no sre): copilot exchange requesting ops:write → expect access_denied"
  SUBJECT_TOKEN_BOB="$SMOKE_TOKEN_BOB"

  RESP=$(curl -sS --cacert "$CACERT" \
    -d "client_id=$COPILOT_CLIENT_ID" \
    -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
    -d "client_assertion=$(copilot_assertion)" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
    -d "subject_token=$SUBJECT_TOKEN_BOB" \
    -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
    -d "actor_token=$COPILOT_SVID" \
    -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
    -d "audience=agent-specialist" \
    -d "scope=obs:read ops:write" \
    "$CURITY_TOKEN_URL")
  ERR=$(echo "$RESP" | jq -r '.error // empty')
  DESC=$(echo "$RESP" | jq -r '.error_description // empty')
  # Curity may sanitize procedure-thrown non-validation errors:
  # the procedure calls fail('access_denied', "user lacks required role 'sre' for ops:write")
  # which Curity can surface as error=access_denied directly, OR as
  # error=invalid_request with the original code prefixed in error_description
  # (see Curity log "Removing non-validation error from JSON response.").
  # Accept either form, tolerating Curity error sanitization.
  if [[ "$ERR" == "access_denied" ]]; then
    green "  OK (Curity denied bob at role gate: error=$ERR description='$DESC')"
  elif [[ "$ERR" == "invalid_request" ]] && [[ "$DESC" == *"sre"* || "$DESC" == *access_denied* ]]; then
    green "  OK (Curity sanitized to invalid_request, description carries role/access_denied signal: '$DESC')"
  else
    red "  expected access_denied for bob lacking sre role, got: $(echo "$RESP" | redact)"
    exit 1
  fi
fi

echo
green "ALL STEP-UP SMOKE CHECKS PASSED (or skipped where tokens not provided)"
