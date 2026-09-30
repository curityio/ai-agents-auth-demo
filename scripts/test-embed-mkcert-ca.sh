#!/usr/bin/env bash
# Contract test for scripts/embed-mkcert-ca.sh: BOTH trust anchors Curity needs
# land in the configmap's <server-truststore> — the machine-local mkcert root CA
# (CIMD metadata fetch over the gateway) and the demo's shared root CA (the SPIRE
# OIDC discovery provider's cert chains to it, so the token-exchange procedure can
# fetch SPIRE's JWKS through the `http-client-spiffe` facility with a real
# truststore instead of trust-all TLS). Each entry declares the key <size> read
# from its cert, the run is idempotent, and a configmap missing a sentinel fails.
#
# The anchors are machine-specific, so they land ONLY in the rendered copy ($OUT,
# .gen/ in real use): the source is never written, a failed run leaves no output
# behind, and the TRACKED configmap must keep both sentinel regions empty.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
fail() { red "FAIL: $*"; exit 1; }

# Two throwaway self-signed CAs with DIFFERENT key sizes so the declared <size>
# can be checked per entry.
mkdir -p "$TMP/caroot" "$TMP/shared"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=fake mkcert" \
  -keyout "$TMP/caroot/rootCA-key.pem" -out "$TMP/caroot/rootCA.pem" >/dev/null 2>&1
openssl req -x509 -newkey rsa:3072 -nodes -days 1 -subj "/CN=fake shared root" \
  -keyout "$TMP/shared/root-key.pem" -out "$TMP/shared/root-cert.pem" >/dev/null 2>&1

cat > "$TMP/configmap.yaml" <<'YAML'
data:
  curity-config.xml: |
    <config>
      <facilities>
        <crypto>
          <ssl>
            <server-truststore>
              <!-- BEGIN_MKCERT_CA -->
              <!-- END_MKCERT_CA -->
              <!-- BEGIN_SHARED_ROOT_CA -->
              <!-- END_SHARED_ROOT_CA -->
            </server-truststore>
          </ssl>
        </crypto>
      </facilities>
    </config>
YAML
cp "$TMP/configmap.yaml" "$TMP/source-before.yaml"

# render [shared-ca-pem] — tracked-shaped source in, rendered copy out.
render() {
  SOURCE="$TMP/configmap.yaml" OUT="$TMP/gen/out.yaml" \
    MKCERT_CAROOT="$TMP/caroot" SHARED_CA_PEM="${1:-$TMP/shared/root-cert.pem}" \
    bash "$REPO_ROOT/scripts/embed-mkcert-ca.sh" >/dev/null 2>&1
}
OUTF="$TMP/gen/out.yaml"

render || fail "render failed"
[[ -f "$OUTF" ]] || fail "no rendered configmap at OUT (its directory should be created)"
diff -q "$TMP/source-before.yaml" "$TMP/configmap.yaml" >/dev/null || fail "the SOURCE configmap was modified"

grep -q "<id>mkcert-root-ca</id>" "$OUTF" || fail "mkcert-root-ca entry missing"
grep -q "<id>shared-root-ca</id>" "$OUTF" || fail "shared-root-ca entry missing"
# size follows its own cert, per entry
awk '/BEGIN_MKCERT_CA/,/END_MKCERT_CA/' "$OUTF" | grep -q "<size>2048</size>" \
  || fail "mkcert entry should declare size 2048"
awk '/BEGIN_SHARED_ROOT_CA/,/END_SHARED_ROOT_CA/' "$OUTF" | grep -q "<size>3072</size>" \
  || fail "shared-root entry should declare size 3072"
# PEM body lands at exactly 4 spaces so YAML strips it to column 0 (Curity's parser is whitespace-sensitive)
awk '/BEGIN_SHARED_ROOT_CA/,/END_SHARED_ROOT_CA/' "$OUTF" | grep -q "^    -----END CERTIFICATE-----</keystore>" \
  || fail "shared-root PEM END marker not at the 4-space column"
# the two certs are distinct
m="$(awk '/BEGIN_MKCERT_CA/,/END_MKCERT_CA/' "$OUTF" | grep -A1 "BEGIN CERTIFICATE" | tail -1)"
s="$(awk '/BEGIN_SHARED_ROOT_CA/,/END_SHARED_ROOT_CA/' "$OUTF" | grep -A1 "BEGIN CERTIFICATE" | tail -1)"
[[ "$m" != "$s" ]] || fail "both entries embed the same certificate"

cp "$OUTF" "$TMP/first.yaml"
render || fail "second render failed"
diff -q "$TMP/first.yaml" "$OUTF" >/dev/null || fail "second run was not idempotent"

# A failed run must neither clobber the previous render nor leave temp files.
render "$TMP/does-not-exist.pem" && fail "a missing shared root CA should be rejected (run make gen-ca)"
diff -q "$TMP/first.yaml" "$OUTF" >/dev/null || fail "a failed run changed the previous render"
printf '<config><facilities/></config>\n' > "$TMP/configmap.yaml"
render && fail "a configmap without the sentinels should be rejected"
diff -q "$TMP/first.yaml" "$OUTF" >/dev/null || fail "a failed run changed the previous render"
[[ "$(ls "$TMP/gen")" == "out.yaml" ]] || fail "a failed run left temp files: $(ls "$TMP/gen")"

# The TRACKED configmap carries no machine-specific trust anchor: both sentinel
# regions are empty, so a `make demo` on any machine leaves git clean.
TRACKED="$REPO_ROOT/k8s/curity/configmap.yaml"
for sentinel in MKCERT_CA SHARED_ROOT_CA; do
  grep -q "BEGIN_$sentinel" "$TRACKED" || fail "tracked configmap lost the BEGIN_$sentinel sentinel"
  inner="$(awk "/BEGIN_$sentinel/{f=1;next} /END_$sentinel/{f=0} f" "$TRACKED")"
  [[ -z "$inner" ]] || fail "tracked configmap has content between the $sentinel sentinels (commit the empty form; make apply renders .gen/curity-configmap.yaml)"
done

green "OK: embed-mkcert-ca renders mkcert + shared root CAs into OUT only (per-cert sizes, idempotent, fails closed), tracked truststore is empty"
