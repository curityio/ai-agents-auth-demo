#!/usr/bin/env bash
# jwks-guard — keep istiod from pinning a PLACEHOLDER JWKS on the apis-waypoint.
#
# k8s/istio/apis-l7-authz.yaml's RequestAuthentication points istiod at Curity's
# in-cluster JWKS URL. istiod fetches that key ONCE when it first generates the
# waypoint's jwt_authn filter. If Curity is still booting at that moment, istiod
# (pilot/pkg/model/jwks_resolver.go, 1.30) logs "JWKS fetch failed … using
# public-only JWKS with discarded private key", inlines a random public key so
# every token fails "401 Jwt verification fails" — and its one background retry
# DELETES the empty cache entry, so the periodic refresher never revisits it.
# Nothing recovers until the waypoint's filters are regenerated. (Fact #38.)
#
#   jwks-guard.sh wait   — block until Curity serves a JWKS with a signing key
#                          THROUGH ITS SERVICE (what istiod will hit); run by
#                          `make apply` right before the policy is applied
#   jwks-guard.sh check  — read-only: the waypoint's inline JWKS holds every kid
#                          Curity currently serves (`make jwks-check`, `make
#                          status`, `make smoke`)
#   jwks-guard.sh heal   — rollout-restart the waypoint so istiod regenerates the
#                          filter and fetches for real, then re-check
#
# The pure helpers (jwks_kids, kids_covered, extract_waypoint_jwks) are
# sourceable with JWKS_GUARD_LIB_ONLY=1 and pinned by scripts/test-jwks-guard.sh.
set -euo pipefail

NS_CURITY="${NS_CURITY:-curity}"
NS_APIS="${NS_APIS:-apis}"
CURITY_DEPLOY="${CURITY_DEPLOY:-curity}"
WAYPOINT_DEPLOY="${WAYPOINT_DEPLOY:-apis-waypoint}"
# The API server's service proxy reaches the JWKS via the Service's endpoints —
# the same path istiod takes — without curl in the pod or a port-forward.
CURITY_JWKS_RAW="/api/v1/namespaces/${NS_CURITY}/services/${CURITY_DEPLOY}:8443/proxy/oauth/v2/oauth-anonymous/jwks"
WAIT_TIMEOUT="${JWKS_WAIT_TIMEOUT:-300}"

# jwks_kids FILE — one line per key: its kid, or <no-kid> for a key without one
# (istiod's placeholder has none). Prints nothing for an empty key set.
# (python via -c, NOT a stdin heredoc, so FILE may be /dev/stdin from a pipe.)
jwks_kids() {
  python3 -c '
import json, sys
doc = json.load(open(sys.argv[1]))
for k in doc.get("keys", []):
    print(k.get("kid") or "<no-kid>")
' "$1"
}

# kids_covered EXPECTED_JWKS ACTUAL_JWKS — 0 iff EXPECTED has at least one kid and
# every one of them appears in ACTUAL. A placeholder key never covers anything.
kids_covered() {
  local expected actual k
  expected="$(jwks_kids "$1")"
  actual="$(jwks_kids "$2")"
  [ -n "$expected" ] || return 1
  while IFS= read -r k; do
    [ "$k" = "<no-kid>" ] && return 1
    grep -qxF -- "$k" <<<"$actual" || return 1
  done <<<"$expected"
  return 0
}

# extract_waypoint_jwks CONFIG_DUMP — print the jwt_authn filter's inline JWKS
# (the first `local_jwks.inline_string` in the dump). Fails when there is none.
extract_waypoint_jwks() {
  python3 -c '
import json, sys
def walk(node):
    if isinstance(node, dict):
        lj = node.get("local_jwks")
        if isinstance(lj, dict) and isinstance(lj.get("inline_string"), str):
            return lj["inline_string"]
        for v in node.values():
            found = walk(v)
            if found is not None:
                return found
    elif isinstance(node, list):
        for v in node:
            found = walk(v)
            if found is not None:
                return found
    return None
found = walk(json.load(open(sys.argv[1])))
if found is None:
    sys.stderr.write("no jwt_authn local_jwks in config_dump\n")
    sys.exit(1)
print(found)
' "$1"
}

