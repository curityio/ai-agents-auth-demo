#!/usr/bin/env bash
# Render every provider fragment and run it through agentgateway's own config
# validator, using the exact image the demo deploys.
#
# This is the safety net for the three providers that cannot be driven end to end
# here. It is what caught, during design, that `provider: {ollama: {}}` and
# `{groq: {}}` are xDS-only at v1.4.1 and fail standalone config load.
#
# CAVEAT: --validate-only does NOT evaluate CEL (CLAUDE.md fact #29). It proves
# the provider block is well-formed and nothing about the jwtAuth/authorization
# rules, whose expressions are checked only at runtime.
#
# CAVEAT: the rendered config's jwtAuth block points its JWKS URL at an
# in-cluster host (curity.curity.svc.cluster.local) that does not resolve
# outside Kubernetes, so the container may hang on that fetch after schema
# validation has already passed. The whole per-provider docker sequence below
# is therefore time-bounded (see run_bounded), and a timeout or a JWKS/cluster
# -host connection failure is treated as a PASS on the schema question this
# script actually answers: schema parsed; the run got as far as the network
# fetch, which cannot succeed outside the cluster. That is strictly later than
# the schema check we care about here. It is NOT unconditional, though — any
# output that looks like a schema/deserialization error (unknown variant,
# missing field, invalid type, unknown field) is a FAIL regardless of anything
# else in the output, so a real schema break can never be masked by a JWKS
# string appearing incidentally elsewhere.
#
# NOTE ON MECHANISM: this deliberately injects the rendered file with
# `docker create` + `docker cp` + `docker start` instead of a `-v` bind mount.
# Verified 2026-08-14: on this machine `docker run -v <any-path>:/c:ro` hangs
# indefinitely regardless of source path (reproduced with a trivial `alpine`
# container and an empty file, unrelated to this script) — the Docker Desktop
# bind-mount/file-sharing subsystem was wedged after a long-running VM uptime,
# while `docker create`/`cp`/`start`/`rm` all worked instantly. create+cp+start
# validates the byte-identical rendered file through the byte-identical image
# invocation and sidesteps that failure mode entirely, so it is used
# unconditionally rather than only as a fallback.
#
# NOTE ON BOUNDING: the failure that actually stopped a prior run of this
# script was the Docker daemon itself going unresponsive, which can hang
# `docker create` just as easily as `docker start` — so the WHOLE per-provider
# sequence (create, cp, start) is bounded, not just the final step.
#
# NOTE ON PORTABILITY: this script must work on stock macOS, which has no
# `/usr/bin/timeout` (GNU coreutils only; CLAUDE.md: macOS bash 3.2 / BSD
# userland). It prefers `timeout`/`gtimeout` when present, but the fallback
# (a background job + poll loop, see run_bounded) must be correct on its own,
# because that is the path a stock install takes — falling through to it
# silently and getting it wrong would fail every provider on exactly the
# platform this repo targets.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="$(grep -o 'ghcr.io/agentgateway/agentgateway:[^ ]*' "$REPO_ROOT/k8s/workloads/agentgateway.yaml" | head -1)"
PROVIDERS="openai anthropic gemini azure"
DOCKER_TIMEOUT="${DOCKER_TIMEOUT:-30}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note() { printf '==> %s\n' "$*"; }

# Pick a real `timeout` if one exists (GNU coreutils, or Homebrew's
# `gtimeout`); otherwise fall back to a pure bash 3.2 poll loop below. No
# `declare -A`, no `mapfile` — bash 3.2 has neither.
TIMEOUT_BIN=""
for c in timeout gtimeout; do
  if command -v "$c" >/dev/null 2>&1; then
    TIMEOUT_BIN="$c"
    break
  fi
done

# run_bounded SECONDS OUTFILE CMD...
#
# Runs CMD (a real executable plus args — NOT a shell function: `timeout`
# execs it directly via PATH lookup, so a shell function would only work on
# the fallback path, and this must behave identically on both) with combined
# stdout+stderr captured to OUTFILE, bounded to SECONDS. Sets BOUNDED_RC to
# the command's real exit code, or 124 (matching GNU timeout's convention) if
# it had to be killed for still being alive after SECONDS.
#
# The fallback path backgrounds the job in its own process group (`set -m`)
# so that on timeout we can kill the whole group — CMD here is `bash -c
# <docker sequence>`, which itself forks docker CLI subprocesses, and killing
# only the wrapper process would leave those running.
run_bounded() {
  local secs="$1" outfile="$2"
  shift 2

  if [ -n "$TIMEOUT_BIN" ]; then
    # Under `set -e` a bare failing command aborts the script before the next
    # line can read $? — the `if` form is exempt, so use it purely to capture
    # the real exit code without tripping -e.
    if "$TIMEOUT_BIN" "$secs" "$@" >"$outfile" 2>&1; then
      BOUNDED_RC=0
    else
      BOUNDED_RC=$?
    fi
    return 0
  fi

  local was_m=0
  case "$-" in *m*) was_m=1 ;; esac
  set -m
  ( "$@" ) >"$outfile" 2>&1 &
  local pid=$!
  [ "$was_m" -eq 1 ] || set +m

  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$secs" ]; then
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
      # Detach the job before it dies so bash's own job-control notification
      # ("Terminated: 15") doesn't get printed to the script's stderr and mix
      # into the pass/fail output below. macOS bash 3.2's `disown` accepts
      # only jobspecs, not PIDs (`disown "$pid"` is a silent no-op there) — use
      # `%%` (the current job, i.e. the one just backgrounded above) instead.
      disown %% 2>/dev/null || true
      sleep 1
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      BOUNDED_RC=124
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  if wait "$pid"; then
    BOUNDED_RC=0
  else
    BOUNDED_RC=$?
  fi
  return 0
}

