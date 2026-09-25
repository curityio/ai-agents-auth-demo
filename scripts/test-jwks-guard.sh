#!/usr/bin/env bash
# Contract test for scripts/jwks-guard.sh — the guard against istiod pushing a
# PLACEHOLDER JWKS to the apis-waypoint. Fact #38: when the RequestAuthentication
# is generated while Curity is still booting, istiod inlines a random public key
# ("public-only JWKS with discarded private key") and never retries, so every
# inspect-api/ops-api call fails "401 Jwt verification fails". The pure comparison is
# pinned here with fixtures; the Makefile wiring (wait BEFORE the policy is
# applied, check in status/smoke) is pinned by grep.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
fail=0
ok() { green "OK   $*"; }
ko() { red "FAIL $*"; fail=1; }

GUARD="$REPO_ROOT/scripts/jwks-guard.sh"
[ -f "$GUARD" ] || { ko "scripts/jwks-guard.sh does not exist"; exit 1; }
# shellcheck disable=SC1090
JWKS_GUARD_LIB_ONLY=1 source "$GUARD"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
CURITY="$TMP/curity.json"; FAKE="$TMP/fake.json"; MATCH="$TMP/match.json"; OTHER="$TMP/other.json"; EMPTY="$TMP/empty.json"
printf '{"keys":[{"kty":"RSA","kid":"-474154742","use":"sig","alg":"RS256","e":"AQAB","n":"nQS"}]}' > "$CURITY"
# What istiod inlines after a failed fetch: a random RSA public key, no kid.
printf '{\n  "keys": [\n    {\n      "kty": "RSA",\n      "e": "AQAB",\n      "n": "0xOb"\n    }\n  ]\n}' > "$FAKE"
printf '{"keys":[{"kty":"RSA","kid":"-474154742","e":"AQAB","n":"nQS"},{"kty":"RSA","kid":"old","e":"AQAB","n":"x"}]}' > "$MATCH"
printf '{"keys":[{"kty":"RSA","kid":"12345","e":"AQAB","n":"zz"}]}' > "$OTHER"
printf '{"keys":[]}' > "$EMPTY"

# --- jwks_kids: one kid per line; a key without kid prints <no-kid> ---------
if [ "$(jwks_kids "$CURITY")" = "-474154742" ]; then ok "jwks_kids prints Curity's kid"; else ko "jwks_kids on Curity JWKS: $(jwks_kids "$CURITY")"; fi
if [ "$(jwks_kids "$FAKE")" = "<no-kid>" ]; then ok "jwks_kids marks istiod's placeholder key as <no-kid>"; else ko "jwks_kids on fake JWKS: $(jwks_kids "$FAKE")"; fi
if [ -z "$(jwks_kids "$EMPTY")" ]; then ok "jwks_kids prints nothing for an empty key set"; else ko "jwks_kids on empty JWKS printed: $(jwks_kids "$EMPTY")"; fi

# --- kids_covered EXPECTED ACTUAL: 0 iff every expected kid is in ACTUAL -----
if kids_covered "$CURITY" "$MATCH"; then ok "kids_covered accepts a waypoint JWKS holding Curity's kid"; else ko "kids_covered rejected a matching JWKS"; fi
if kids_covered "$CURITY" "$FAKE"; then ko "kids_covered accepted istiod's placeholder JWKS"; else ok "kids_covered rejects istiod's placeholder JWKS"; fi
if kids_covered "$CURITY" "$OTHER"; then ko "kids_covered accepted a JWKS with a different kid"; else ok "kids_covered rejects a JWKS with a different kid"; fi
if kids_covered "$EMPTY" "$MATCH"; then ko "kids_covered accepted an EMPTY expected set (Curity served no signing key)"; else ok "kids_covered refuses an empty expected set"; fi

# --- extract_waypoint_jwks: pull jwt_authn's inline JWKS out of a config_dump --
DUMP="$TMP/dump.json"
cat > "$DUMP" <<'JSON'
{"configs":[{"dynamic_listeners":[{"filter_chains":[{"filters":[{"name":"envoy.filters.http.jwt_authn",
 "providers":{"origins-0":{"issuer":"https://curity.localtest.me/oauth/v2/oauth-anonymous",
 "local_jwks": {
                  "inline_string": "{\n  \"keys\": [\n    {\n      \"kty\": \"RSA\",\n      \"kid\": \"-474154742\",\n      \"e\": \"AQAB\",\n      \"n\": \"nQS\"\n    }\n  ]\n}"
                 },
 "forward": true}}}]}]}]}]}
JSON
if [ "$(extract_waypoint_jwks "$DUMP" | jwks_kids /dev/stdin)" = "-474154742" ]; then ok "extract_waypoint_jwks finds the inline JWKS in a config_dump"; else ko "extract_waypoint_jwks: $(extract_waypoint_jwks "$DUMP")"; fi
printf '{"configs":[]}' > "$TMP/nodump.json"
if extract_waypoint_jwks "$TMP/nodump.json" >/dev/null 2>&1; then ko "extract_waypoint_jwks succeeded on a dump with no jwt_authn filter"; else ok "extract_waypoint_jwks fails on a dump with no jwt_authn filter"; fi

