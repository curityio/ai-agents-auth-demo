#!/usr/bin/env bash
# The body of `make demo`: run its phases one at a time and report how long each
# took. The Makefile passes the phase list (DEMO_PHASES) so it lives in one place.
# Each phase is a plain `make <phase>` in order — the same as listing them as
# prerequisites — plus a wall-clock summary at the end, which also lands in
# demo-timing.log (gitignored). Full phase output stays on the terminal. Stops at
# the first failing phase and records which one.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ $# -gt 0 ]] || { echo "usage: $0 <phase>... (run via 'make demo')" >&2; exit 2; }

LOG=demo-timing.log
fmt() { printf '%dm%02ds' $(( $1 / 60 )) $(( $1 % 60 )); }

: > "$LOG"
t0=$(date +%s)
echo "make demo started $(date '+%F %T')" | tee -a "$LOG"
status=ok
for p in "$@"; do
  echo; echo "════════ make $p ════════"
  s=$(date +%s)
  if make --no-print-directory "$p"; then status=ok; else status=FAILED; fi
  d=$(( $(date +%s) - s ))
  printf '%-14s %8s  %s\n' "$p" "$(fmt "$d")" "$status" | tee -a "$LOG"
  [[ $status == ok ]] || { echo "aborted after $p" | tee -a "$LOG"; break; }
done
printf '%-14s %8s\n' TOTAL "$(fmt $(( $(date +%s) - t0 )))" | tee -a "$LOG"
echo; echo "──── per-phase summary (also in $LOG) ────"; cat "$LOG"
[[ $status == ok ]] || exit 1
make --no-print-directory demo-done
