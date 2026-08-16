#!/usr/bin/env bash
# Render k8s/workloads/agentgateway-config.yaml with the LLM provider block
# selected by .demo.env, into .gen/agentgateway-config.yaml.
#
# The provider is chosen at config-ASSEMBLY time rather than by an env var at
# gateway runtime because agentgateway expands $VARS in values only — each
# provider is a different YAML key with a different field set, so no amount of
# substitution can switch between them.
#
# Run by `make apply` (always) and `make configure-llm` (after a .demo.env edit).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/k8s/workloads/agentgateway-config.yaml"
FRAG_DIR="$REPO_ROOT/k8s/workloads/llm-providers"
OUT="$REPO_ROOT/.gen/agentgateway-config.yaml"

die() { printf '\033[31mrender-gateway-config: %s\033[0m\n' "$*" >&2; exit 1; }

# Precedence: an explicitly exported variable beats .demo.env. Sourcing the file
# would otherwise clobber `LLM_PROVIDER=openai make configure-llm`, which is the
# obvious way to try a provider without editing the file — and it would fail
# silently, rendering the old provider while appearing to honour the override.
_env_provider="${LLM_PROVIDER:-}"
_env_model="${LLM_MODEL:-}"
_env_endpoint="${AZURE_OPENAI_ENDPOINT:-}"

# shellcheck disable=SC1091
[ -f "$REPO_ROOT/.demo.env" ] && . "$REPO_ROOT/.demo.env"

provider="${_env_provider:-${LLM_PROVIDER:-}}"

# Provider and model are precedence-applied TOGETHER, not independently: if the
# caller overrode the provider via the environment but did NOT also override
# the model, .demo.env's LLM_MODEL is almost certainly a model name for the
# FILE's provider, not the one just requested (e.g. .demo.env has
# azure/gpt-4.1 saved and the caller runs `LLM_PROVIDER=gemini ...`) — pairing
# them would render a mixed provider/model that validates fine and only fails
# at request time with the vendor's "model not found". So drop .demo.env's
# LLM_MODEL in that one case and let the per-provider default below apply.
if [ -n "$_env_provider" ] && [ -z "$_env_model" ]; then
  model=""
else
  model="${_env_model:-${LLM_MODEL:-}}"
fi
AZURE_OPENAI_ENDPOINT="${_env_endpoint:-${AZURE_OPENAI_ENDPOINT:-}}"

# Back-compat: a .demo.env written before this feature only had AZURE_*.
if [ -z "$provider" ] && [ -n "${AZURE_OPENAI_ENDPOINT:-}" ]; then
  provider=azure
fi
# azure is the default: it is the provider this demo is actually developed and
# driven against, and the only one verified end to end (docs/llm-providers.md §3).
# It needs AZURE_OPENAI_ENDPOINT, so an unconfigured tree now fails loudly below
# rather than quietly rendering a provider nobody chose.
provider="$(printf '%s' "${provider:-azure}" | tr '[:upper:]' '[:lower:]')"

# Default model per provider. bash 3.2 on macOS has no associative arrays.
if [ -z "$model" ]; then
  case "$provider" in
    openai)    model=gpt-4.1 ;;
    anthropic) model=claude-sonnet-4-6 ;;
    gemini)    model=gemini-2.5-pro ;;
    azure)     model=gpt-4.1 ;;
  esac
fi

FRAGMENT="$FRAG_DIR/$provider.yaml"
[ -f "$FRAGMENT" ] || die "unknown LLM_PROVIDER '$provider' (expected one of: openai anthropic gemini azure)"
[ -n "$model" ] || die "LLM_MODEL is empty and no default is known for '$provider'"

resource_name=""
if [ "$provider" = "azure" ]; then
  [ -n "${AZURE_OPENAI_ENDPOINT:-}" ] || \
    die "LLM_PROVIDER=azure needs AZURE_OPENAI_ENDPOINT (e.g. https://<resource>.openai.azure.com) in .demo.env"
  resource_name="$(printf '%s' "$AZURE_OPENAI_ENDPOINT" | sed -E 's#https?://([^.]+)\..*#\1#')"
  [ -n "$resource_name" ] || die "could not derive the Azure resource name from '$AZURE_OPENAI_ENDPOINT'"
fi

mkdir -p "$(dirname "$OUT")"

SRC="$SRC" FRAGMENT="$FRAGMENT" OUT="$OUT" MODEL="$model" RESOURCE_NAME="$resource_name" \
python3 - <<'PY'
import os, re, sys

src = open(os.environ["SRC"]).read()
frag = open(os.environ["FRAGMENT"]).read()

# Drop the fragment's leading comment header — it documents the fragment for a
# human reading the file, and repeating it in the rendered output is noise.
body = "\n".join(l for l in frag.splitlines() if not l.lstrip().startswith("#"))
body = body.strip("\n")
body = body.replace("__LLM_MODEL__", os.environ["MODEL"])
body = body.replace("__AZURE_RESOURCE_NAME__", os.environ["RESOURCE_NAME"])

pattern = re.compile(r"( *)# BEGIN_LLM_PROVIDER\n.*?\n( *)# END_LLM_PROVIDER", re.DOTALL)
if not pattern.search(src):
    sys.exit("BEGIN_LLM_PROVIDER / END_LLM_PROVIDER sentinels not found in " + os.environ["SRC"])

def repl(m):
    return f"{m.group(1)}# BEGIN_LLM_PROVIDER\n{body}\n{m.group(2)}# END_LLM_PROVIDER"

open(os.environ["OUT"], "w").write(pattern.sub(repl, src, count=1))
PY

printf '==> rendered %s (provider=%s model=%s)\n' "${OUT#"$REPO_ROOT/"}" "$provider" "$model"
