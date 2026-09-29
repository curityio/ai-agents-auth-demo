#!/usr/bin/env bash
# Contract test for scripts/embed-mkcert-ca.sh: BOTH trust anchors Curity needs
# land in the configmap's <server-truststore> — the machine-local mkcert root CA
# (CIMD metadata fetch over the gateway) and the demo's shared root CA (the SPIRE
# OIDC discovery provider's cert chains to it, so the token-exchange procedure can
# fetch SPIRE's JWKS through the `http-client-spiffe` facility with a real
# truststore instead of trust-all TLS). Each entry declares the key <size> read
# from its cert, the run is idempotent, and a configmap missing a sentinel fails.
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

CONFIGMAP="$TMP/configmap.yaml" MKCERT_CAROOT="$TMP/caroot" SHARED_CA_PEM="$TMP/shared/root-cert.pem" \
  bash "$REPO_ROOT/scripts/embed-mkcert-ca.sh" >/dev/null

grep -q "<id>mkcert-root-ca</id>" "$TMP/configmap.yaml" || fail "mkcert-root-ca entry missing"
grep -q "<id>shared-root-ca</id>" "$TMP/configmap.yaml" || fail "shared-root-ca entry missing"
# size follows its own cert, per entry
awk '/BEGIN_MKCERT_CA/,/END_MKCERT_CA/' "$TMP/configmap.yaml" | grep -q "<size>2048</size>" \
  || fail "mkcert entry should declare size 2048"
awk '/BEGIN_SHARED_ROOT_CA/,/END_SHARED_ROOT_CA/' "$TMP/configmap.yaml" | grep -q "<size>3072</size>" \
  || fail "shared-root entry should declare size 3072"
# PEM body lands at exactly 4 spaces so YAML strips it to column 0 (Curity's parser is whitespace-sensitive)
awk '/BEGIN_SHARED_ROOT_CA/,/END_SHARED_ROOT_CA/' "$TMP/configmap.yaml" | grep -q "^    -----END CERTIFICATE-----</keystore>" \
  || fail "shared-root PEM END marker not at the 4-space column"
# the two certs are distinct
m="$(awk '/BEGIN_MKCERT_CA/,/END_MKCERT_CA/' "$TMP/configmap.yaml" | grep -A1 "BEGIN CERTIFICATE" | tail -1)"
s="$(awk '/BEGIN_SHARED_ROOT_CA/,/END_SHARED_ROOT_CA/' "$TMP/configmap.yaml" | grep -A1 "BEGIN CERTIFICATE" | tail -1)"
[[ "$m" != "$s" ]] || fail "both entries embed the same certificate"

cp "$TMP/configmap.yaml" "$TMP/first.yaml"
CONFIGMAP="$TMP/configmap.yaml" MKCERT_CAROOT="$TMP/caroot" SHARED_CA_PEM="$TMP/shared/root-cert.pem" \
  bash "$REPO_ROOT/scripts/embed-mkcert-ca.sh" >/dev/null
diff -q "$TMP/first.yaml" "$TMP/configmap.yaml" >/dev/null || fail "second run was not idempotent"

printf '<config><facilities/></config>\n' > "$TMP/no-sentinel.yaml"
if CONFIGMAP="$TMP/no-sentinel.yaml" MKCERT_CAROOT="$TMP/caroot" SHARED_CA_PEM="$TMP/shared/root-cert.pem" \
  bash "$REPO_ROOT/scripts/embed-mkcert-ca.sh" >/dev/null 2>&1; then
  fail "a configmap without the sentinels should be rejected"
fi
if CONFIGMAP="$TMP/configmap.yaml" MKCERT_CAROOT="$TMP/caroot" SHARED_CA_PEM="$TMP/does-not-exist.pem" \
  bash "$REPO_ROOT/scripts/embed-mkcert-ca.sh" >/dev/null 2>&1; then
  fail "a missing shared root CA should be rejected (run make gen-ca)"
fi

green "OK: embed-mkcert-ca embeds mkcert + shared root CAs with per-cert sizes, is idempotent, and fails closed"
