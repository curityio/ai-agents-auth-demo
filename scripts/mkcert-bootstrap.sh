#!/usr/bin/env bash
# mkcert-bootstrap.sh — generate dev TLS certs for the *.localtest.me hostnames used by the demo.
# Idempotent: re-running regenerates only what's missing.
set -euo pipefail

CERT_DIR="${CERT_DIR:-certs}"

HOSTS=(
  "app.localtest.me"
  "curity.localtest.me"
  "curity-admin.localtest.me"
  "grafana.localtest.me"
  "copilot.localtest.me"
  "specialist.localtest.me"
  "mcp-ops.localtest.me"
  "mcp-observability.localtest.me"
)

if ! command -v mkcert >/dev/null 2>&1; then
  echo "mkcert not found. Install: brew install mkcert" >&2
  exit 1
fi

mkdir -p "$CERT_DIR"

# Local CA handling.
#
# We do NOT install the mkcert root CA into the macOS System keychain / browser
# trust stores by default — that is a system-wide mutation some users would
# rather avoid, and the demo does not need it: every in-cluster consumer trusts
# the CA by reading rootCA.pem directly off disk (pods mount it via
# NODE_EXTRA_CA_CERTS in cluster-routing.sh; Curity embeds it into its
# server-truststore via embed-mkcert-ca.sh). The ONLY thing `mkcert -install`
# buys is a warning-free browser tab.
#
# The CAROOT (rootCA.pem) must still EXIST for leaf signing and the in-cluster
# trust mounts. `mkcert <host>` below auto-creates it on first use without
# touching any system trust store, so the default path is safe.
#
# Set MKCERT_INSTALL_CA=1 (or run `make trust-ca`) to also install the root CA
# into the keychain and silence browser TLS warnings.
if [[ "${MKCERT_INSTALL_CA:-0}" == "1" ]]; then
  mkcert -install
else
  echo "ℹ Skipping 'mkcert -install' — the macOS keychain is left untouched."
  echo "  Expect a browser TLS warning at https://app.localtest.me (safe to proceed)."
  echo "  To trust the CA and remove warnings later: make trust-ca"
fi

# One cert per host (simpler for per-namespace TLS secrets)
for host in "${HOSTS[@]}"; do
  cert="$CERT_DIR/$host.pem"
  key="$CERT_DIR/$host-key.pem"
  if [[ -f "$cert" && -f "$key" ]]; then
    echo "✓ $host (already present)"
    continue
  fi
  ( cd "$CERT_DIR" && mkcert "$host" )
  echo "✓ $host"
done

echo ""
echo "Certs in $CERT_DIR/"
ls -1 "$CERT_DIR"
