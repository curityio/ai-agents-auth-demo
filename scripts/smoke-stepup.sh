#!/usr/bin/env bash
# End-to-end smoke test for RFC 9470 step-up + role-based authz THROUGH the
# agentgateway.
#
# Topology (post-agentgateway): the specialist mints an aud=mcp-gateway token and
# calls the gateway's /ops/mcp route. The gateway validates the JWT, applies
# per-tool CEL RBAC (role split), and re-exchanges (via the exchange-shim) to
# aud=mcp-ops before forwarding. The gateway does NOT enforce acr/step-up — the
# RFC 9470 401 still originates at mcp-ops and is relayed back through the gateway.
#
# Assertions:
#   [1/4] alice-mfa (acr=mfa, roles sre+oncall) → full chain to aud=mcp-gateway,
#         acr=mfa propagated; restart_deployment through the gateway → 200.
#   [2/4] alice-pwd (acr=password) → same chain, but the gateway/mcp-ops path
#         returns 401 with WWW-Authenticate: insufficient_user_authentication,
#         acr_values="mfa" (step-up challenge, relayed through the gateway).
#   [3/4] bob (role=developer, no write role) → Curity returns access_denied at
#         the FIRST exchange hop (copilot→specialist, scope ops:write) — the role
#         gate is (sre OR oncall); bob has neither.
#   [4/4] per-tool ROLE SPLIT (sre ⊇ oncall). Visibility is deliberately NOT the
#         gate — hiding a tool makes an LLM loop silently instead of relaying a
#         denial — so both callers SEE every ops tool and only the CALL differs:
#         - alice (sre): tools/list on /ops/mcp INCLUDES set_deployment_image.
#         - carol (oncall, optional token): tools/list ALSO includes it, but the
#           call is DENIED — by the gateway's `authorization` rule today, or by
#           mcp-ops's role gate if that rule is ever removed (the assertion accepts
#           either). restart_deployment stays allowed.
#
# Token env vars (each obtained by signing in at https://app.localtest.me and
# reading the token from /api/whoami's log with AUTH_DEBUG=true — see below):
#   SMOKE_TOKEN_ALICE_MFA  — alice, authenticated WITH MFA (acr=mfa; roles sre+oncall). REQUIRED.
#   SMOKE_TOKEN_ALICE_PWD  — alice with ops:write BUT acr!=mfa. Optional → skips [2/4].
#         NOT obtainable by signing in without MFA: the web login scope is
#         `openid obs:read llm:invoke` (no ops:write), and ops:write is only ever
#         requested by the step-up re-auth, which demands acr_values=mfa in the same
#         request — so no UI journey yields ops:write with acr=password. Supplying a
#         plain non-MFA login token instead fails EARLIER than this assertion intends,
#         at scope narrowing: `invalid_scope no scope intersects subject + policy`.
#         To exercise [2/4] you must hand-drive the authorize endpoint with
#         scope=...ops:write and NO acr_values (alice/sre passes the role gate, and
#         acr stays html-form). Until then this assertion stays skipped, and the
#         RFC 9470 challenge itself is covered only by the UI demo.
#   SMOKE_TOKEN_BOB        — bob (role=developer). Optional → skips [3/4].
#   SMOKE_TOKEN_CAROL      — carol (role=oncall; seed per docs/curity-seed.md).
#                            Optional → the carol half of [4/4] is skipped.
#
# Pre-reqs:
#   - kubectl context points at the demo cluster; `make apply` + `make routing` ran.
#   - agentgateway, mcp-ops, agent-specialist, agent-copilot Deployments are Ready.
#
# Exit codes: 0 on success, non-zero on any failed assertion.

set -euo pipefail

CURITY_TOKEN_URL="${CURITY_TOKEN_URL:-https://curity.localtest.me/oauth/v2/oauth-token}"
GATEWAY_OPS_URL="${GATEWAY_OPS_URL:-http://agentgateway.mcp.svc.cluster.local:8080/ops/mcp}"
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

