#!/usr/bin/env bash
# Gather the only two interactive inputs UP FRONT so `make demo` can then run the
# long platform install + seeding unattended:
#   1. the Curity license file (./license.json)
#   2. the Azure OpenAI endpoint + API key for the agent LLM
#
# Make runs each recipe line in its own shell, so prompted values can't be handed
# to a later target directly. We persist the Azure creds to a gitignored .demo.env
# that `make seed-llm-secret` consumes. The license stays a plain ./license.json
# that `make seed-license` reads. Both are gitignored local credentials.
set -euo pipefail

LICENSE="${LICENSE_FILE:-license.json}"
ENV_FILE="${DEMO_ENV_FILE:-.demo.env}"

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

# 2. Azure OpenAI creds -------------------------------------------------------
# Reuse an existing .demo.env if it already carries both values (re-run friendly).
existing_endpoint=""
existing_key=""
if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE" 2>/dev/null || true
  existing_endpoint="${AZURE_OPENAI_ENDPOINT:-}"
  existing_key="${AZURE_OPENAI_API_KEY:-}"
fi

if [[ -n "$existing_endpoint" && -n "$existing_key" ]]; then
  echo "==> Reusing Azure OpenAI creds from $ENV_FILE (delete it to re-enter)."
  exit 0
fi

read -r -p "AZURE_OPENAI_ENDPOINT (e.g. https://<resource>.openai.azure.com): " endpoint
[[ -n "$endpoint" ]] || { echo "AZURE_OPENAI_ENDPOINT empty — abort" >&2; exit 1; }
read -r -s -p "AZURE_OPENAI_API_KEY: " key; echo
[[ -n "$key" ]] || { echo "AZURE_OPENAI_API_KEY empty — abort" >&2; exit 1; }

# Endpoints are URLs and keys are alphanumeric — no shell metacharacters — so a
# plain KEY=value file is safe to `source`. Written 0600 (umask) since it holds a key.
( umask 077; cat > "$ENV_FILE" <<EOF
AZURE_OPENAI_ENDPOINT=$endpoint
AZURE_OPENAI_API_KEY=$key
EOF
)
echo "==> Saved Azure OpenAI creds to $ENV_FILE (gitignored)."
