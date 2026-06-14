#!/usr/bin/env bash
# End-to-end smoke test for the OBO token exchange. Runs against the live KIND cluster.
#
# Assertions:
#   - positive: Alice's subject token + agent's SVID exchange yields an
#     access token whose act.sub matches the agent's SPIFFE ID, with aud=
#     mcp-observability and scope=obs:read.
#   - negative 1: omitting actor_token → invalid_request from Curity.
#   - negative 2: requesting scope=ops:write → invalid_scope (the
#     agent-copilot client's claims policy denies it, regardless of user).
#
# Per-hop act.sub enforcement (only the agent SPIFFE-ID pattern is accepted)
# lives in the MCP server middleware (apps/mcp-observability/src/auth-middleware.ts)
# and is exercised by its unit tests and the A2A/step-up smoke scripts.
#
# Pre-reqs:
#   - kubectl context points at the demo cluster
#   - `alice` exists in Curity (per docs/curity-seed.md)
#   - agent-copilot is a CIMD ephemeral client; this script authenticates with a
#     private_key_jwt assertion signed by the PKCS8 key in the agent-copilot-curity
#     Secret (seeded via `make seed-agent-key`), exactly as the agent does.
#
# Required env: SMOKE_SUBJECT_TOKEN — a fresh Curity access token for Alice.
# Easiest way to obtain: open https://app.localtest.me, sign in, hit
# https://app.localtest.me/api/whoami; the response logs the token when
# AUTH_DEBUG=true is set on the web pod.
#
# Exit codes: 0 on success, non-zero on any failed assertion.

set -euo pipefail

CURITY_TOKEN_URL="${CURITY_TOKEN_URL:-https://curity.localtest.me/oauth/v2/oauth-token}"
CACERT="$(mkcert -CAROOT)/rootCA.pem"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COPILOT_CLIENT_ID="${COPILOT_CLIENT_ID:-https://copilot.localtest.me/.well-known/oauth-client}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note() { printf '==> %s\n' "$*"; }

# Helpers for redacting sensitive fields from response bodies before logging.
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

# ----- Positive case ------------------------------------------------------
note "[1/3] Positive: exchange Alice subject + agent SVID"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-observability" \
  -d "scope=obs:read" \
  "$CURITY_TOKEN_URL")
ACCESS=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$ACCESS" ]] || { red "no access_token in positive response: $(echo "$RESP" | redact_resp)"; exit 1; }
# Decode the payload (base64url + JSON). Use python3 for portable base64url.
ACT_SUB=$(echo "$ACCESS" | cut -d. -f2 | python3 -c '
import sys, base64, json
s = sys.stdin.read().strip()
s += "=" * (-len(s) % 4)
print(json.loads(base64.urlsafe_b64decode(s)).get("act", {}).get("sub", ""))')
AUD=$(echo "$ACCESS" | cut -d. -f2 | python3 -c '
import sys, base64, json
s = sys.stdin.read().strip()
s += "=" * (-len(s) % 4)
aud = json.loads(base64.urlsafe_b64decode(s)).get("aud", "")
print(aud if isinstance(aud, str) else " ".join(aud))')
SCOPE=$(echo "$ACCESS" | cut -d. -f2 | python3 -c '
import sys, base64, json
s = sys.stdin.read().strip()
s += "=" * (-len(s) % 4)
print(json.loads(base64.urlsafe_b64decode(s)).get("scope", ""))')

[[ "$ACT_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "act.sub mismatch: $ACT_SUB"; exit 1; }
[[ "$AUD" == *"mcp-observability"* ]] \
  || { red "aud mismatch: $AUD"; exit 1; }
[[ "$SCOPE" == *"obs:read"* ]] \
  || { red "scope mismatch: $SCOPE"; exit 1; }
green "  OK (act.sub=$ACT_SUB, aud=$AUD, scope=$SCOPE)"

# ----- Negative 1: missing actor_token -----------------------------------
note "[2/3] Negative: omit actor_token → expect invalid_request"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "audience=mcp-observability" \
  -d "scope=obs:read" \
  "$CURITY_TOKEN_URL")
ERR=$(echo "$RESP" | jq -r '.error // empty')
[[ "$ERR" == "invalid_request" ]] \
  || { red "expected invalid_request, got: $(echo "$RESP" | redact_resp)"; exit 1; }
green "  OK (error=$ERR)"

# ----- Negative 2: request a disallowed scope ----------------------------
note "[3/3] Negative: request scope=ops:write → expect invalid_scope"
RESP=$(curl -sS --cacert "$CACERT" \
  -d "client_id=$COPILOT_CLIENT_ID" \
  -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
  -d "client_assertion=$(client_assertion)" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
  -d "subject_token=$SUBJECT_TOKEN" \
  -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
  -d "actor_token=$SVID" \
  -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
  -d "audience=mcp-observability" \
  -d "scope=ops:write" \
  "$CURITY_TOKEN_URL")
ERR=$(echo "$RESP" | jq -r '.error // empty')
DESC=$(echo "$RESP" | jq -r '.error_description // empty')
# Curity sanitizes procedure-thrown OAuth codes to `invalid_request` and
# prepends the original code into `error_description` (see Curity log
# "Removing non-validation error from JSON response. Enable the exposing
# of detailed error messages in the profile..."). RFC 6749 would prefer
# `error: "invalid_scope"`, but the on-the-wire behavior is fixed.
# Accept either: the strict form (error=invalid_scope) OR the prefixed-
# description form (error=invalid_request, description starts with
# "invalid_scope ").
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