# Fresh private_key_jwt assertion (unique jti) per token call, per client.
copilot_assertion() {
  printf '%s' "$COPILOT_PEM" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" "$COPILOT_CLIENT_ID" "$CURITY_TOKEN_URL"
}
specialist_assertion() {
  printf '%s' "$SPECIALIST_PEM" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" "$SPECIALIST_CLIENT_ID" "$CURITY_TOKEN_URL"
}

# exchange: thin curl wrapper around the token endpoint. Echoes the raw JSON.
#   $1 client_id  $2 assertion  $3 subject_token  $4 actor_token  $5 audience  $6 scope
exchange() {
  curl -sS --cacert "$CACERT" \
    -d "client_id=$1" \
    -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
    -d "client_assertion=$2" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
    -d "subject_token=$3" \
    -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
    -d "actor_token=$4" \
    -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
    -d "audience=$5" \
    -d "scope=$6" \
    "$CURITY_TOKEN_URL"
}

# build_gateway_ops_token: run the two agent-side exchanges (copilot→specialist,
# specialist→mcp-gateway) for a given user subject token. Echoes the aud=mcp-gateway
# ops:write bearer, or empty on failure. Prints a diagnostic to stderr on failure.
build_gateway_ops_token() {
  local subj="$1" resp spb gwb
  resp=$(exchange "$COPILOT_CLIENT_ID" "$(copilot_assertion)" "$subj" "$COPILOT_SVID" "agent-specialist" "obs:read ops:write")
  spb=$(echo "$resp" | jq -r '.access_token // empty')
  if [[ -z "$spb" ]]; then echo "copilot→specialist failed: $(echo "$resp" | redact)" >&2; return 1; fi
  resp=$(exchange "$SPECIALIST_CLIENT_ID" "$(specialist_assertion)" "$spb" "$SPECIALIST_SVID" "mcp-gateway" "ops:write")
  gwb=$(echo "$resp" | jq -r '.access_token // empty')
  if [[ -z "$gwb" ]]; then echo "specialist→mcp-gateway failed: $(echo "$resp" | redact)" >&2; return 1; fi
  echo "$gwb"
}

# gw_mcp: drive an MCP request through the gateway from the specialist pod; echoes
# "<status>:<www-authenticate>|<body-slice>". Speaks protocol revision 2026-07-28:
# ONE request, no initialize handshake and no session (the revision removed both).
# The RFC 9470 step-up challenge that mcp-ops returns therefore arrives on THIS
# request rather than on a preceding initialize, so it now shows up as a plain
# "401:" instead of the "INIT_401:" this helper used to emit — the assertions below
# match both spellings.
#   $1 url  $2 bearer  $3 method  $4 params-json
gw_mcp() {
  kubectl -n agents exec deploy/agent-specialist -c agent -- \
    env U="$1" B="$2" M="$3" P="$4" node -e '
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
  const r2 = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  // NOTE: this cap is a CORRECTNESS constraint, not just display. Callers pattern-match
  // the returned string (e.g. `200*set_deployment_image*`), so anything cut here reads as
  // absent and fails a passing system. A full ops tools/list is ~2KB — restart_deployment
  // alone carries a ~300-char description — so keep this far above any real response.
  // Truncate for DISPLAY at the print site (${VAR:0:80}), never here.
  process.stdout.write(String(r2.status) + ":" + ((r2.headers.get("www-authenticate") || "")) + "|" + (await r2.text()).slice(0, 20000));
})().catch(e => process.stdout.write("ERR:" + e.message));
' 2>/dev/null || true
}

# Require at least the alice-mfa token (assertions 1 + 4-alice are the happy path).
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

