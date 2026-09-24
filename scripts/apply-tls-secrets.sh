#!/usr/bin/env bash
# Create / refresh TLS secrets in each namespace from local mkcert certs.
# Idempotent — re-running replaces existing secrets.
#
# Uses parallel arrays instead of `declare -A` so it works on macOS's
# bundled bash 3.2 (associative arrays + dotted keys break there).
set -euo pipefail

CERT_DIR="${CERT_DIR:-certs}"

# host | namespace | secret-name (one triple per line)
# istio-ingress entries land alongside the per-workload ones because Istio's
# Gateway resource looks for the cert Secret in the gateway's own namespace.
ENTRIES="
app.localtest.me|web|web-tls
app.localtest.me|istio-ingress|web-tls
curity.localtest.me|curity|curity-tls
curity.localtest.me|istio-ingress|curity-tls
curity-admin.localtest.me|istio-ingress|curity-admin-tls
grafana.localtest.me|telemetry|grafana-tls
grafana.localtest.me|istio-ingress|grafana-tls
copilot.localtest.me|istio-ingress|copilot-tls
specialist.localtest.me|istio-ingress|specialist-tls
mcp-ops.localtest.me|istio-ingress|mcp-ops-tls
mcp-observability.localtest.me|istio-ingress|mcp-observability-tls
mcp-gateway.localtest.me|istio-ingress|mcp-gateway-tls
"

while IFS='|' read -r host ns secret; do
  [[ -z "$host" ]] && continue
  cert="$CERT_DIR/$host.pem"
  key="$CERT_DIR/$host-key.pem"
  if [[ ! -f "$cert" || ! -f "$key" ]]; then
    echo "skip $host (no cert at $cert — run 'make certs' first)"
    continue
  fi
  kubectl create namespace "$ns" --dry-run=client -o yaml | kubectl apply -f -
  kubectl -n "$ns" create secret tls "$secret" \
    --cert="$cert" --key="$key" \
    --dry-run=client -o yaml | kubectl apply -f -
  echo "✓ $ns/$secret"
done <<< "$ENTRIES"
