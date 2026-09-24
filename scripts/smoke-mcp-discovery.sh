#!/usr/bin/env bash
# Smoke test for MCP-spec authorization DISCOVERY (2026-07-28 "Authorization
# Server Discovery"), walked from the host exactly as a spec-shaped client would:
#
#   [1/4] agentgateway, both routes: unauthenticated POST → 401 whose
#         WWW-Authenticate names a resource_metadata URL.
#   [2/4] GET that URL → 200; `resource` equals the route URL (RFC 9728 §3.3);
#         `authorization_servers[0]` present; the ops document carries the demo's
#         `acr_values_supported` extension.
#   [3/4] The authorization server: RFC 8414 path-insertion URL → `issuer` echoes,
#         `client_id_metadata_document_supported` is true, `token_endpoint` is https.
#   [4/4] The origin MCP servers: unauthenticated POST → 401 with resource_metadata
#         AND scope; a garbage bearer → 401 error="invalid_token".
#
# No token is needed. Requires: curl, python3 (both already required by the repo).
set -uo pipefail

GATEWAY_HOST="${GATEWAY_HOST:-https://mcp-gateway.localtest.me}"
OBS_HOST="${OBS_HOST:-https://mcp-observability.localtest.me}"
OPS_HOST="${OPS_HOST:-https://mcp-ops.localtest.me}"
CURL="curl -sk -m 10"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
note()   { printf '==> %s\n' "$*"; }
die()    { red "  $*"; exit 1; }

PROBE_BODY='{"jsonrpc":"2.0","id":0,"method":"ping"}'

# probe <url> [bearer] → prints "<status>\n<www-authenticate>"
probe() {
  # bash 3.2 (macOS): expanding an EMPTY array under `set -u` is an unbound-variable
  # error, so guard the expansion with the ${arr[@]+"${arr[@]}"} idiom.
  local auth=()
  [[ -n "${2:-}" ]] && auth=(-H "authorization: Bearer $2")
  $CURL -o /dev/null -D - -X POST -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2026-07-28' \
    ${auth[@]+"${auth[@]}"} -d "$PROBE_BODY" "$1" \
    | awk 'NR==1{split($0,a," "); s=a[2]} tolower($1)=="www-authenticate:"{sub(/^[^:]*: */,""); w=$0} END{print s; print w}'
}
# param <header> <name> → the quoted value of name="…" or empty
param() { printf '%s' "$1" | sed -n "s/.*$2=\"\([^\"]*\)\".*/\1/p"; }
# jget <json> <python-expr over d>
jget() { python3 -c 'import sys,json; d=json.load(sys.stdin); print('"$2"')' <<<"$1" 2>/dev/null; }

for route in observability ops; do
  URL="$GATEWAY_HOST/$route/mcp"
  note "[1/4] $URL unauthenticated → 401 + resource_metadata"
  OUT=$(probe "$URL"); STATUS=${OUT%%$'\n'*}; WWW=${OUT#*$'\n'}
  [[ -n "$STATUS" ]] || die "no HTTP response from $URL (is the host served at the edge — gateway-edge.yaml applied, mcp-gateway-tls secret present?)"
  [[ "$STATUS" == "401" ]] || die "expected 401, got $STATUS"
  PRM_URL=$(param "$WWW" resource_metadata)
  [[ -n "$PRM_URL" ]] || die "no resource_metadata in: $WWW"
  green "  OK  $PRM_URL"

  note "[2/4] GET $PRM_URL"
  PRM=$($CURL -w '\n%{http_code}' "$PRM_URL"); CODE=${PRM##*$'\n'}; PRM=${PRM%$'\n'*}
  [[ "$CODE" == "200" ]] || die "PRM answered $CODE (dangling resource_metadata — is the well-known route matched and the host routed at the edge?)"
  RES=$(jget "$PRM" 'd["resource"]')
  [[ "${RES%/}" == "${URL%/}" ]] || die "PRM resource '$RES' != '$URL' (RFC 9728 §3.3)"
  AS=$(jget "$PRM" 'd["authorization_servers"][0]')
  [[ -n "$AS" ]] || die "PRM has no authorization_servers"
  SCOPES=$(jget "$PRM" '" ".join(d.get("scopes_supported",[]))')
  [[ -n "$SCOPES" ]] || die "PRM has no scopes_supported (a client could not pick a scope)"
  if [[ "$route" == "ops" ]]; then
    ACR=$(jget "$PRM" 'd.get("acr_values_supported",[""])[0]')
    [[ "$ACR" == "mfa" ]] || die "ops PRM lacks acr_values_supported=[mfa] (specialist step-up would fall back to config)"
  fi
  green "  OK  resource matches; AS=$AS; scopes='$SCOPES'"

  note "[3/4] authorization server metadata for $AS (RFC 8414 path-insertion form first)"
  ORIGIN=$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(f"{p.scheme}://{p.netloc}", p.path.rstrip("/"))' "$AS")
  AS_ORIGIN=${ORIGIN%% *}; AS_PATH=${ORIGIN#* }
  META_URL="$AS_ORIGIN/.well-known/oauth-authorization-server$AS_PATH"
  META=$($CURL -w '\n%{http_code}' "$META_URL"); CODE=${META##*$'\n'}; META=${META%$'\n'*}
  [[ "$CODE" == "200" ]] || die "$META_URL answered $CODE"
  ISS=$(jget "$META" 'd["issuer"]')
  [[ "$ISS" == "$AS" ]] || die "issuer '$ISS' does not echo '$AS' (RFC 8414 §3.3 — a client MUST reject this)"
  CIMD=$(jget "$META" 'str(d.get("client_id_metadata_document_supported")).lower()')
  [[ "$CIMD" == "true" ]] || die "client_id_metadata_document_supported is not true — the agents could not register"
  TE=$(jget "$META" 'd["token_endpoint"]')
  [[ "$TE" == https://* ]] || die "token_endpoint '$TE' is not https"
  green "  OK  issuer echoes; CIMD supported; token_endpoint=$TE"
done

note "[4/4] origin MCP servers: 401 challenges carry resource_metadata + scope; garbage bearer → invalid_token"
for H in "$OBS_HOST" "$OPS_HOST"; do
  OUT=$(probe "$H/mcp"); STATUS=${OUT%%$'\n'*}; WWW=${OUT#*$'\n'}
  [[ "$STATUS" == "401" ]] || die "$H: expected 401, got $STATUS"
  [[ -n "$(param "$WWW" resource_metadata)" ]] || die "$H: no resource_metadata in: $WWW"
  [[ -n "$(param "$WWW" scope)" ]] || die "$H: no scope in: $WWW"
  OUT=$(probe "$H/mcp" 'eyJhbGciOiJub25lIn0.e30.'); STATUS=${OUT%%$'\n'*}; WWW=${OUT#*$'\n'}
  [[ "$STATUS" == "401" ]] || die "$H: garbage bearer → expected 401, got $STATUS"
  [[ "$(param "$WWW" error)" == "invalid_token" ]] || die "$H: expected error=\"invalid_token\", got: $WWW"
  [[ -n "$(param "$WWW" resource_metadata)" ]] || die "$H: invalid-token 401 lacks resource_metadata"
  green "  OK  $H"
done

green "==> MCP authorization discovery is spec-conformant end to end."