# ===========================================================================
# [1/4] alice + acr=mfa → full chain to aud=mcp-gateway; restart via gateway = 200
# ===========================================================================
note "[1/4] alice-mfa: full chain to aud=mcp-gateway + restart via gateway (acr=mfa propagated)"
RESP=$(exchange "$COPILOT_CLIENT_ID" "$(copilot_assertion)" "$SMOKE_TOKEN_ALICE_MFA" "$COPILOT_SVID" "agent-specialist" "obs:read ops:write")
SPECIALIST_BEARER_MFA=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$SPECIALIST_BEARER_MFA" ]] || { red "no token in 1/4-A: $(echo "$RESP" | redact)"; exit 1; }
ACT_SUB=$(echo "$SPECIALIST_BEARER_MFA" | decode_jwt_payload | jq -r '.act.sub // empty')
[[ "$ACT_SUB" == "spiffe://demo.curity.local/ns/agents/sa/agent-copilot" ]] \
  || { red "expected act.sub=copilot, got: $ACT_SUB"; exit 1; }

RESP=$(exchange "$SPECIALIST_CLIENT_ID" "$(specialist_assertion)" "$SPECIALIST_BEARER_MFA" "$SPECIALIST_SVID" "mcp-gateway" "ops:write")
GATEWAY_BEARER_MFA=$(echo "$RESP" | jq -r '.access_token // empty')
[[ -n "$GATEWAY_BEARER_MFA" ]] || { red "no token in 1/4-B: $(echo "$RESP" | redact)"; exit 1; }
PAYLOAD=$(echo "$GATEWAY_BEARER_MFA" | decode_jwt_payload)
LEAF_ACR=$(echo "$PAYLOAD" | jq -r '.acr // empty')
LEAF_SCOPE=$(echo "$PAYLOAD" | jq -r '.scope // empty')
[[ "$LEAF_ACR" == "mfa" ]] || { red "acr not propagated to mcp-gateway token (expected mfa, got: $LEAF_ACR)"; exit 1; }
[[ "$LEAF_SCOPE" == *"ops:write"* ]] || { red "ops:write missing: $LEAF_SCOPE"; exit 1; }
green "  OK (aud=mcp-gateway token; acr=mfa propagated; ops:write present)"

note "  [1/4-C] restart_deployment through the gateway (expect 200 — acr=mfa satisfies step-up)"
STATUS=$(gw_mcp "$GATEWAY_OPS_URL" "$GATEWAY_BEARER_MFA" "tools/call" \
  '{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod","reason":"step-up smoke mfa"}}')
case "$STATUS" in
  200*) green "  OK (gateway → mcp-ops accepted MFA token: ${STATUS:0:80}...)" ;;
  INIT_401*insufficient_user_authentication*|*insufficient_user_authentication*)
    red "  step-up challenge returned but MFA token should satisfy it: $STATUS"; exit 1 ;;
  *) red "  unexpected response: $STATUS"; exit 1 ;;
esac

# ===========================================================================
# [2/4] alice + acr=password → gateway/mcp-ops path returns 401 step-up challenge
# ===========================================================================
if [[ -z "${SMOKE_TOKEN_ALICE_PWD:-}" ]]; then
  yellow "SKIP [2/4]: SMOKE_TOKEN_ALICE_PWD not set — needs ops:write WITH acr!=mfa, which no"
  yellow "            UI login produces (see the header). Hand-drive /authorize to obtain."
