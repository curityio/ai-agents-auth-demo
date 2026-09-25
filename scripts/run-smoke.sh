#!/usr/bin/env bash
# The body of `make smoke`: run each suite (a `make <target>`) with its output in
# .smoke-logs/NN-<target>.log, showing ONE status line per suite — ✓/✗, duration,
# and how many checks passed or were skipped. The Makefile passes the suite list
# (SMOKE_SUITES) so it lives in one place.
#
# ONE token is required: SMOKE_TOKEN_ALICE_MFA (alice, stepped up with TOTP, so
# acr=mfa). SMOKE_SUBJECT_TOKEN — the name the individual suites read — defaults to
# it: an acr=mfa token serves every suite (obo/llm only need inspect:read and
# llm:invoke; a2a, mcp-protocol and gateway-authz need ops:write, i.e. acr=mfa).
# An explicitly exported SMOKE_SUBJECT_TOKEN still wins. Bob's and Carol's tokens
# are optional (the suites SKIP those checks).
#
# Before anything runs, the tokens are decoded (sub, acr, time left): a suite
# whose required token is missing or expired is reported as "not run" instead of
# failing half-way through with a confusing Curity error. The first
# suites (routing-check, jwks-check) are preconditions — if one fails every later
# suite would fail for the same reason, so the run stops there; after that every
# suite runs and the summary lists the ones that failed. SMOKE_VERBOSE=1 streams
# every suite in full (still logged). Individual `make smoke-*` targets are
# unchanged and print their full output.
set -uo pipefail
cd "$(dirname "$0")/.."

[[ $# -gt 0 ]] || { echo "usage: $0 <suite-target>... (run via 'make smoke')" >&2; exit 2; }

LOG_DIR=.smoke-logs
VERBOSE=${SMOKE_VERBOSE:-}
FAIL_TAIL=${SMOKE_FAIL_TAIL:-25}
PRECONDITIONS=" routing-check jwks-check "
USERS_ENV=${DEMO_USERS_ENV_FILE:-.demo-users.env}

# shellcheck source=lib/phase-ui.sh
. scripts/lib/phase-ui.sh

# The token the SMOKE_SUBJECT_TOKEN suites actually get, and the variable to blame
# when it is unusable.
SUBJECT_VAR=SMOKE_TOKEN_ALICE_MFA
if [[ -n ${SMOKE_SUBJECT_TOKEN:-} ]]; then
  SUBJECT_VAR=SMOKE_SUBJECT_TOKEN
elif [[ -n ${SMOKE_TOKEN_ALICE_MFA:-} ]]; then
  export SMOKE_SUBJECT_TOKEN=$SMOKE_TOKEN_ALICE_MFA
fi

# What a suite cannot run without (empty = nothing): a token, and for every token
# suite the host's node_modules — they sign CIMD client assertions on the host with
# scripts/cimd-sign-assertion.mjs, which needs `jose`. Optional tokens only make
# the suite SKIP some of its checks, which it reports itself. "<var>@mfa" means the
# token must also carry acr=mfa: those suites exchange for ops:write, which Curity's
# ACR token-issuance authorizer withholds from a password-only login — the refusal
# ("invalid_scope no scope intersects …") reads like a role problem, so it is caught
# here instead. obo and llm only need inspect:read / llm:invoke.
requires() {
  case "$1" in
    smoke-obo|smoke-llm) echo "node_modules $SUBJECT_VAR" ;;
    smoke-a2a|smoke-mcp-protocol|smoke-gateway-authz) echo "node_modules $SUBJECT_VAR $SUBJECT_VAR@mfa" ;;
    smoke-stepup) echo "node_modules SMOKE_TOKEN_ALICE_MFA" ;;
  esac
}
# How a requirement reads in a "not run — needs …" line.
need_label() { [[ $1 == *@mfa ]] && echo "${1%@mfa} with acr=mfa" || echo "$1"; }

# jwt_info <jwt> → "<sub>|<acr>|<seconds left>" (seconds negative once expired),
# or nothing if it does not decode as a JWT.
jwt_info() {
  python3 - "$1" <<'PY' 2>/dev/null
import base64, json, sys, time
try:
    p = sys.argv[1].split(".")[1]
    c = json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))
    print("%s|%s|%d" % (c.get("sub", "?"), c.get("acr", "?"), int(c.get("exp", 0) - time.time())))
except Exception:
    pass
