#!/usr/bin/env bash
# Golden test: rendering `azure` reproduces the llm route as deployed on
# 2026-08-14, modulo the three intended substitutions recorded in the fixture.
#
# Azure is the only provider that can be driven end to end here, and it is also
# the one being refactored out of the tracked config — so this comparison is the
# evidence that the refactor is behaviour-preserving.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED="$REPO_ROOT/tests/fixtures/llm-route-azure.expected.yaml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# Render with an explicit environment rather than the developer's .demo.env.
cat > "$TMP/.demo.env" <<'EOF'
LLM_PROVIDER=azure
LLM_MODEL=gpt-4.1
AZURE_OPENAI_ENDPOINT=https://my-azure-resource.openai.azure.com
EOF

WORK="$TMP/repo"
mkdir -p "$WORK/scripts" "$WORK/k8s/workloads"
cp "$REPO_ROOT/scripts/render-gateway-config.sh" "$WORK/scripts/"
cp "$REPO_ROOT/k8s/workloads/agentgateway-config.yaml" "$WORK/k8s/workloads/"
cp -R "$REPO_ROOT/k8s/workloads/llm-providers" "$WORK/k8s/workloads/"
cp "$TMP/.demo.env" "$WORK/.demo.env"

# -u the three provider env vars: an exported LLM_PROVIDER/LLM_MODEL/
# AZURE_OPENAI_ENDPOINT in the caller's environment would otherwise outrank
# the controlled .demo.env above (env-beats-file precedence), silently
# rendering something other than azure and defeating this golden test.
env -u LLM_PROVIDER -u LLM_MODEL -u AZURE_OPENAI_ENDPOINT \
  bash "$WORK/scripts/render-gateway-config.sh" >/dev/null

# Extract the rendered region between the sentinels.
sed -n '/# BEGIN_LLM_PROVIDER/,/# END_LLM_PROVIDER/p' "$WORK/.gen/agentgateway-config.yaml" \
  | sed '1d;$d' > "$TMP/actual.yaml"

# Compare against the fixture, ignoring its comment header.
grep -v '^#' "$EXPECTED" | sed '/^$/d' > "$TMP/expected.yaml"

if diff -u "$TMP/expected.yaml" "$TMP/actual.yaml"; then
  green "OK: azure render matches the deployed llm route"
else
  red "FAIL: azure render drifted from tests/fixtures/llm-route-azure.expected.yaml"
  exit 1
fi
