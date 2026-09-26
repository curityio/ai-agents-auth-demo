#!/usr/bin/env bash
# Contract tests for scripts/render-gateway-config.sh.
#
# Goldens: `azure` against an openai.azure.com endpoint reproduces the llm route
# as deployed on 2026-08-14 (that fixture has not changed since, which is the
# evidence the Foundry work is behaviour-preserving for Azure OpenAI), and a
# Foundry project endpoint matches its own fixture.
# Cases: endpoint parsing, the LLM_PROVIDER allow-list, and the per-resource-type
# default model.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURES="$REPO_ROOT/tests/fixtures"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

WORK="$TMP/repo"
mkdir -p "$WORK/scripts" "$WORK/k8s/workloads"
cp "$REPO_ROOT/scripts/render-gateway-config.sh" "$WORK/scripts/"
cp "$REPO_ROOT/k8s/workloads/agentgateway-config.yaml" "$WORK/k8s/workloads/"
cp -R "$REPO_ROOT/k8s/workloads/llm-providers" "$WORK/k8s/workloads/"

failed=0

# render LINE... — writes the lines as .demo.env and renders. Sets RENDER_RC and
# RENDER_OUT. -u the three provider env vars: an exported value in the caller's
# environment would otherwise outrank the controlled .demo.env (env-beats-file
# precedence) and silently test something else.
render() {
  printf '%s\n' "$@" > "$WORK/.demo.env"
  rm -f "$WORK/.gen/agentgateway-config.yaml"
  if RENDER_OUT="$(env -u LLM_PROVIDER -u LLM_MODEL -u AZURE_OPENAI_ENDPOINT \
      bash "$WORK/scripts/render-gateway-config.sh" 2>&1)"; then
    RENDER_RC=0
  else
    RENDER_RC=$?
  fi
}

# The rendered region between the sentinels.
region() {
  sed -n '/# BEGIN_LLM_PROVIDER/,/# END_LLM_PROVIDER/p' "$WORK/.gen/agentgateway-config.yaml" \
    | sed '1d;$d'
}

# golden NAME FIXTURE LINE...
golden() {
  local name="$1" fixture="$2"
  shift 2
  render "$@"
  if [ "$RENDER_RC" -ne 0 ]; then
    red "FAIL $name: render exited $RENDER_RC"
    printf '%s\n' "$RENDER_OUT" | sed 's/^/       /'
    failed=1
    return 0
  fi
  grep -v '^#' "$FIXTURES/$fixture" | sed '/^$/d' > "$TMP/expected.yaml"
  region > "$TMP/actual.yaml"
  if diff -u "$TMP/expected.yaml" "$TMP/actual.yaml"; then
    green "OK   $name"
  else
    red "FAIL $name: drifted from tests/fixtures/$fixture"
    failed=1
  fi
}

# refused NAME EXPECTED_MESSAGE LINE... — render must fail AND say why.
refused() {
  local name="$1" message="$2"
  shift 2
  render "$@"
  if [ "$RENDER_RC" -ne 0 ] && printf '%s' "$RENDER_OUT" | grep -qF -- "$message"; then
    green "OK   $name"
  else
    red "FAIL $name: expected a refusal containing '$message' (rc=$RENDER_RC)"
    printf '%s\n' "$RENDER_OUT" | sed 's/^/       /'
    failed=1
  fi
}

# renders_model NAME MODEL LINE... — render succeeds with that model pinned.
renders_model() {
  local name="$1" model="$2"
  shift 2
  render "$@"
  if [ "$RENDER_RC" -eq 0 ] && region | grep -qE "^ +model: ${model}\$"; then
    green "OK   $name"
  else
    red "FAIL $name: expected model $model (rc=$RENDER_RC)"
    printf '%s\n' "$RENDER_OUT" | sed 's/^/       /'
    failed=1
  fi
}

OPENAI_EP=https://my-azure-resource.openai.azure.com
FOUNDRY_EP=https://my-foundry-resource.services.ai.azure.com/api/projects/my-project

# --- goldens ---------------------------------------------------------------
golden "azure / Azure OpenAI endpoint" llm-route-azure-openai.expected.yaml \
  LLM_PROVIDER=azure LLM_MODEL=gpt-4.1 "AZURE_OPENAI_ENDPOINT=$OPENAI_EP"
