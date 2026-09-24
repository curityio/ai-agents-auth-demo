#!/usr/bin/env bash
# Mint a ready-to-paste Bearer token for MCP Inspector, aimed at the agentgateway.
#
# This performs the SAME RFC 8693 token-exchange chain the agents perform at
# runtime (CIMD private_key_jwt client auth + SPIFFE JWT-SVID actor_token),
# so the resulting token passes the gateway's full enforcement: issuer, audience
# and per-tier scope.
#
# IMPORTANT — the token is `aud=mcp-gateway`, NOT aud=mcp-observability/mcp-ops,
# and Inspector must therefore point at the GATEWAY, not at an MCP server:
#   obs -> http://localhost:<port>/observability/mcp
#   ops -> http://localhost:<port>/ops/mcp
# `make inspect-obs` / `make inspect-ops` port-forward svc/agentgateway and print
# the right URL. Minting aud=mcp-observability / aud=mcp-ops directly is IMPOSSIBLE
# for these clients — Curity refuses it ("audience ... not allowed for client ..."),
# which smoke-token-exchange [3/5] and smoke-a2a [D3] assert on purpose. Only the
# gateway's own exchange-shim may mint those, using the gateway's SPIFFE SVID.
#
# Talking to an MCP server directly is not possible by design either: mcp-ops
# requires the exact act-chain [agentgateway, agent-specialist, agent-copilot], so
# a token that skipped the gateway is rejected on chain length regardless of scope.
#
# It only PRINTS the token (to stdout) — the actual MCP call happens in
# Inspector. Diagnostic notes go to stderr so `TOKEN=$(... obs)` is clean.
#
# Usage:
#   export SMOKE_SUBJECT_TOKEN='eyJ...'        # a fresh Curity access token for Alice
#   scripts/mint-mcp-token.sh obs              # -> aud=mcp-gateway, scope=obs:read
#   scripts/mint-mcp-token.sh ops              # -> aud=mcp-gateway, scope=ops:write
#
# Getting SMOKE_SUBJECT_TOKEN:
#   1. Open https://app.localtest.me and sign in as Alice.
#      - For `ops` you MUST complete the MFA step-up (the token needs acr=mfa,
#        and Alice must have role=sre). For `obs`, any login works.
#   2. With AUTH_DEBUG=true on the web pod, the access token is logged by
#      /api/whoami. Copy it.
#   3. export SMOKE_SUBJECT_TOKEN='eyJ...'
#
# Pre-reqs: kubectl context on the demo cluster; the agent Deployments Ready;
#           mkcert root CA present (for TLS to curity.localtest.me).

set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  obs|ops) ;;
  *)
    printf 'usage: %s <obs|ops>\n' "$(basename "$0")" >&2
    exit 2
    ;;
esac

CURITY_TOKEN_URL="${CURITY_TOKEN_URL:-https://curity.localtest.me/oauth/v2/oauth-token}"
CACERT="$(mkcert -CAROOT)/rootCA.pem"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COPILOT_CLIENT_ID="${COPILOT_CLIENT_ID:-https://copilot.localtest.me/.well-known/oauth-client}"
SPECIALIST_CLIENT_ID="${SPECIALIST_CLIENT_ID:-https://specialist.localtest.me/.well-known/oauth-client}"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*" >&2; }
note()  { printf '==> %s\n' "$*" >&2; }

if [[ -z "${SMOKE_SUBJECT_TOKEN:-}" ]]; then
  red "SMOKE_SUBJECT_TOKEN is required (a fresh Curity access token for Alice)."
  red "See the header of this script for how to grab one from /api/whoami."
  exit 78  # EX_CONFIG
fi
SUBJECT_TOKEN="$SMOKE_SUBJECT_TOKEN"

# Decode a JWT payload to compact JSON (base64url, portable via python3).
decode_jwt_payload() {
  python3 -c '
import sys, base64, json
parts = sys.stdin.read().strip().split(".")
if len(parts) < 2:
    print("{}"); sys.exit(0)
s = parts[1]; s += "=" * (-len(s) % 4)
print(json.dumps(json.loads(base64.urlsafe_b64decode(s))))
'
}

redact() {
  python3 -c '
import sys, json
try: body = json.loads(sys.stdin.read())
except Exception: print("<unparseable>"); sys.exit(0)
for k in ("access_token","id_token","refresh_token"):
    if k in body: body[k] = "<redacted>"
print(json.dumps(body))
'
}

# Read a CIMD private key (PKCS8 PEM) from an in-cluster Secret.
read_pem() { # $1 = secret name in ns/agents
  kubectl -n agents get secret "$1" -o jsonpath='{.data.CURITY_AGENT_PRIVATE_KEY_PEM}' \
    | python3 -c 'import sys,base64;print(base64.b64decode(sys.stdin.read()).decode(),end="")'
}

