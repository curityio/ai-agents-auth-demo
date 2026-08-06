#!/usr/bin/env bash
# tools-check.sh — verify required CLIs are installed at acceptable versions.
set -euo pipefail

declare -a missing=()
declare -a warnings=()

want() {
  local name="$1"
  local hint="$2"
  if ! command -v "$name" >/dev/null 2>&1; then
    missing+=("$name — $hint")
    return 1
  fi
  return 0
}

want node       "install Node 22+ (https://nodejs.org or via volta/asdf)"          || true
want pnpm       "enable via corepack: corepack enable pnpm && corepack prepare pnpm@9.15.0 --activate" || true
want docker     "install Docker Desktop or OrbStack"                                || true
want kind       "brew install kind"                                                 || true
want kubectl    "brew install kubectl"                                              || true
want helm       "brew install helm"                                                 || true
want mkcert     "brew install mkcert"                                               || true

if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  # 22, not 20: Node 20 reached end-of-life on 2026-04-30 (no further security
  # patches), and the app images build on node:22-bookworm-slim. Keeping the local
  # floor at 20 would let a developer run against APIs the containers do not have,
  # while @types/node (^22) already types them as present.
  if [[ "$node_major" -lt 22 ]]; then
    missing+=("node >=22 required (found $(node -v)); Node 20 went EOL 2026-04-30")
  fi
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_major="$(pnpm -v | cut -d. -f1)"
  if [[ "$pnpm_major" -lt 9 ]]; then
    warnings+=("pnpm 9+ recommended (found $(pnpm -v))")
  fi
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo "Missing required tools:"
  for m in "${missing[@]}"; do
    echo "  - $m"
  done
  exit 1
fi

if [[ ${#warnings[@]} -gt 0 ]]; then
  echo "Warnings:"
  for w in "${warnings[@]}"; do
    echo "  - $w"
  done
fi

echo "All required tools present."
