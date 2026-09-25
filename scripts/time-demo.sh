#!/usr/bin/env bash
# The body of `make demo`: run its phases one at a time and report how long each
# took. The Makefile passes the phase list (DEMO_PHASES) so it lives in one place.
# Each phase is a plain `make <phase>` in order — the same as listing them as
# prerequisites. Stops at the first failing phase and records which one.
#
# Output: each phase's full output goes to .demo-logs/NN-<phase>.log (gitignored
# via *.log) and the terminal shows ONE status line per phase — a spinner with
# the elapsed time and the phase's latest log line while it runs, then ✓/✗ and
# its duration. On failure the tail of that phase's log is printed along with the
# command that resumes from it. Phases in DEMO_INTERACTIVE (default: demo-inputs,
# the only one that prompts) keep the terminal. DEMO_VERBOSE=1 restores the old
# behaviour: every phase streams in full (and is still logged). The run ends with
# a completion (or failure) banner as the last thing on screen, after the URLs and
# persona cards. NO_COLOR disables colour.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ $# -gt 0 ]] || { echo "usage: $0 <phase>... (run via 'make demo')" >&2; exit 2; }

LOG_DIR=.demo-logs
INTERACTIVE=" ${DEMO_INTERACTIVE:-demo-inputs} "
VERBOSE=${DEMO_VERBOSE:-}
FAIL_TAIL=${DEMO_FAIL_TAIL:-40}

# shellcheck source=lib/phase-ui.sh
. scripts/lib/phase-ui.sh

rm -rf "$LOG_DIR"; mkdir -p "$LOG_DIR"
t0=$(date +%s)
echo
echo "  ${B}make demo${X}  ${D}started $(date '+%F %T') · $# phases · logs in $LOG_DIR/${X}"
echo

n=$#; k=0; status=ok; phases=("$@")
for p in "$@"; do
  k=$(( k + 1 ))
  label=$(printf '%s %-13s' "${D}$k/$n${X}" "$p")
  plog=$(printf '%s/%02d-%s.log' "$LOG_DIR" "$k" "$p")
  s=$(date +%s)

  if [[ -n $VERBOSE || $INTERACTIVE == *" $p "* ]]; then
    # Streamed phases keep the terminal (and stdin, for prompts).
    echo "  ${C}▸${X} $label"
    echo "${D}──────────────────────────────────────────────────────────${X}"
    if [[ -n $VERBOSE ]]; then
      make --no-print-directory "$p" 2>&1 | tee "$plog"; rc=${PIPESTATUS[0]}
    else
      make --no-print-directory "$p"; rc=$?
    fi
    echo "${D}──────────────────────────────────────────────────────────${X}"
  else
    run_captured "$label" "$plog" make --no-print-directory "$p"; rc=$?
  fi

  d=$(( $(date +%s) - s ))
  if (( rc == 0 )); then status=ok; mark="${G}✓${X}"; else status=FAILED; mark="${R}✗${X}"; fi
  printf '  %s %s %8s' "$mark" "$label" "$(fmt "$d")"
  [[ $status == ok ]] && { echo; continue; }

  echo "  ${R}${B}FAILED${X}"
  [[ -z $VERBOSE && $INTERACTIVE != *" $p "* ]] && print_tail "$plog" "$FAIL_TAIL"
  echo
  echo "  Fix the cause, then resume from this phase:  ${B}make ${phases[*]:$(( k - 1 ))}${X}"
  break
done

total=$(fmt $(( $(date +%s) - t0 )))
echo "  ${D}────────────────────────────────${X}"
# Padding is applied to the bare word so colour codes don't skew the column.
printf '        %s%-13s%s %8s   %s\n' "$B" total "$X" "$total" "${D}(phase output: $LOG_DIR/)${X}"

if [[ $status != ok ]]; then
  echo; rule "$R"
  echo "   ${R}${B}❌  Installation failed at '$p'${X}  ${D}·  after $total${X}"
  rule "$R"; echo
  echo "    The error is above; the phase's full output is in ${B}$plog${X}."
  echo
  exit 1
fi

make --no-print-directory demo-done
echo; rule "$G"
echo "   ${G}${B}✅  Installation complete — the demo is ready${X}  ${D}·  took $total${X}"
rule "$G"; echo
echo "    ${B}Open${X}    https://app.localtest.me  and sign in as alice, bob or carol (cards above)"
echo "    ${B}Check${X}   make status  ${D}(pod health)${X}  ·  make smoke  ${D}(end-to-end tests)${X}"
echo "    ${B}TLS${X}     a browser certificate warning is expected — safe to proceed; ${D}make trust-ca silences it${X}"
echo "    ${B}Docs${X}    README.md ${D}(setup, troubleshooting)${X}  ·  docs/architecture.md ${D}(system design)${X}"
echo