# Read a live SVID from an agent pod.
read_svid() { # $1 = deployment name in ns/agents
  kubectl -n agents exec "deploy/$1" -c agent -- cat /run/spiffe/curity-actor.jwt | tr -d '\n'
}

# One RFC 8693 exchange. Echoes the access_token to stdout (caller captures).
# Args: client_id client_pem actor_svid subject_token audience scope
exchange() {
  local client_id="$1" client_pem="$2" actor_svid="$3" subject="$4" audience="$5" scope="$6"
  local assertion resp token
  assertion=$(printf '%s' "$client_pem" | node "$SCRIPT_DIR/cimd-sign-assertion.mjs" "$client_id" "$CURITY_TOKEN_URL")
  resp=$(curl -sS --cacert "$CACERT" \
    -d "client_id=$client_id" \
    -d "client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer" \
    -d "client_assertion=$assertion" \
    -d "grant_type=urn:ietf:params:oauth:grant-type:token-exchange" \
    -d "subject_token=$subject" \
    -d "subject_token_type=urn:ietf:params:oauth:token-type:access_token" \
    -d "actor_token=$actor_svid" \
    -d "actor_token_type=urn:ietf:params:oauth:token-type:jwt" \
    -d "audience=$audience" \
    -d "scope=$scope" \
    "$CURITY_TOKEN_URL")
  token=$(echo "$resp" | jq -r '.access_token // empty')
  if [[ -z "$token" ]]; then
    red "exchange to aud=$audience failed: $(echo "$resp" | redact)"
    return 1
  fi
  printf '%s' "$token"
}

if [[ "$TARGET" == "obs" ]]; then
  note "Minting aud=mcp-gateway token for the READ tier (user -> agent-copilot -> gateway)"
  COPILOT_PEM=$(read_pem agent-copilot-curity)
  COPILOT_SVID=$(read_svid agent-copilot)
  [[ -n "$COPILOT_PEM" && -n "$COPILOT_SVID" ]] || { red "missing copilot key/SVID"; exit 1; }

  TOKEN=$(exchange "$COPILOT_CLIENT_ID" "$COPILOT_PEM" "$COPILOT_SVID" \
    "$SUBJECT_TOKEN" "mcp-gateway" "obs:read")

  P=$(echo "$TOKEN" | decode_jwt_payload)
  green "  OK  aud=$(echo "$P" | jq -r '.aud') scope=$(echo "$P" | jq -r '.scope') act.sub=$(echo "$P" | jq -r '.act.sub') may_act=$(echo "$P" | jq -r '.may_act.sub // "<none>"')"
else
  note "Minting aud=mcp-gateway token for the WRITE tier (user -> specialist -> gateway); needs acr=mfa"
  SUB_ACR=$(echo "$SUBJECT_TOKEN" | decode_jwt_payload | jq -r '.acr // "<none>"')
  if [[ "$SUB_ACR" != "mfa" ]]; then
    red "subject token acr=$SUB_ACR (need 'mfa'). mcp-ops enforces RFC 9470 step-up;"
    red "sign in to https://app.localtest.me completing the MFA step before grabbing the token."
    exit 1
  fi
  COPILOT_PEM=$(read_pem agent-copilot-curity)
  COPILOT_SVID=$(read_svid agent-copilot)
  SPECIALIST_PEM=$(read_pem agent-specialist-curity)
  SPECIALIST_SVID=$(read_svid agent-specialist)
  [[ -n "$COPILOT_PEM" && -n "$COPILOT_SVID" && -n "$SPECIALIST_PEM" && -n "$SPECIALIST_SVID" ]] \
    || { red "missing copilot/specialist key or SVID"; exit 1; }

  note "[A] user -> agent-specialist (copilot client + copilot SVID)"
  SPECIALIST_BEARER=$(exchange "$COPILOT_CLIENT_ID" "$COPILOT_PEM" "$COPILOT_SVID" \
    "$SUBJECT_TOKEN" "agent-specialist" "obs:read ops:write")
  green "  OK  act.sub=$(echo "$SPECIALIST_BEARER" | decode_jwt_payload | jq -r '.act.sub')"

  note "[B] agent-specialist -> mcp-gateway (specialist client + specialist SVID)"
  TOKEN=$(exchange "$SPECIALIST_CLIENT_ID" "$SPECIALIST_PEM" "$SPECIALIST_SVID" \
    "$SPECIALIST_BEARER" "mcp-gateway" "ops:write")

  P=$(echo "$TOKEN" | decode_jwt_payload)
  green "  OK  aud=$(echo "$P" | jq -r '.aud') scope=$(echo "$P" | jq -r '.scope') acr=$(echo "$P" | jq -r '.acr') act.sub=$(echo "$P" | jq -r '.act.sub') act.act.sub=$(echo "$P" | jq -r '.act.act.sub') may_act=$(echo "$P" | jq -r '.may_act.sub // "<none>"')"
fi

# The token, and ONLY the token, on stdout.
printf '%s\n' "$TOKEN"
