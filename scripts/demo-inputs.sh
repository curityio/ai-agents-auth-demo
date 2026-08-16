#!/usr/bin/env bash
# Gather the only interactive inputs UP FRONT so `make demo` can then run the
# long platform install + seeding unattended:
#   1. the Curity license file (./license.json)
#   2. the LLM provider + API key for the agent LLM (one of openai, anthropic,
#      gemini, azure; azure additionally needs AZURE_OPENAI_ENDPOINT)
#
# Make runs each recipe line in its own shell, so prompted values can't be handed
# to a later target directly. We persist the LLM inputs to a gitignored .demo.env
# that `scripts/render-gateway-config.sh` and `make seed-llm-secret` consume. The
# license stays a plain ./license.json that `make seed-license` reads. Both are
# gitignored local credentials.
set -euo pipefail

LICENSE="${LICENSE_FILE:-license.json}"
ENV_FILE="${DEMO_ENV_FILE:-.demo.env}"
VALID_PROVIDERS="openai anthropic gemini azure"

# 1. Curity license -----------------------------------------------------------
if [[ -f "$LICENSE" ]]; then
  echo "==> Found $LICENSE — it will be installed as the curity-license secret."
else
  echo "==> No $LICENSE found in the repo root ($(pwd))."
  echo "    Copy your Curity developer license there, e.g.:"
  echo "      cp /path/to/your/curity-license.json $(pwd)/$LICENSE"
  while [[ ! -f "$LICENSE" ]]; do
    read -r -p "    Press Enter once $LICENSE is in place (Ctrl-C to abort)... " _ || exit 1
  done
  echo "==> Found $LICENSE."
fi

# 2. LLM provider + credentials ------------------------------------------------
# Reuse an existing .demo.env VERBATIM if it already carries a usable
# credential — this file may be one the user hand-wrote from
# .demo.env.example with their own LLM_PROVIDER/LLM_MODEL choice, and this
# script must never truncate or overwrite it.
existing_provider=""
existing_key=""
existing_endpoint=""
existing_azure_key=""
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE" 2>/dev/null || true
  existing_provider="${LLM_PROVIDER:-}"
  existing_key="${LLM_API_KEY:-}"
  existing_endpoint="${AZURE_OPENAI_ENDPOINT:-}"
  existing_azure_key="${AZURE_OPENAI_API_KEY:-}"
fi

if [[ -n "$existing_key" ]]; then
  echo "==> Reusing LLM credentials from $ENV_FILE — provider=${existing_provider:-azure} (delete it to re-enter)."
  exit 0
fi

# Back-compat: a .demo.env written before providers were pluggable only ever
# had AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY (no LLM_PROVIDER/LLM_API_KEY
# at all). Reuse that too, exactly as before this feature.
if [[ -n "$existing_endpoint" && -n "$existing_azure_key" ]]; then
  echo "==> Reusing Azure OpenAI creds from $ENV_FILE (delete it to re-enter)."
  exit 0
fi

read -r -p "LLM_PROVIDER [openai|anthropic|gemini|azure] (default azure): " provider
provider="$(printf '%s' "${provider:-azure}" | tr '[:upper:]' '[:lower:]')"
case " $VALID_PROVIDERS " in
  *" $provider "*) ;;
  *)
    echo "Unknown LLM_PROVIDER '$provider' (expected one of: $VALID_PROVIDERS)" >&2
    exit 1
    ;;
esac

# `read -s` echoes nothing, so a half-pasted or empty-clipboard key looks exactly
# like a correct one until the gateway 401s much later. Strip stray whitespace (a
# trailing newline is the usual clipboard artefact) and confirm what landed, with
# enough of the key visible to recognise it but not enough to be worth reading out
# of terminal scrollback.
read -r -s -p "LLM_API_KEY: " key; echo
key="$(printf '%s' "$key" | tr -d '[:space:]')"
[[ -n "$key" ]] || { echo "LLM_API_KEY empty — abort" >&2; exit 1; }
key_len=${#key}
if [[ "$key_len" -ge 12 ]]; then
  key_masked="${key:0:2}$(printf '%*s' "$((key_len - 6))" '' | tr ' ' '*')${key: -4}"
else
  key_masked="$(printf '%*s' "$key_len" '' | tr ' ' '*')"
fi
echo "    got $key_masked ($key_len chars)"
# Every provider we support issues keys far longer than this; a short one is
# almost always a truncated paste, and it is much cheaper to question it here
# than to debug a 401 after the whole cluster is up.
if [[ "$key_len" -lt 20 ]]; then
  echo "    WARNING: that is short for an API key — check the paste was complete." >&2
fi

endpoint=""
if [[ "$provider" == "azure" ]]; then
  read -r -p "AZURE_OPENAI_ENDPOINT (e.g. https://<resource>.openai.azure.com): " endpoint
  [[ -n "$endpoint" ]] || { echo "AZURE_OPENAI_ENDPOINT empty — abort" >&2; exit 1; }
fi

# Default model per provider — MUST agree with scripts/render-gateway-config.sh
# (which applies the same defaults when LLM_MODEL is empty at render time).
case "$provider" in
  openai)    default_model=gpt-4.1 ;;
  anthropic) default_model=claude-sonnet-4-6 ;;
  gemini)    default_model=gemini-2.5-pro ;;
  azure)     default_model=gpt-4.1 ;;
esac
read -r -p "LLM_MODEL (default $default_model): " model
model="${model:-$default_model}"

# Endpoints are URLs, keys are opaque vendor tokens, and the model is a short
# identifier — none contain shell metacharacters — so a plain KEY=value file is
# safe to `source`. Written 0600 (umask) since it holds a key.
(
  umask 077
  {
    echo "LLM_PROVIDER=$provider"
    echo "LLM_MODEL=$model"
    echo "LLM_API_KEY=$key"
    if [[ "$provider" == "azure" ]]; then
      echo "AZURE_OPENAI_ENDPOINT=$endpoint"
    fi
  } > "$ENV_FILE"
)
echo "==> Saved LLM credentials to $ENV_FILE (gitignored) — provider=$provider model=$model."
