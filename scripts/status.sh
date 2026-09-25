#!/usr/bin/env bash
# The renderer behind `make status`.
#
#   status.sh pods <ns>...                 one table of every pod in <ns>, in that order
#   status.sh check <name> <fix> -- <cmd>  run a read-only check and print ONE line:
#                                          ✓ + its verdict, or ✗ + its output + <fix>
#
# The pods table comes from a single `kubectl get pods -A`, so every row shares one
# set of column widths (one kubectl call per namespace aligned each block on its own).
# Rows that are not fully ready — or not Running/Completed — are marked ✗. The checks
# stay separate invocations so the Makefile recipe still names the commands it runs.
# Always exits 0 for `pods`; `check` exits with the check's status.
set -uo pipefail

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  B=$'\033[1m' D=$'\033[2m' R=$'\033[31m' G=$'\033[32m' Y=$'\033[33m' X=$'\033[0m'
else
  B= D= R= G= Y= X=
fi

cmd_pods() {
  local pods namespaces
  pods=$(kubectl get pods -A --no-headers 2>&1) || {
    echo "  ${R}✗${X} cannot list pods: ${pods}"; return 0; }
  namespaces=$(kubectl get ns --no-headers -o custom-columns=:metadata.name 2>/dev/null)

  # RESTARTS can read "3 (5m ago)", so it is every field between STATUS and AGE.
  printf '%s\n' "$pods" | awk -v order="$*" -v present="$(echo $namespaces)" \
    -v B="$B" -v D="$D" -v R="$R" -v G="$G" -v Y="$Y" -v X="$X" '
    {
      restarts = $5; for (i = 6; i < NF; i++) restarts = restarts " " $i
      n = ++count[$1]
      name[$1, n] = $2; ready[$1, n] = $3; phase[$1, n] = $4
      rst[$1, n] = restarts; age[$1, n] = $NF
      if (length($2) > wname) wname = length($2)
      if (length($4) > wst) wst = length($4)
      if (length(restarts) > wrst) wrst = length(restarts)
    }
    END {
      split(order, ns, " "); split(present, p, " ")
      for (i in p) exists[p[i]] = 1
      wns = 9; for (i in ns) if (length(ns[i]) > wns) wns = length(ns[i])
      if (wname < 4) wname = 4
      if (wst < 6) wst = 6
      if (wrst < 8) wrst = 8

      printf "\n  %s%-*s    %-*s  %-5s  %-*s  %-*s  %s%s\n", D, wns, "NAMESPACE", wname, "POD", \
        "READY", wst, "STATUS", wrst, "RESTARTS", "AGE", X
      total = 0; bad = 0; missing = 0
      for (i = 1; i in ns; i++) {
        s = ns[i]
        if (!(s in count)) {
          note = (s in exists) ? "(no pods)" : "(namespace not present)"
          printf "  %s%-*s%s  %s%s%s\n", B, wns, s, X, D, note, X
          if (!(s in exists)) missing++
          continue
        }
        for (j = 1; j <= count[s]; j++) {
          split(ready[s, j], rd, "/")
          ok = (phase[s, j] == "Completed") || (phase[s, j] == "Running" && rd[1] == rd[2])
          total++; if (!ok) bad++
          mark = ok ? G "✓" X : R "✗" X
          st = ok ? phase[s, j] : R phase[s, j] X
          stpad = wst - length(phase[s, j])
          r = rst[s, j]; rs = (r == "0") ? D r X : Y r X
          rpad = wrst - length(r)
          printf "  %s%-*s%s  %s %-*s  %-5s  %s%*s  %s%*s  %s%s%s\n", \
            B, wns, (j == 1 ? s : ""), X, mark, wname, name[s, j], ready[s, j], \
            st, stpad, "", rs, rpad, "", D, age[s, j], X
        }
      }
      printf "\n"
      if (bad == 0 && missing == 0) {
        printf "  %s✓ all %d pods healthy%s across %d namespaces\n", G, total, X, length(ns)
      } else {
        msg = ""
        if (bad) msg = bad " of " total " pods not ready"
        if (missing) msg = msg (msg ? " · " : "") missing " namespace" (missing > 1 ? "s" : "") " missing"
        printf "  %s✗ %s%s\n", R, msg, X
      }
    }'
}

cmd_check() {
  local name=$1 fix=$2 out rc verdict
  shift 2; [[ ${1:-} == -- ]] && shift
  out=$("$@" 2>&1); rc=$?
  if (( rc == 0 )); then
    # A check's last line is its verdict; drop the "==> Verified:" / "OK:" prefixes.
    verdict=$(printf '%s\n' "$out" | tail -n 1 | sed -E 's/^(==> )?(Verified|OK): *//')
    printf '  %s✓%s %-20s %s\n' "$G" "$X" "$name" "$verdict"
  else
    printf '  %s✗ %-20s%s %s(fix: %s)%s\n' "$R" "$name" "$X" "$B" "$fix" "$X"
    printf '%s\n' "$out" | sed 's/^/      │ /'
  fi
  return "$rc"
}

case "${1:-}" in
  pods)  shift; cmd_pods "$@" ;;
  check) shift; cmd_check "$@" ;;
  header) printf '\n  %s%s%s\n' "$B" "$2" "$X" ;;
  *) echo "usage: $0 {pods <ns>...|check <name> <fix> -- <cmd>...|header <title>}" >&2; exit 2 ;;
esac
