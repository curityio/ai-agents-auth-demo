#!/usr/bin/env bash
# Contract tests for scripts/demo-inputs.sh: an LLM configuration the gateway
# render would refuse must be refused HERE, at the prompt (or when an existing
# .demo.env is reused), not at `make apply` — the last `make demo` phase, after
# the cluster has been built.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# A throwaway tree, so the render script never sources the developer's own
# .demo.env (it holds a real key) and never writes the real .gen/.
WORK="$TMP/repo"
mkdir -p "$WORK/scripts" "$WORK/k8s/workloads"
cp "$REPO_ROOT/scripts/demo-inputs.sh" "$REPO_ROOT/scripts/render-gateway-config.sh" "$WORK/scripts/"
cp "$REPO_ROOT/k8s/workloads/agentgateway-config.yaml" "$WORK/k8s/workloads/"
cp -R "$REPO_ROOT/k8s/workloads/llm-providers" "$WORK/k8s/workloads/"
touch "$WORK/license.json"
ENV_FILE="$TMP/test.env"

failed=0
KEY=fake-key-0123456789abcdefghij
FOUNDRY_EP=https://r.services.ai.azure.com/api/projects/p

# run STDIN — runs demo-inputs from the throwaway tree; sets RC and OUT.
run() {
  if OUT="$(cd "$WORK" && printf '%b' "$1" \
      | env -u LLM_PROVIDER -u LLM_MODEL -u LLM_API_KEY -u AZURE_OPENAI_ENDPOINT -u AZURE_OPENAI_API_KEY \
        LICENSE_FILE=license.json DEMO_ENV_FILE="$ENV_FILE" bash scripts/demo-inputs.sh 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
}

# expect NAME WANT_RC MESSAGE — MESSAGE must appear in the output.
expect() {
  if [ "$RC" -eq "$2" ] && printf '%s' "$OUT" | grep -qF -- "$3"; then
    green "OK   $1"
  else
    red "FAIL $1 (rc=$RC, want $2 and '$3')"
    printf '%s\n' "$OUT" | sed 's/^/       /'
    failed=1
  fi
}

rm -f "$ENV_FILE"
run "azure\n$KEY\nhttps://r.cognitiveservices.azure.com/\n\n"
expect "prompt refuses the cognitiveservices endpoint az ... show prints" 1 "AZURE_OPENAI_ENDPOINT must be"
if [ -e "$ENV_FILE" ]; then red "FAIL refused input must not be saved"; failed=1; else green "OK   refused input is not saved"; fi

run "azure\n$KEY\n$FOUNDRY_EP/openai/v1\n\n"
expect "prompt refuses a Foundry URL with extra path segments" 1 "needs the PROJECT endpoint"

run "azure\n$KEY\n$FOUNDRY_EP\n\n"
expect "prompt accepts a Foundry project endpoint" 0 "model=claude-sonnet-4-6"

# Reuse path: the file just written is valid and reused verbatim.
run ""
expect "valid .demo.env is reused" 0 "Reusing LLM credentials"

printf 'LLM_PROVIDER=azure\nLLM_MODEL=gpt-4.1\nLLM_API_KEY=%s\nAZURE_OPENAI_ENDPOINT=https://r.cognitiveservices.azure.com/\n' "$KEY" > "$ENV_FILE"
run ""
expect "reused .demo.env with an unrenderable endpoint is refused" 1 "AZURE_OPENAI_ENDPOINT must be"

printf 'AZURE_OPENAI_ENDPOINT=https://r.openai.azure.com\nAZURE_OPENAI_API_KEY=%s\n' "$KEY" > "$ENV_FILE"
run ""
expect "legacy AZURE_*-only .demo.env is still reused" 0 "Reusing Azure OpenAI creds"

printf 'LLM_PROVIDER=anthropic\nLLM_MODEL=claude-sonnet-4-6\nLLM_API_KEY=%s\n' "$KEY" > "$ENV_FILE"
run ""
expect "non-azure .demo.env is reused" 0 "Reusing LLM credentials"

[ ! -e "$WORK/.gen/agentgateway-config.yaml" ] && green "OK   the check writes no rendered config" \
  || { red "FAIL the check wrote .gen/agentgateway-config.yaml"; failed=1; }

echo
if [ "$failed" -ne 0 ]; then
  red "demo-inputs contract tests FAILED"
  exit 1
fi
green "demo-inputs contract tests passed"
