#!/usr/bin/env bash
# gen-shared-ca.sh — generate the cluster's single root CA and the two
# intermediate CAs that hang off it:
#
#   root CA  ─┬─ Istio intermediate  → istiod signs workload X.509 (ztunnel mTLS)
#            └─ SPIRE intermediate  → SPIRE server CA signs X.509-SVIDs
#
# Both intermediates chain to ONE root, so every certificate in the cluster
# (Istio transport certs and SPIRE SVIDs alike) anchors on the same trust root.
# SPIRE's JWT-SVIDs are signed by a separate JWT key, but the trust *bundle*
# published for the trust domain is anchored on this same root.
#
# Output (all under certs/shared-ca/, which is gitignored — this is key material):
#   root-cert.pem                       the shared root (the only thing both planes share)
#   root-key.pem                        root private key (KEEP OFFLINE; not pushed to cluster)
#   istio/{root-cert,ca-cert,ca-key,cert-chain}.pem   the 4 files Istio's `cacerts` secret expects
#   spire/{tls.crt,tls.key,bundle.crt}  the 3 keys SPIRE's disk UpstreamAuthority secret expects
#
# Consumed by `make seed-istio-ca` and `make seed-spire-ca`.
# Idempotent: re-running regenerates everything (rotates the whole tree).
set -euo pipefail

CERT_DIR="${CERT_DIR:-certs}"
OUT="${OUT:-$CERT_DIR/shared-ca}"
DAYS="${DAYS:-3650}"
# Keep the org consistent with SPIRE's caSubject (k8s/spire/values.yaml) so the
# shared-root story reads cleanly in cert dumps.
ORG="${ORG:-ai-agents-demo}"

mkdir -p "$OUT/istio" "$OUT/spire"

echo "==> Generating shared root CA"
openssl genrsa -out "$OUT/root-key.pem" 4096 2>/dev/null
openssl req -x509 -new -nodes -key "$OUT/root-key.pem" -sha256 -days "$DAYS" \
  -subj "/O=$ORG/CN=$ORG shared root CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -out "$OUT/root-cert.pem"

# gen_intermediate <name> <outdir> — create an intermediate CA signed by the root.
# Emits <outdir>/ca-key.pem and <outdir>/ca-cert.pem.
gen_intermediate() {
  local name="$1" dir="$2"
  mkdir -p "$dir"
  echo "==> Generating intermediate CA: $name"
  openssl genrsa -out "$dir/ca-key.pem" 4096 2>/dev/null
  openssl req -new -key "$dir/ca-key.pem" \
    -subj "/O=$ORG/CN=$ORG $name intermediate CA" \
    -out "$dir/ca.csr"
  # pathlen:0 — these intermediates sign leaf/lower-CA certs but not further CA tiers.
  openssl x509 -req -in "$dir/ca.csr" -sha256 -days "$DAYS" \
    -CA "$OUT/root-cert.pem" -CAkey "$OUT/root-key.pem" -CAcreateserial \
    -extfile <(printf 'basicConstraints=critical,CA:TRUE,pathlen:1\nkeyUsage=critical,keyCertSign,cRLSign\n') \
    -out "$dir/ca-cert.pem" 2>/dev/null
  rm -f "$dir/ca.csr"
}

# ---- Istio plug-in CA (`cacerts` secret) ----
gen_intermediate "istio" "$OUT/istio"
cp "$OUT/root-cert.pem" "$OUT/istio/root-cert.pem"
# cert-chain.pem = intermediate then root (the chain istiod serves to peers).
cat "$OUT/istio/ca-cert.pem" "$OUT/root-cert.pem" > "$OUT/istio/cert-chain.pem"

# ---- SPIRE disk UpstreamAuthority secret ----
gen_intermediate "spire" "$OUT/spire-int"
# SPIRE's disk plugin expects: tls.crt (upstream CA cert), tls.key, bundle.crt (root).
cp "$OUT/spire-int/ca-cert.pem" "$OUT/spire/tls.crt"
cp "$OUT/spire-int/ca-key.pem"  "$OUT/spire/tls.key"
cp "$OUT/root-cert.pem"         "$OUT/spire/bundle.crt"
rm -rf "$OUT/spire-int"

chmod 600 "$OUT/root-key.pem" "$OUT/istio/ca-key.pem" "$OUT/spire/tls.key"

echo "==> Done. Shared CA tree under $OUT/"
echo "    Root fingerprint:"
openssl x509 -in "$OUT/root-cert.pem" -noout -fingerprint -sha256 | sed 's/^/      /'
echo "    Next: make seed-istio-ca && make seed-spire-ca"
echo "    The root key ($OUT/root-key.pem) is NOT pushed to the cluster — keep it safe."
