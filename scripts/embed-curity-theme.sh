#!/usr/bin/env bash
# Embed the Curity UI theme sources (k8s/curity/theme/*.css) as Base64 into the
# <themes><default-theme> block of k8s/curity/configmap.yaml.
#
# Curity 11's theme is config-native: `theme-css-properties` is a `:root {}` sheet
# of the CSS custom properties that curity-theme.css defines, and
# `theme-custom-css` is free-form CSS appended after it. Both leaves are
# Base64 in the XML schema, so — exactly like the token procedures — edit the
# .css files and let this script (run by `make apply`) write the Base64.
set -euo pipefail

CONFIGMAP="${CONFIGMAP:-k8s/curity/configmap.yaml}"
THEME_DIR="${THEME_DIR:-k8s/curity/theme}"

# embed_leaf <leaf-name> <css-file>
embed_leaf() {
  local leaf="$1" file="$2" b64
  b64=$(base64 < "$file" | tr -d '\n')
  python3 - "$CONFIGMAP" "$leaf" "$b64" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
leaf = sys.argv[2]
b64 = sys.argv[3]
src = path.read_text()
# The leaf must sit inside <default-theme> … </default-theme>; custom themes
# (if any are ever added) carry the same leaf names and must not be touched.
block = re.compile(r"(<default-theme>.*?</default-theme>)", re.DOTALL)
leaf_re = re.compile(r"(<" + re.escape(leaf) + r">)[^<]*(</" + re.escape(leaf) + r">)")
blocks = block.findall(src)
if len(blocks) != 1:
    print(f"expected exactly one <default-theme> block in {path}, found {len(blocks)}", file=sys.stderr)
    sys.exit(2)
new_block, n = leaf_re.subn(r"\g<1>" + b64 + r"\g<2>", blocks[0])
if n != 1:
    print(f"could not locate <{leaf}> inside <default-theme> in {path} (matched {n} times)", file=sys.stderr)
    sys.exit(2)
path.write_text(src.replace(blocks[0], new_block, 1))
PY
}

embed_leaf theme-css-properties "$THEME_DIR/theme.css"
echo "embedded theme.css  -> $CONFIGMAP (theme-css-properties)"
embed_leaf theme-custom-css "$THEME_DIR/custom.css"
echo "embedded custom.css -> $CONFIGMAP (theme-custom-css)"