golden "azure / Azure OpenAI endpoint, trailing slash" llm-route-azure-openai.expected.yaml \
  LLM_PROVIDER=azure LLM_MODEL=gpt-4.1 "AZURE_OPENAI_ENDPOINT=$OPENAI_EP/"
golden "azure / Azure OpenAI endpoint, mixed-case host" llm-route-azure-openai.expected.yaml \
  LLM_PROVIDER=azure LLM_MODEL=gpt-4.1 "AZURE_OPENAI_ENDPOINT=https://My-Azure-Resource.OpenAI.Azure.com"
golden "legacy .demo.env (AZURE_* only) still renders Azure OpenAI" llm-route-azure-openai.expected.yaml \
  "AZURE_OPENAI_ENDPOINT=$OPENAI_EP" AZURE_OPENAI_API_KEY=legacy-key
golden "azure / Foundry project endpoint" llm-route-azure-foundry.expected.yaml \
  LLM_PROVIDER=azure LLM_MODEL=claude-sonnet-4-6 "AZURE_OPENAI_ENDPOINT=$FOUNDRY_EP"
golden "azure / Foundry project endpoint, trailing slash" llm-route-azure-foundry.expected.yaml \
  LLM_PROVIDER=azure LLM_MODEL=claude-sonnet-4-6 "AZURE_OPENAI_ENDPOINT=$FOUNDRY_EP/"

# --- refusals --------------------------------------------------------------
refused "Foundry resource URL without a project" "needs the PROJECT endpoint" \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=https://my-foundry-resource.services.ai.azure.com"
refused "Foundry project URL with extra path segments" "needs the PROJECT endpoint" \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=$FOUNDRY_EP/openai/v1"
refused "cognitiveservices.azure.com endpoint (what az ... show prints)" "AZURE_OPENAI_ENDPOINT must be" \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=https://my-foundry-resource.cognitiveservices.azure.com/"
refused "non-Azure host" "AZURE_OPENAI_ENDPOINT must be" \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=https://example.com"
refused "plain http" "AZURE_OPENAI_ENDPOINT must be" \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=http://my-azure-resource.openai.azure.com"
refused "Azure OpenAI endpoint with a path" "without a path" \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=$OPENAI_EP/openai/deployments/gpt-4.1"
refused "missing endpoint" "needs AZURE_OPENAI_ENDPOINT" \
  LLM_PROVIDER=azure
refused "internal fragment name azure-foundry is not a provider" "unknown LLM_PROVIDER" \
  LLM_PROVIDER=azure-foundry "AZURE_OPENAI_ENDPOINT=$FOUNDRY_EP"
refused "internal fragment name azure-openai is not a provider" "unknown LLM_PROVIDER" \
  LLM_PROVIDER=azure-openai "AZURE_OPENAI_ENDPOINT=$OPENAI_EP"

# --- default model ---------------------------------------------------------
renders_model "Foundry defaults to claude-sonnet-4-6" claude-sonnet-4-6 \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=$FOUNDRY_EP"
renders_model "Azure OpenAI defaults to gpt-4.1" gpt-4.1 \
  LLM_PROVIDER=azure "AZURE_OPENAI_ENDPOINT=$OPENAI_EP"
renders_model "Foundry honours an explicit GPT deployment" gpt-4.1 \
  LLM_PROVIDER=azure LLM_MODEL=gpt-4.1 "AZURE_OPENAI_ENDPOINT=$FOUNDRY_EP"
renders_model "anthropic still renders (allow-list regression guard)" claude-sonnet-4-6 \
  LLM_PROVIDER=anthropic

# The rendered config keeps the tracing fields that name a DENIED tool call. The
# HTTP-layer `authorization` rule refuses before the MCP layer runs, so the red
# gateway span has no `gen_ai.tool.name`; these captured headers are the only
# record of which tool / namespace was refused (CLAUDE.md fact #29).
render LLM_PROVIDER=anthropic
for field in \
  "http.request.header.mcp-name: 'request.headers[\"mcp-name\"]'" \
  "http.request.header.mcp-param-namespace: 'request.headers[\"mcp-param-namespace\"]'"; do
  if [ "$RENDER_RC" -eq 0 ] && grep -qF -- "$field" "$WORK/.gen/agentgateway-config.yaml"; then
    green "OK   tracing records ${field%%:*}"
  else
    red "FAIL rendered config lacks tracing field: $field (rc=$RENDER_RC)"
    failed=1
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  red "render-gateway-config contract tests FAILED"
  exit 1
fi
green "render-gateway-config contract tests passed"
