#!/usr/bin/env bash
# Pre-demo preflight: make sure the mesh is healthy before you present.
#
# Guards against the #1 local-cluster gotcha: Istio Ambient workload mTLS certs
# have a 24h TTL and do NOT rotate while the laptop is asleep. After a sleep that
# spans the rotation window, every *.localtest.me host fails at the edge with
# "upstream connect error ... connection termination" (mesh-wide CertificateExpired).
#
# What it does:
#   1. checks the app responds through the edge gateway,
#   2. reports how long the current ambient workload certs are valid,
#   3. refreshes them (restart ztunnel -> fresh 24h certs) if the app is down
#      OR --force is given, then re-checks.
#
# Usage:
#   scripts/demo-preflight.sh           # check; refresh ONLY if broken
#   scripts/demo-preflight.sh --force   # always refresh to mint a fresh 24h runway
#
# Run it ~30-60 min before presenting, then keep the Mac awake during the demo
# (`caffeinate -dis`, lid OPEN). NEVER `rollout restart istio-ingress` — it
# deadlocks on the single-node hostPort; refreshing ztunnel is enough (the edge
# gateway refreshes its own cert via SDS).
set -euo pipefail

NS_ISTIO=istio-system
APP_URL="https://app.localtest.me/api/health"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

check_app() {
  # Always succeeds; prints the HTTP code (000 on connection failure).
  curl -sk -o /dev/null -w '%{http_code}' --max-time 8 "$APP_URL" 2>/dev/null || echo "000"
}

# Best-effort: the soonest workload-cert expiry ztunnel is currently serving.
# Never fails the script (informational); leaves no port-forward behind.
cert_expiry() {
  local zt out pf
  zt="$(kubectl -n "$NS_ISTIO" get pod -l app=ztunnel -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  [ -n "$zt" ] || return 0
  kubectl -n "$NS_ISTIO" port-forward "$zt" 15000:15000 >/dev/null 2>&1 &
  pf=$!
  sleep 3
  # /config_dump is pretty-printed JSON, so allow the space after the colon.
  out="$(curl -s --max-time 5 localhost:15000/config_dump 2>/dev/null \
    | grep -oE '"expirationTime": *"[^"]*"' | cut -d'"' -f4 | sort -u | head -1 || true)"
  kill "$pf" >/dev/null 2>&1 || true
  printf '%s' "$out"
}

refresh_ztunnel() {
  echo "==> refreshing ztunnel (mints fresh 24h workload certs for every identity)"
  kubectl -n "$NS_ISTIO" rollout restart daemonset/ztunnel
  kubectl -n "$NS_ISTIO" rollout status daemonset/ztunnel --timeout=120s
  sleep 3
}

echo "==> kube context: $(kubectl config current-context 2>/dev/null || echo unknown)"

code="$(check_app)"
echo "==> app health ($APP_URL): HTTP $code"

exp="$(cert_expiry || true)"
[ -n "${exp:-}" ] && echo "==> soonest ambient workload cert expires: $exp"

if [ "$code" = "200" ] && [ "$FORCE" -eq 0 ]; then
  echo "✓ mesh is healthy — safe to demo."
  echo "  Tip: run with --force to mint a fresh 24h runway, and start \`caffeinate -dis\` (lid open)."
  exit 0
fi

if [ "$code" != "200" ]; then
  echo "✗ app not reachable through the edge — most likely expired ambient certs. Recovering…"
fi

refresh_ztunnel

code="$(check_app)"
echo "==> re-check app health: HTTP $code"
if [ "$code" = "200" ]; then
  echo "✓ green — safe to demo. Keep the Mac awake during the demo: caffeinate -dis (lid open)."
  exit 0
fi

echo "✗ still failing (HTTP $code). Investigate:"
echo "    kubectl -n $NS_ISTIO logs ds/ztunnel --tail=50 | grep -i cert"
echo "    kubectl get pods -A | grep -vE 'Running|Completed'"
exit 1