if [ "${JWKS_GUARD_LIB_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

die() { echo "ERROR: $*" >&2; exit 1; }

# One scratch dir for every subcommand. (Not a RETURN trap inside the functions:
# under `set -u` a RETURN trap that names a function-local fires in the CALLER's
# scope — `heal` calling `check` died with "curity: unbound variable".)
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

fetch_curity_jwks() { kubectl get --raw "$CURITY_JWKS_RAW"; }

waypoint_pod() {
  kubectl -n "$NS_APIS" get pods -l "gateway.networking.k8s.io/gateway-name=${WAYPOINT_DEPLOY}" \
    --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}' 2>/dev/null
}

cmd_wait() {
  echo "==> Waiting for Curity to serve its JWKS through svc/${CURITY_DEPLOY} (istiod fetches it once, when the apis-waypoint policy is generated)…"
  kubectl -n "$NS_CURITY" rollout status "deploy/${CURITY_DEPLOY}" --timeout="${WAIT_TIMEOUT}s" \
    || die "Curity did not become ready within ${WAIT_TIMEOUT}s — apply apis-l7-authz.yaml only once it serves ${CURITY_JWKS_RAW##*/proxy}"
  local tmp deadline
  tmp="$TMPD/curity-wait.json"
  deadline=$(( $(date +%s) + WAIT_TIMEOUT ))
  while :; do
    if fetch_curity_jwks > "$tmp" 2>/dev/null && [ -n "$(jwks_kids "$tmp" 2>/dev/null)" ] && kids_covered "$tmp" "$tmp"; then
      echo "    Curity JWKS reachable in-cluster; kid(s): $(jwks_kids "$tmp" | tr '\n' ' ')"
      return 0
    fi
    [ "$(date +%s)" -lt "$deadline" ] || die "Curity's JWKS did not answer through its Service within ${WAIT_TIMEOUT}s"
    sleep 3
  done
}

cmd_check() {
  local curity dump wp pod
  curity="$TMPD/curity.json"; dump="$TMPD/config_dump.json"; wp="$TMPD/waypoint-jwks.json"
  fetch_curity_jwks > "$curity" 2>/dev/null || die "cannot fetch Curity's JWKS via ${CURITY_JWKS_RAW} — is Curity running?"
  pod="$(waypoint_pod)"
  [ -n "$pod" ] || die "no running ${WAYPOINT_DEPLOY} pod in ns ${NS_APIS} (is k8s/istio/apis-l7-authz.yaml applied?)"
  kubectl -n "$NS_APIS" exec "$pod" -c istio-proxy -- pilot-agent request GET config_dump > "$dump" 2>/dev/null \
    || die "cannot read config_dump from ${pod}"
  extract_waypoint_jwks "$dump" > "$wp" 2>/dev/null \
    || die "${pod} has no jwt_authn filter — the RequestAuthentication has not been pushed yet"
  if kids_covered "$curity" "$wp"; then
    echo "OK: apis-waypoint validates tokens with Curity's key(s): $(jwks_kids "$curity" | tr '\n' ' ')"
    return 0
  fi
  cat >&2 <<MSG
ERROR: the apis-waypoint is NOT validating tokens with Curity's key.
  Curity serves kid(s) : $(jwks_kids "$curity" | tr '\n' ' ')
  waypoint holds kid(s): $(jwks_kids "$wp" | tr '\n' ' ')
istiod generated the waypoint's jwt_authn filter while Curity was unreachable and
inlined a placeholder key ("<no-kid>" above) — every obs-api/ops-api call now fails
"401 Jwt verification fails", and istiod will NOT retry on its own.
Fix: make jwks-heal   (rollout-restarts the waypoint so istiod regenerates the filter)
MSG
  return 1
}

cmd_heal() {
  echo "==> Restarting deploy/${WAYPOINT_DEPLOY} so istiod regenerates its jwt_authn filter…"
  kubectl -n "$NS_APIS" rollout restart "deploy/${WAYPOINT_DEPLOY}"
  kubectl -n "$NS_APIS" rollout status "deploy/${WAYPOINT_DEPLOY}" --timeout=120s
  # The new proxy needs a moment to receive its listeners before the dump is telling.
  local i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if cmd_check 2>/dev/null; then return 0; fi
    sleep 3
  done
  cmd_check
}

case "${1:-check}" in
  wait)  cmd_wait ;;
  check) cmd_check ;;
  heal)  cmd_heal ;;
  *) echo "usage: $0 {wait|check|heal}" >&2; exit 2 ;;
esac
