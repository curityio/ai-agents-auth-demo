#!/usr/bin/env bash
# Contract test for scripts/embed-curity-theme.sh: the two theme CSS sources are
# embedded as Base64 into exactly the two leaves of <default-theme>, the
# operation is idempotent, and a configmap without the block fails loudly
# instead of being silently left unchanged.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
fail() { red "FAIL: $*"; exit 1; }

mkdir -p "$TMP/theme"
printf ':root {\n  --color-spot: #c084fc;\n}\n' > "$TMP/theme/theme.css"
printf 'body { background: black; }\n' > "$TMP/theme/custom.css"

cat > "$TMP/configmap.yaml" <<'YAML'
data:
  curity-config.xml: |
    <config>
      <environment>
        <themes>
          <default-theme>
            <theme-css-properties>OLD</theme-css-properties>
            <theme-custom-css>OLD</theme-custom-css>
            <template-variables>
              <name>_configured_body_background</name>
              <value>body-dark</value>
            </template-variables>
          </default-theme>
        </themes>
      </environment>
    </config>
YAML

want_props="$(base64 < "$TMP/theme/theme.css" | tr -d '\n')"
want_custom="$(base64 < "$TMP/theme/custom.css" | tr -d '\n')"

CONFIGMAP="$TMP/configmap.yaml" THEME_DIR="$TMP/theme" \
  bash "$REPO_ROOT/scripts/embed-curity-theme.sh" >/dev/null

grep -q "<theme-css-properties>$want_props</theme-css-properties>" "$TMP/configmap.yaml" \
  || fail "theme-css-properties was not replaced with the Base64 of theme.css"
grep -q "<theme-custom-css>$want_custom</theme-custom-css>" "$TMP/configmap.yaml" \
  || fail "theme-custom-css was not replaced with the Base64 of custom.css"
grep -q "<value>body-dark</value>" "$TMP/configmap.yaml" \
  || fail "template-variables were disturbed"
grep -q "OLD" "$TMP/configmap.yaml" && fail "a stale leaf survived"

cp "$TMP/configmap.yaml" "$TMP/first.yaml"
CONFIGMAP="$TMP/configmap.yaml" THEME_DIR="$TMP/theme" \
  bash "$REPO_ROOT/scripts/embed-curity-theme.sh" >/dev/null
diff -q "$TMP/first.yaml" "$TMP/configmap.yaml" >/dev/null || fail "second run was not idempotent"

printf '<config><environment/></config>\n' > "$TMP/no-block.yaml"
if CONFIGMAP="$TMP/no-block.yaml" THEME_DIR="$TMP/theme" \
  bash "$REPO_ROOT/scripts/embed-curity-theme.sh" >/dev/null 2>&1; then
  fail "a configmap without <default-theme> should be rejected"
fi

green "OK: embed-curity-theme embeds both leaves, is idempotent, and fails closed"