PY
}
ago() { local s=${1#-}; (( s >= 60 )) && echo "$(( s / 60 ))m" || echo "${s}s"; }

# ── Tokens ───────────────────────────────────────────────────────────────────
# Tokens that are missing, expired or wrong, as a space-delimited set (bash 3.2).
BAD_TOKENS=" "
token_line() { # <var> <required-by|""> <optional-note>
  local var=$1 need=$2 note=$3 val info sub acr left
  val=${!var:-}
  if [[ -z $val ]]; then
    if [[ -n $need ]]; then
      printf '  %s✗%s %-24s %snot set — required by %s%s\n' "$R" "$X" "$var" "$R" "$need" "$X"
      BAD_TOKENS+="$var "
    else
      printf '  %s–%s %-24s %snot set (%s)%s\n' "$D" "$X" "$var" "$D" "$note" "$X"
    fi
    return
  fi
  info=$(jwt_info "$val")
  if [[ -z $info ]]; then
    printf '  %s✗%s %-24s %snot a JWT%s\n' "$R" "$X" "$var" "$R" "$X"; BAD_TOKENS+="$var "; return
  fi
  IFS='|' read -r sub acr left <<< "$info"
  if (( left <= 0 )); then
    printf '  %s✗%s %-24s %s · acr=%s · %sexpired %s ago%s\n' "$R" "$X" "$var" "$sub" "$acr" "$R" "$(ago "$left")" "$X"
    BAD_TOKENS+="$var "
  elif [[ $var == SMOKE_TOKEN_ALICE_MFA && $acr != mfa ]]; then
    printf '  %s✗%s %-24s %s · %sacr=%s, needs acr=mfa (step up with TOTP first)%s\n' "$R" "$X" "$var" "$sub" "$R" "$acr" "$X"
    BAD_TOKENS+="$var "
  elif [[ $acr != mfa && $var == SMOKE_SUBJECT_TOKEN ]]; then
    # Good enough for obo + llm; the ops:write suites are held back (see requires).
    printf '  %s⚠%s %-24s %s · %sacr=%s — a2a, mcp-protocol, gateway-authz need acr=mfa and will not run%s\n' \
      "$Y" "$X" "$var" "$sub" "$Y" "$acr" "$X"
    BAD_TOKENS+="$var@mfa "
  elif [[ $acr != mfa && $var == SMOKE_TOKEN_CAROL ]]; then
    # Optional, so nothing is held back — but stepup's carol check will fail.
    printf '  %s⚠%s %-24s %s · %sacr=%s — stepup'"'"'s oncall ops:write check needs acr=mfa and will fail%s\n' \
      "$Y" "$X" "$var" "$sub" "$Y" "$acr" "$X"
  else
    local lc=$G; (( left < 120 )) && lc=$Y
    printf '  %s✓%s %-24s %s · acr=%s · %s%s left%s\n' "$G" "$X" "$var" "$sub" "$acr" "$lc" "$(ago "$left")" "$X"
  fi
}

rm -rf "$LOG_DIR"; mkdir -p "$LOG_DIR"
t0=$(date +%s)
echo
echo "  ${B}make smoke${X}  ${D}started $(date '+%F %T') · $# suites · logs in $LOG_DIR/${X}"
echo
echo "  ${B}Preflight${X}"
# `make clean` deletes the root node_modules; the per-package links then dangle,
# and every token suite dies in node before reaching Curity ("invalid_client").
if node -e "require(require('module').createRequire(process.cwd() + '/packages/auth-curity/package.json').resolve('jose'))" 2>/dev/null; then
  printf '  %s✓%s %-24s %s\n' "$G" "$X" "host dependencies" "${D}jose resolves from packages/auth-curity${X}"
else
  printf '  %s✗%s %-24s %snode_modules missing — run: make install%s\n' "$R" "$X" "host dependencies" "$R" "$X"
  BAD_TOKENS+="node_modules "
fi
token_line SMOKE_TOKEN_ALICE_MFA "every token suite" ""
if [[ $SUBJECT_VAR == SMOKE_SUBJECT_TOKEN ]]; then
  token_line SMOKE_SUBJECT_TOKEN "" "" # explicitly exported: checked on its own
fi
token_line SMOKE_TOKEN_BOB       "" "optional: stepup skips the developer-denial check"
token_line SMOKE_TOKEN_CAROL     "" "optional: stepup + gateway-authz skip the oncall checks"
if [[ -n ${SMOKE_ALICE_PASSWORD:-} ]]; then
  printf '  %s✓%s %-24s %s\n' "$G" "$X" SMOKE_ALICE_PASSWORD "set"
elif grep -q '^ALICE_PASSWORD=' "$USERS_ENV" 2>/dev/null; then
  printf '  %s✓%s %-24s %s\n' "$G" "$X" SMOKE_ALICE_PASSWORD "${D}from $USERS_ENV${X}"
else
  printf '  %s–%s %-24s %snot set (optional: stepup skips the password-only login check)%s\n' "$D" "$X" SMOKE_ALICE_PASSWORD "$D" "$X"
fi

# ── Suites ───────────────────────────────────────────────────────────────────
echo
echo "  ${B}Suites${X}"
n=$#; k=0; failed=(); notrun=(); stopped=
for t in "$@"; do
  k=$(( k + 1 ))
  name=${t#smoke-}
  label=$(printf '%s %-15s' "${D}$k/$n${X}" "$name")
  log=$(printf '%s/%02d-%s.log' "$LOG_DIR" "$k" "$t")
  need=$(requires "$t")

  missing=
  for r in $need; do
    [[ $BAD_TOKENS == *" $r "* ]] || continue
    [[ $r == *@mfa && $missing == *"${r%@mfa}"* ]] && continue # already listed as unusable
    missing+="${missing:+, }$(need_label "$r")"
  done
  if [[ -n $missing ]]; then
    printf '  %s–%s %s %8s  %snot run — needs %s%s\n' "$Y" "$X" "$label" "" "$D" "$missing" "$X"
    notrun+=("$name"); continue
  fi

  s=$(date +%s)
  if [[ -n $VERBOSE ]]; then
    echo "  ${C}▸${X} $label"
    make --no-print-directory "$t" 2>&1 | tee "$log"; rc=${PIPESTATUS[0]}
  else
    run_captured "$label" "$log" make --no-print-directory "$t"; rc=$?
  fi
  d=$(fmt $(( $(date +%s) - s )))

  # Tally what the suite printed. The suites mark checks as "OK"/"SKIP" lines
  # (routing prints "Verified"); colour codes are stripped before matching.
  plain=$(LC_ALL=C sed $'s/\033\\[[0-9;]*m//g' "$log")
  oks=$(printf '%s\n' "$plain" | LC_ALL=C grep -cE '^[[:space:]]*(OK\b|==> Verified|✓)')
  skips=$(printf '%s\n' "$plain" | LC_ALL=C grep -cE '^[[:space:]]*SKIP\b')
  tally="$oks ok"; (( skips > 0 )) && tally="$tally · ${Y}$skips skipped${X}${D}"

  if (( rc == 0 )); then
    printf '  %s✓%s %s %8s  %s(%s)%s\n' "$G" "$X" "$label" "$d" "$D" "$tally" "$X"
    continue
  fi
  if (( rc == 78 )); then # EX_CONFIG: the suite refused to start (missing input)
    printf '  %s✗%s %s %8s  %snot run — %s%s\n' "$R" "$X" "$label" "$d" "$D" \
      "$(printf '%s\n' "$plain" | grep -v '^[[:space:]]*$' | head -n 1)" "$X"
    notrun+=("$name"); continue
  fi
  printf '  %s✗%s %s %8s  %sFAILED%s\n' "$R" "$X" "$label" "$d" "$R$B" "$X"
  [[ -z $VERBOSE ]] && print_tail "$log" "$FAIL_TAIL" && echo
  failed+=("$name")
  if [[ $PRECONDITIONS == *" $t "* ]]; then
    echo "  ${D}$name is a precondition — the remaining suites would fail for the same reason; stopping.${X}"
    stopped=1; break
  fi
done

# ── Summary ──────────────────────────────────────────────────────────────────
total=$(fmt $(( $(date +%s) - t0 )))
echo
if (( ${#failed[@]} == 0 && ${#notrun[@]} == 0 )); then
  rule "$G"
  echo "   ${G}${B}✅  All $n smoke suites passed${X}  ${D}·  took $total${X}"
  rule "$G"; echo
  exit 0
fi

rule "$R"
summary=
(( ${#failed[@]} )) && summary="${#failed[@]} failed (${failed[*]})"
(( ${#notrun[@]} )) && summary="${summary:+$summary · }${#notrun[@]} not run (${notrun[*]})"
[[ -n $stopped ]] && summary="$summary · stopped early"
echo "   ${R}${B}❌  Smoke tests did not pass${X}  ${D}·  took $total${X}"
echo "      $summary"
rule "$R"; echo
if [[ $BAD_TOKENS == *" node_modules "* ]]; then
  echo "    ${B}Deps${X}    make install   ${D}(pnpm install — the smoke scripts sign client assertions on this host)${X}"
fi
if [[ $BAD_TOKENS == *" SMOKE_TOKEN_ALICE_MFA "* ]]; then
  echo "    ${B}Token${X}   sign in at https://app.localtest.me as alice and step up with TOTP (ask for a"
  echo "            restart), then open https://app.localtest.me/api/dev/token and export it:"
  echo "              export SMOKE_TOKEN_ALICE_MFA='eyJ…'; make smoke"
elif [[ $BAD_TOKENS == *" SMOKE_SUBJECT_TOKEN"* ]]; then
  # An exported SMOKE_SUBJECT_TOKEN overrides the one that works; drop it.
  echo "    ${B}Token${X}   the exported SMOKE_SUBJECT_TOKEN is unusable here; without it make smoke uses"
  echo "            SMOKE_TOKEN_ALICE_MFA for every suite:"
  echo "              unset SMOKE_SUBJECT_TOKEN; make smoke"
fi
(( ${#failed[@]} )) && echo "    ${B}Logs${X}    $LOG_DIR/ · re-run one suite with its full output: make smoke-<name> (or make routing-check / jwks-check)"
echo
exit 1
