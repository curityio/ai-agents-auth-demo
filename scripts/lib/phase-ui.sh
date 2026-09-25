# shellcheck shell=bash
# Terminal UI shared by the phase runners (`make demo` → time-demo.sh, `make smoke`
# → run-smoke.sh): colours, durations, and a one-line spinner that previews the
# latest line of a log while a command runs with its output captured. Source it.

fmt() { printf '%dm%02ds' $(( $1 / 60 )) $(( $1 % 60 )); }

# A live spinner only makes sense on a terminal; piped/CI output gets plain lines.
TTY=; [[ -t 1 ]] && TTY=1
if [[ -n $TTY && -z ${NO_COLOR:-} ]]; then
  B=$'\033[1m' D=$'\033[2m' R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' C=$'\033[36m' X=$'\033[0m'
else
  B= D= R= G= Y= C= X=
fi
width() { local c; c=$(tput cols 2>/dev/null) || c=; echo "${c:-100}"; }

# The last non-blank line of a log, cleaned up for a one-line preview: carriage
# returns (progress bars) split into lines, ANSI escapes and tabs neutralised.
# `tail -c` (and a line still being written) can cut a multi-byte character in
# half, which BSD tr/sed reject with "Illegal byte sequence" in a UTF-8 locale:
# iconv -c drops the partial bytes and the rest runs byte-wise (LC_ALL=C).
last_line() {
  tail -c 4000 "$1" 2>/dev/null | { iconv -c -f UTF-8 -t UTF-8 2>/dev/null || cat; } | LC_ALL=C tr '\r\t' '\n ' \
    | LC_ALL=C sed -e $'s/\033\\[[0-9;?]*[A-Za-z]//g' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    | LC_ALL=C grep -v '^$' | tail -n 1
}

# Runs in the background while a phase runs in the foreground (so Ctrl-C reaches
# make and its children as usual). Redraws a single line in place.
spin() { # <label> <start-epoch> <logfile>
  local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏) i=0 room line
  while :; do
    room=$(( $(width) - ${#1} - 16 ))
    line=$(last_line "$3")
    (( room > 10 )) && line=${line:0:$room} || line=
    printf '\r\033[K  %s%s%s %s %s%8s%s  %s%s%s' \
      "$C" "${frames[i]}" "$X" "$1" "$D" "$(fmt $(( $(date +%s) - $2 )))" "$X" "$D" "$line" "$X"
    i=$(( (i + 1) % ${#frames[@]} ))
    sleep 0.2
  done
}
SPIN_PID=
stop_spin() {
  [[ -n $SPIN_PID ]] || return 0
  kill "$SPIN_PID" 2>/dev/null; wait "$SPIN_PID" 2>/dev/null
  SPIN_PID=; printf '\r\033[K'
}
trap 'stop_spin; echo; echo "  ${R}interrupted${X}"; exit 130' INT TERM

# run_captured <label> <logfile> <cmd>... — run <cmd> with all output in <logfile>
# and the spinner on screen; returns the command's exit status. stdin is closed so
# an unexpected prompt fails fast instead of hanging unseen. The spinner's stderr
# is discarded: any stray message would break its line.
run_captured() {
  local label=$1 log=$2 rc; shift 2
  if [[ -n $TTY ]]; then spin "$label" "$(date +%s)" "$log" 2>/dev/null & SPIN_PID=$!
  else echo "  ▸ $label"; fi
  "$@" >"$log" 2>&1 </dev/null; rc=$?
  stop_spin
  return "$rc"
}

# print_tail <logfile> <lines> — the end of a failed step's log, framed.
print_tail() {
  [[ -s $1 ]] || return 0
  echo
  echo "  ${D}── last $2 lines of $1 ──${X}"
  tail -n "$2" "$1" | sed 's/^/  │ /'
  echo "  ${D}── full log: $1 ──${X}"
}

rule() { echo "  $1══════════════════════════════════════════════════════════════${X}"; }
