#!/usr/bin/env bash
# Contract test: the pieces that make the gateway's RFC 9728 document REAL and
# REACHABLE all exist. Each was a bug first — the gateway's 401 advertised a
# well-known URL that its own routes did not match and that no edge host served.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
fail=0
check() { # $1 description, $2 file, $3 fixed-string
  if grep -qF -- "$3" "$REPO_ROOT/$2"; then green "OK   $1"; else red "FAIL $1 ($2 lacks: $3)"; fail=1; fi
}

CFG=k8s/workloads/agentgateway-config.yaml
check "gateway routes the observability well-known path" "$CFG" "exact: /.well-known/oauth-protected-resource/observability/mcp"
check "gateway routes the ops well-known path"           "$CFG" "exact: /.well-known/oauth-protected-resource/ops/mcp"
check "ops PRM advertises acr_values_supported"          "$CFG" "acrValuesSupported:"
# agentgateway (v1.4.1, still v1.5.0) hard-codes an informational, non-RFC-9728
# `mcp_protocol_version: 2025-06-18` into the PRM; configured keys win, so both
# routes state the revision the gateway actually negotiates (fact #26).
if [ "$(grep -c 'mcpProtocolVersion: "2026-07-28"' "$REPO_ROOT/$CFG")" = 2 ]; then
  green "OK   both PRMs override mcp_protocol_version to 2026-07-28"
else
  red "FAIL both resourceMetadata blocks must set mcpProtocolVersion: \"2026-07-28\""; fail=1
fi
check "edge Gateway serves mcp-gateway.localtest.me"     k8s/istio/gateway-edge.yaml "- mcp-gateway.localtest.me"
check "edge routes the host to the gateway Service"      k8s/istio/gateway-edge.yaml "host: agentgateway.mcp.svc.cluster.local"
check "mkcert issues the host's cert"                    scripts/mkcert-bootstrap.sh '"mcp-gateway.localtest.me"'
check "TLS secret is applied at the edge"                scripts/apply-tls-secrets.sh "mcp-gateway.localtest.me|istio-ingress|mcp-gateway-tls"
check "routing aliases the host into pods"               scripts/cluster-routing.sh '"mcp-gateway.localtest.me"'
check "Makefile knows the host"                          Makefile "HOST_MCP_GATEWAY"

# The agents must call the SAME URL the PRM advertises (RFC 9728 §3.3).
for f in k8s/workloads/agent-copilot.yaml k8s/workloads/agent-specialist.yaml; do
  check "$f calls the gateway by its public name" "$f" "value: https://mcp-gateway.localtest.me/"
  if grep -qE 'CURITY_TOKEN_ENDPOINT|MCP_(OPS|OBSERVABILITY)_SCOPE|MCP_OPS_(RESOURCE_)?METADATA_URL' "$REPO_ROOT/$f"; then
    red "FAIL $f still carries static discovery config"; fail=1
  else
    green "OK   $f carries no static discovery config"
  fi
done

# cluster-routing must alias the host for the THREE pods that resolve it.
for who in "web/web" "agents/agent-copilot" "agents/agent-specialist"; do
  if awk '/^extra_hosts_for\(\)/,/^}/' "$REPO_ROOT/scripts/cluster-routing.sh" | grep -qF "$who"; then
    green "OK   cluster-routing aliases extra hosts for $who"
  else
    red "FAIL cluster-routing extra_hosts_for lacks $who"; fail=1
  fi
done

exit $fail
