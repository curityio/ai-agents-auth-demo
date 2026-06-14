#!/usr/bin/env bash
# Embed k8s/curity/procedures/*.js (Base64) into k8s/curity/configmap.yaml.
# The Curity XML schema requires the script body as Base64 text inside <script>.

set -euo pipefail

CONFIGMAP="k8s/curity/configmap.yaml"
PROC_DIR="k8s/curity/procedures"

# embed_procedure <id> <js-file> [element]
# element defaults to token-procedure; pass transformation-procedure for those.
embed_procedure() {
  local proc_id="$1" proc_file="$2" elem="${3:-token-procedure}"
  local b64
  b64=$(base64 < "$proc_file" | tr -d '\n')
  # Replace the inner <script>...</script> for the named procedure block.
  # Match conservatively to a single block by <id>.
  python3 - "$CONFIGMAP" "$proc_id" "$b64" "$elem" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
proc_id = sys.argv[2]
b64 = sys.argv[3]
elem = sys.argv[4]
src = path.read_text()
# assumes no nested child elements between <id> and <script>
pattern = re.compile(
    r"(<" + re.escape(elem) + r">\s*<id>" + re.escape(proc_id) + r"</id>\s*(?:<[^>]+>[^<]*</[^>]+>\s*)*?<script>)[^<]*(</script>)",
    re.DOTALL,
)
new, n = pattern.subn(r"\g<1>" + b64 + r"\g<2>", src)
if n != 1:
    print(f"could not locate {elem} id={proc_id} in {path} (matched {n} times)", file=sys.stderr)
    sys.exit(2)
path.write_text(new)
PY
}

embed_procedure spiffe-actor-validation "$PROC_DIR/token-exchange.js"
echo "embedded token-exchange.js -> $CONFIGMAP"

embed_procedure acr-passthrough "$PROC_DIR/authorization-code.js"
echo "embedded authorization-code.js -> $CONFIGMAP"

embed_procedure add-roles "$PROC_DIR/add-roles.js" transformation-procedure
echo "embedded add-roles.js -> $CONFIGMAP"