# --- Makefile wiring --------------------------------------------------------
MK="$REPO_ROOT/Makefile"
wait_line=$(grep -nE 'jwks-guard\.sh wait' "$MK" | head -1 | cut -d: -f1 || true)
ra_line=$(grep -nF 'kubectl apply -f k8s/istio/apis-l7-authz.yaml' "$MK" | head -1 | cut -d: -f1 || true)
if [ -n "$wait_line" ] && [ -n "$ra_line" ] && [ "$wait_line" -lt "$ra_line" ]; then ok "make apply waits for Curity's JWKS BEFORE applying apis-l7-authz.yaml"; else ko "make apply must run 'jwks-guard.sh wait' before applying apis-l7-authz.yaml (wait=$wait_line ra=$ra_line)"; fi
grep -qE '^jwks-check:' "$MK" && ok "make jwks-check exists" || ko "Makefile lacks jwks-check target"
grep -qE '^jwks-heal:' "$MK" && ok "make jwks-heal exists" || ko "Makefile lacks jwks-heal target"
grep -qE '^smoke: .*\bjwks-check\b' "$MK" && ok "make smoke runs jwks-check" || ko "make smoke does not run jwks-check"
awk '/^status:/,/^$/' "$MK" | grep -qF 'jwks-guard.sh check' && ok "make status runs the waypoint JWKS check" || ko "make status does not run jwks-guard.sh check"
grep -qF 'scripts/test-jwks-guard.sh' "$MK" && ok "make test-scripts runs this test" || ko "make test-scripts lacks test-jwks-guard.sh"
grep -qF 'make jwks-heal' "$GUARD" && ok "the check's failure message names the heal" || ko "jwks-guard.sh check does not point at 'make jwks-heal'"


# --- check/heal against a STUBBED kubectl -----------------------------------
# The kubectl-dependent paths run with a fake kubectl on PATH that answers from
# fixtures, so the exit codes and the failure message are pinned without a cluster.
# (heal once died with "curity: unbound variable" from a RETURN trap that named a
# function-local — this is the regression test for that.)
STUB="$TMP/bin"; mkdir -p "$STUB"
cat > "$STUB/kubectl" <<'SH'
#!/usr/bin/env bash
# args → fixture, driven by $STUB_DUMP
case "$*" in
  *"get --raw"*) cat "$STUB_CURITY" ;;
  *"get pods"*) printf 'apis-waypoint-stub' ;;
  *"exec"*"config_dump"*) cat "$STUB_DUMP" ;;
  *"rollout"*) echo "deployment stub ok" ;;
  *) echo "stub kubectl: unexpected args: $*" >&2; exit 9 ;;
esac
SH
chmod +x "$STUB/kubectl"
mk_dump() { # $1 jwks file → config_dump json with it inlined
  python3 -c 'import json,sys; print(json.dumps({"configs":[{"filters":[{"name":"envoy.filters.http.jwt_authn","local_jwks":{"inline_string":open(sys.argv[1]).read()}}]}]}))' "$1"
}
GOOD_DUMP="$TMP/good-dump.json"; BAD_DUMP="$TMP/bad-dump.json"
mk_dump "$MATCH" > "$GOOD_DUMP"; mk_dump "$FAKE" > "$BAD_DUMP"
run_guard() { PATH="$STUB:$PATH" STUB_CURITY="$CURITY" STUB_DUMP="$1" bash "$GUARD" "$2"; }

if out="$(run_guard "$GOOD_DUMP" check 2>&1)"; then ok "check exits 0 when the waypoint holds Curity's kid"; else ko "check exited non-zero on a good dump: $out"; fi
if out="$(run_guard "$BAD_DUMP" check 2>&1)"; then ko "check exited 0 on istiod's placeholder JWKS"; else
  ok "check exits non-zero on istiod's placeholder JWKS"
  grep -qF 'make jwks-heal' <<<"$out" && ok "check's failure output points at make jwks-heal" || ko "check's failure output lacks 'make jwks-heal': $out"
  grep -qF '<no-kid>' <<<"$out" && ok "check's failure output shows the placeholder as <no-kid>" || ko "check's failure output lacks <no-kid>: $out"
fi
if out="$(run_guard "$GOOD_DUMP" heal 2>&1)"; then ok "heal exits 0 once the waypoint holds Curity's kid"; else ko "heal exited non-zero: $out"; fi
if out="$(run_guard "$GOOD_DUMP" wait 2>&1)"; then ok "wait exits 0 when Curity serves a kid"; else ko "wait exited non-zero: $out"; fi

exit $fail