note "validating against $IMAGE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

WORK="$TMP/repo"
mkdir -p "$WORK/scripts" "$WORK/k8s/workloads"
cp "$REPO_ROOT/scripts/render-gateway-config.sh" "$WORK/scripts/"
cp "$REPO_ROOT/k8s/workloads/agentgateway-config.yaml" "$WORK/k8s/workloads/"
cp -R "$REPO_ROOT/k8s/workloads/llm-providers" "$WORK/k8s/workloads/"

# The per-provider docker sequence, as a command string rather than a shell
# function: `run_bounded` may hand it to the real `timeout`/`gtimeout` binary,
# which execs its argument via PATH lookup and therefore cannot see shell
# functions — only real executables (`bash` here) work on both the timeout
# path and the fallback poll-loop path alike.
#
# The cid is written to $3 (cidfile) the instant `docker create` returns,
# before `docker cp`/`docker start` run, so cleanup after run_bounded can
# always find and remove the container even if a later step here fails, or
# the whole sequence is killed for running past the timeout.
DOCKER_SEQUENCE='
set -e
image="$1"; gen_dir="$2"; cidfile="$3"
cid=$(docker create -e LLM_API_KEY=dummy "$image" -f /c/agentgateway-config.yaml --validate-only)
printf "%s" "$cid" > "$cidfile"
docker cp "$gen_dir/." "$cid:/c" >/dev/null
docker start -a "$cid"
'

failed=0
for p in $PROVIDERS; do
  cat > "$WORK/.demo.env" <<EOF
LLM_PROVIDER=$p
LLM_MODEL=validation-model
AZURE_OPENAI_ENDPOINT=https://validation-resource.openai.azure.com
EOF
  # -u the three provider env vars: the render script's precedence puts an
  # exported environment above .demo.env, so a caller running with e.g.
  # `LLM_PROVIDER=anthropic make validate-llm` would otherwise render (and
  # "validate") anthropic on all four loop iterations regardless of the
  # controlled .demo.env just written above.
  env -u LLM_PROVIDER -u LLM_MODEL -u AZURE_OPENAI_ENDPOINT \
    bash "$WORK/scripts/render-gateway-config.sh" >/dev/null

  cidfile="$TMP/$p.cid"
  outfile="$TMP/$p.out"
  rm -f "$cidfile" "$outfile"

  # The gateway resolves $VARS at load; supply a dummy so validation reaches
  # the schema rather than stopping at an unset variable. Only LLM_API_KEY is
  # referenced by any fragment now (Azure's key included) — no vendor-specific
  # dummy is needed.
  run_bounded "$DOCKER_TIMEOUT" "$outfile" \
    bash -c "$DOCKER_SEQUENCE" _ "$IMAGE" "$WORK/.gen" "$cidfile"
  rc=$BOUNDED_RC
  out="$(cat "$outfile" 2>/dev/null || true)"

  # Always clean up the container, regardless of where/whether the sequence
  # above failed — a failing `docker cp` under `set -e` must not skip this.
  if [ -f "$cidfile" ]; then
    cid="$(cat "$cidfile")"
    [ -n "$cid" ] && docker rm -f "$cid" >/dev/null 2>&1 || true
  fi

  # Fail-closed: any sign of a schema/deserialization error is a FAIL no
  # matter what else appears in the output (in particular, this is checked
  # BEFORE the JWKS-leniency branch, so a "jwks" substring elsewhere in the
  # output can never paper over a real schema break).
  if printf '%s' "$out" | grep -qiE 'unknown variant|missing field|invalid type|unknown field'; then
    red "  FAIL $p"
    printf '%s\n' "$out" | sed 's/^/       /'
    failed=1
  elif [ "$rc" -eq 0 ]; then
    green "  OK   $p"
  elif [ "$rc" -eq 124 ] && printf '%s' "$out" | grep -qiE 'curity\.curity\.svc\.cluster\.local|jwks|agentgateway'; then
    # Schema parsed; the captured output proves the gateway actually ran and
    # got as far as the network fetch, which cannot succeed outside the
    # cluster — it never returned within the bound. A 124 with NO such output
    # (see the branch below) proves nothing and must not be treated as a pass.
    green "  OK   $p (schema OK; timed out on the JWKS fetch, unreachable outside the cluster, as expected)"
  elif [ "$rc" -eq 124 ]; then
    # run_bounded's whole docker create+cp+start sequence timed out with no
    # output at all proving the gateway ever ran — e.g. a wedged Docker daemon,
    # or a cold `docker create` still pulling the image. Reporting this as a
    # pass would be worse than reporting nothing: it is exactly the failure
    # mode this validator exists to catch (CLAUDE.md-grade bug). Fail closed.
    red "  FAIL $p (no output within ${DOCKER_TIMEOUT}s — the Docker daemon may be unresponsive or the image not cached; validation did not run)"
    failed=1
  elif printf '%s' "$out" | grep -qiE 'curity\.curity\.svc\.cluster\.local|jwks'; then
    # Schema parsed; the run got as far as the network fetch, which cannot
    # succeed outside the cluster.
    green "  OK   $p (schema OK; JWKS fetch unreachable outside the cluster, as expected)"
  else
    red "  FAIL $p"
    printf '%s\n' "$out" | sed 's/^/       /'
    failed=1
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  red "ONE OR MORE PROVIDER FRAGMENTS FAILED VALIDATION"
  exit 1
fi
green "ALL PROVIDER FRAGMENTS VALIDATE"