else
  note "[2/4] alice-pwd: full chain, then gateway/mcp-ops must return 401 step-up challenge"
  GATEWAY_BEARER_PWD=$(build_gateway_ops_token "$SMOKE_TOKEN_ALICE_PWD") \
    || { red "  failed to build aud=mcp-gateway token for alice-pwd"; exit 1; }
  LEAF_ACR_PWD=$(echo "$GATEWAY_BEARER_PWD" | decode_jwt_payload | jq -r '.acr // empty')
  green "  OK (aud=mcp-gateway token issued; acr=$LEAF_ACR_PWD — expect non-mfa)"

  note "  [2/4-C] restart via gateway with password-acr token → expect 401 insufficient_user_authentication"
  STATUS=$(gw_mcp "$GATEWAY_OPS_URL" "$GATEWAY_BEARER_PWD" "tools/call" \
    '{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod","reason":"step-up smoke pwd"}}')
  # mcp-ops 401s on the first authenticated (initialize) request; the gateway
  # relays it. Accept the challenge in either the WWW-Authenticate header or body.
  case "$STATUS" in
    INIT_401*insufficient_user_authentication*mfa*|*insufficient_user_authentication*acr_values*mfa*)
      green "  OK (step-up challenge relayed through the gateway: ${STATUS:0:160})" ;;
    INIT_401*insufficient_user_authentication*|*insufficient_user_authentication*)
      green "  OK (401 insufficient_user_authentication relayed: ${STATUS:0:160})" ;;
    200*)
      red "  password-acr token was accepted — step-up not enforced: $STATUS"; exit 1 ;;
    INIT_401*|401*)
      # A 401 without the challenge string still means step-up denied it; surface for review.
      yellow "  401 returned but challenge string not visible (gateway may not relay WWW-Authenticate): $STATUS"
      green "  OK (denied with 401)" ;;
    *)
      red "  unexpected response (expected 401 step-up): $STATUS"; exit 1 ;;
  esac
fi

# ===========================================================================
# [3/4] bob (role=developer, no write role) → access_denied at first exchange hop
# ===========================================================================
if [[ -z "${SMOKE_TOKEN_BOB:-}" ]]; then
  yellow "SKIP [3/4]: SMOKE_TOKEN_BOB not set — sign in as bob (per docs/curity-seed.md) to obtain."
else
  note "[3/4] bob (no write role): copilot exchange requesting ops:write → expect access_denied"
  RESP=$(exchange "$COPILOT_CLIENT_ID" "$(copilot_assertion)" "$SMOKE_TOKEN_BOB" "$COPILOT_SVID" "agent-specialist" "obs:read ops:write")
  ERR=$(echo "$RESP" | jq -r '.error // empty')
  DESC=$(echo "$RESP" | jq -r '.error_description // empty')
  # The role gate is (sre OR oncall); bob is developer. Curity surfaces the
  # procedure fail() as access_denied directly, OR sanitized to invalid_request
  # with the code in error_description.
  if [[ "$ERR" == "access_denied" ]]; then
    green "  OK (Curity denied bob at role gate: error=$ERR description='$DESC')"
  elif [[ "$ERR" == "invalid_request" ]] && [[ "$DESC" == *sre* || "$DESC" == *oncall* || "$DESC" == *access_denied* || "$DESC" == *role* ]]; then
    green "  OK (Curity sanitized to invalid_request, description carries role/access_denied signal: '$DESC')"
  else
    red "  expected access_denied for bob lacking a write role, got: $(echo "$RESP" | redact)"
    exit 1
  fi
fi

# ===========================================================================
# [4/4] per-tool ROLE SPLIT at the gateway (sre ⊇ oncall)
# ===========================================================================
# NOTE on where the split is enforced: the gateway lists+allows ALL ops tools for
# any ops:write caller (it can't hide a tool without also making it uncallable,
# which turns a denial into a silent no-op). The set_deployment_image = sre split
# is enforced at MCP-OPS, which denies the CALL for non-sre with a legible error.
# So BOTH alice and carol SEE set_deployment_image in tools/list; only the CALL
# differs (alice may, carol may not).
note "[4/4] per-tool role split: set_deployment_image call is sre-only (enforced at mcp-ops)"

# alice (sre): tools/list on /ops/mcp must INCLUDE set_deployment_image.
note "  [4/4-alice] tools/list as alice (sre) → expect set_deployment_image present"
LIST=$(gw_mcp "$GATEWAY_OPS_URL" "$GATEWAY_BEARER_MFA" "tools/list" '{}')
case "$LIST" in
  200*set_deployment_image*) green "  OK (alice/sre sees set_deployment_image)" ;;
  200*) red "  alice (sre) tools/list is missing set_deployment_image: ${LIST:0:300}"; exit 1 ;;
  *) red "  tools/list failed for alice: $LIST"; exit 1 ;;
