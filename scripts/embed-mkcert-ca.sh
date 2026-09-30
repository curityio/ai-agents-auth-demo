#!/usr/bin/env bash
# Render the Curity configmap with the TWO trust anchors Curity needs embedded in
# its server-truststore:
#
#   mkcert-root-ca  — the machine-local mkcert root CA. Curity's `cimd-fetch`
#                     HTTP client trusts it when dereferencing each agent's CIMD
#                     client_id URL (https://*.localtest.me) through the gateway.
#   shared-root-ca  — the demo's shared root CA (certs/shared-ca/root-cert.pem,
#                     `make gen-ca`). SPIRE's OIDC discovery provider serves its
#                     X.509 SVID, which chains SPIRE CA → SPIRE intermediate →
#                     this root, so the token-exchange procedure can fetch SPIRE's
#                     JWKS through the `http-client-spiffe` facility with real
#                     truststore validation (hostname verification stays off:
#                     the SAN is the external name, not the Service FQDN).
#
# Both CAs are machine-specific (mkcert -install / gen-shared-ca.sh), so they never
# go into git: the tracked configmap ($SOURCE) keeps the sentinels EMPTY, and this
# script writes a filled copy to $OUT (gitignored .gen/), which `make apply`
# applies. $SOURCE is only read — a `make clean` + `make demo` cycle mints a new
# shared root, and embedding it in place used to leave the tracked file dirty.
# Re-run after `make certs` / `make gen-ca` / on a new machine (`make apply` does).
# Sentinel-delimited injection: BEGIN_MKCERT_CA / BEGIN_SHARED_ROOT_CA.

set -euo pipefail

SOURCE="${SOURCE:-k8s/curity/configmap.yaml}"
OUT="${OUT:-.gen/curity-configmap.yaml}"
MKCERT_CAROOT="${MKCERT_CAROOT:-$(mkcert -CAROOT 2>/dev/null || true)}"
SHARED_CA_PEM="${SHARED_CA_PEM:-certs/shared-ca/root-cert.pem}"

if [[ -z "$MKCERT_CAROOT" || ! -f "$MKCERT_CAROOT/rootCA.pem" ]]; then
  echo "mkcert root CA not found (run 'mkcert -install' / 'make certs' first)" >&2
  exit 1
fi
if [[ ! -f "$SHARED_CA_PEM" ]]; then
  echo "shared root CA not found at $SHARED_CA_PEM (run 'make gen-ca' first)" >&2
  exit 1
fi

# Curity's server-truststore validates the declared key <size> against the cert
# (ConfD CrashLoops on a mismatch), so read it from each cert rather than assuming
# the 2048 default — mkcert CAs are commonly 3072-bit, the shared root is 4096.
key_size() {
  local size
  size="$(openssl x509 -in "$1" -noout -text 2>/dev/null \
    | grep -oE 'Public-Key: \(([0-9]+) bit\)' | grep -oE '[0-9]+' | head -1)"
  printf '%s' "${size:-2048}"
}

# Build into a temp file next to $OUT and move it into place only once both
# entries are in, so a failed run never leaves a half-rendered configmap for
# `make apply` to push.
mkdir -p "$(dirname "$OUT")"
CONFIGMAP="$(mktemp "$OUT.XXXXXX")"
trap 'rm -f "$CONFIGMAP"' EXIT
cp "$SOURCE" "$CONFIGMAP"

# embed <sentinel> <entry-id> <pem-file>
embed() {
  local sentinel="$1" id="$2" pem_file="$3" size
  size="$(key_size "$pem_file")"
  echo "==> Embedding $pem_file (RSA $size-bit) as <server-certificate> $id into $OUT"
  python3 - "$CONFIGMAP" "$(cat "$pem_file")" "$size" "$sentinel" "$id" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
lines = [l for l in sys.argv[2].strip().splitlines() if l.strip()]
size, sentinel, entry_id = sys.argv[3], sys.argv[4], sys.argv[5]
src = path.read_text()
# The XML lives in a YAML literal block scalar indented 4 spaces. Every line must
# keep >= 4 spaces of indent or it terminates the scalar. We attach the PEM BEGIN
# marker to the <keystore> tag and indent the base64 body + END marker at exactly
# 4 spaces, so YAML strips them to column 0 — leaving a clean, unindented PEM in
# the <keystore> text value (Curity's cert parser is whitespace-sensitive).
body = "".join("    " + l + "\n" for l in lines[1:-1])
cert = (
    "<!-- BEGIN_" + sentinel + " -->\n"
    "              <server-certificate>\n"
    "                <id>" + entry_id + "</id>\n"
    "                <size>" + size + "</size>\n"
    "                <keystore>" + lines[0] + "\n"
    + body
    + "    " + lines[-1] + "</keystore>\n"
    "              </server-certificate>\n"
    "              <!-- END_" + sentinel + " -->"
)
new, n = re.subn(
    r"<!-- BEGIN_" + sentinel + r" -->.*?<!-- END_" + sentinel + r" -->",
    lambda _m: cert,
    src,
    count=1,
    flags=re.DOTALL,
)
if n != 1:
    print("BEGIN_" + sentinel + " / END_" + sentinel + " sentinels not found in", path, file=sys.stderr)
    sys.exit(2)
path.write_text(new)
PY
}

embed MKCERT_CA mkcert-root-ca "$MKCERT_CAROOT/rootCA.pem"
embed SHARED_ROOT_CA shared-root-ca "$SHARED_CA_PEM"
mv "$CONFIGMAP" "$OUT"
trap - EXIT
echo "==> Rendered $SOURCE + trust anchors -> $OUT"