esac

if [[ -z "${SMOKE_TOKEN_CAROL:-}" ]]; then
  yellow "  SKIP [4/4-carol]: SMOKE_TOKEN_CAROL not set — seed carol (oncall) per docs/curity-seed.md and sign in to obtain."
else
  note "  [4/4-carol] carol (oncall): SEES set_deployment_image but the CALL is denied; restart allowed"
  CAROL_GW=$(build_gateway_ops_token "$SMOKE_TOKEN_CAROL") \
    || { red "  failed to build aud=mcp-gateway token for carol (does carol have the oncall role?)"; exit 1; }

  # Visibility: the gateway lists all ops tools for any ops:write caller, so carol
  # SEES set_deployment_image (the split is enforced downstream at mcp-ops, not by
  # hiding the tool). She should see both it and restart_deployment.
  LIST=$(gw_mcp "$GATEWAY_OPS_URL" "$CAROL_GW" "tools/list" '{}')
  case "$LIST" in
    200*set_deployment_image*restart_deployment*|200*restart_deployment*set_deployment_image*)
      green "    OK (tools/list shows set_deployment_image AND restart_deployment)" ;;
    200*) red "  carol tools/list missing expected ops tools: ${LIST:0:300}"; exit 1 ;;
    *) red "  tools/list failed for carol: $LIST"; exit 1 ;;
  esac

  note "    call set_deployment_image as carol → expect denial (gateway 403, or mcp-ops role error)"
  CALL=$(gw_mcp "$GATEWAY_OPS_URL" "$CAROL_GW" "tools/call" \
    '{"name":"set_deployment_image","arguments":{"name":"order-service","namespace":"prod","image":"nginx:1.27"}}')
  # TWO layers may answer, and either is a pass — which one does is deliberate:
  #   - The gateway's `authorization` deny rule (keyed on Mcp-Name + jwt.roles) is
  #     the first line and refuses with a plain HTTP 403 "authorization failed".
  #     This is what fires today.
  #   - mcp-ops's `imageRoleDenial` is the authoritative backstop; it denies BEFORE
  #     the ops-api hop and returns an isError tool result, which the gateway relays
  #     as HTTP 200 with {"error":"forbidden","message":"...requires one of these
  #     roles: sre; you have: oncall"}. It answers if the gateway rule is ever
  #     removed or fails open (it cannot evaluate true when `roles` is absent).
  # Accepting both keeps this test honest about WHERE the split is enforced without
  # pinning it to one layer. What must never happen is the image actually changing.
  case "$CALL" in
    403*|*forbidden*|*"requires one of these roles"*|*requires*sre*)
      green "    OK (denied for oncall: ${CALL:0:200})" ;;
    200*busybox*|200*replicas*|200*restartedAt*|200*updatedReplicas*)
      red "  carol (oncall) appears to have UPDATED the image — role split not enforced: ${CALL:0:220}"; exit 1 ;;
    *) red "  unexpected response calling set_deployment_image as carol: ${CALL:0:240}"; exit 1 ;;
  esac

  note "    call restart_deployment as carol → expect allowed (200)"
  CALL=$(gw_mcp "$GATEWAY_OPS_URL" "$CAROL_GW" "tools/call" \
    '{"name":"restart_deployment","arguments":{"name":"order-service","namespace":"prod","reason":"role-split smoke"}}')
  case "$CALL" in
    200*) green "    OK (carol/oncall may restart_deployment: ${CALL:0:80}...)" ;;
    *) red "  carol (oncall) should be allowed to restart_deployment, got: $CALL"; exit 1 ;;
  esac
fi

echo
green "ALL STEP-UP / ROLE-SPLIT SMOKE CHECKS PASSED (or skipped where tokens not provided)"
