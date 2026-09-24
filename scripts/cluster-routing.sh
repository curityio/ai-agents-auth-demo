#!/usr/bin/env bash
# Wire pod-side routing + CA trust for the externally-facing Curity URL.
#
# Problem: pods can't reach https://curity.localtest.me because 127.0.0.1
# inside a pod is the pod itself. We need (a) a hostAlias mapping the FQDN to
# the ingress controller's cluster IP, and (b) the mkcert root CA mounted into
# each pod that talks TLS to Curity so cert validation passes.
#
# Idempotent — re-running picks up cluster-IP changes if the cluster was
# recreated.
#
# Usage:
#   cluster-routing.sh          patch every target, then verify all are wired
#   cluster-routing.sh check    verify only (read-only; no patch, no rollout)
#
# A *partial* run is the dangerous case: if the patch loop dies mid-way (e.g. a
# rollout times out under `set -e`) some namespaces end up unwired and the
# symptom is a confusing downstream failure — a backend that can't fetch
# Curity's JWKS rejects otherwise-valid tokens (ECONNREFUSED -> invalid_token
# -> 502). The post-patch verification below makes "Done" mean "all targets
# wired"; `check` mode lets you detect drift later (e.g. after a manual
# rollout/re-apply stripped a hostAlias).
set -euo pipefail

MODE="${1:-apply}"

CURITY_HOST="${CURITY_HOST:-curity.localtest.me}"
INGRESS_NS="${INGRESS_NS:-istio-ingress}"
INGRESS_SVC="${INGRESS_SVC:-istio-ingress}"

# (namespace deployment) pairs that need the routing fix
TARGETS=(
  "web web"
  "agents agent-copilot"
  "agents agent-specialist"
  "mcp mcp-observability"
  "mcp mcp-ops"
  # agentgateway: only the co-located exchange-shim (containers[0]) talks TLS to
  # https://curity.localtest.me, so it needs the hostAlias + mkcert CA. The routing
  # patch targets containers[0] — the shim is deliberately first in the pod spec.
  "mcp agentgateway"
  "apis ops-api"
  "apis obs-api"
)

# CIMD: Curity itself must reach the two agents' client_id hosts to dereference
# their Client ID Metadata Documents. Like the targets above, *.localtest.me
# resolves to 127.0.0.1 inside the pod, so Curity needs a hostAlias → ingress.
# Curity is a JVM app and trusts the mkcert CA via its config server-truststore
# (embedded by scripts/embed-mkcert-ca.sh), NOT NODE_EXTRA_CA_CERTS — so it
# only needs the hostAlias, no CA volume mount.
CURITY_NS="${CURITY_NS:-curity}"
CURITY_DEPLOY="${CURITY_DEPLOY:-curity}"
CIMD_HOSTS=("copilot.localtest.me" "specialist.localtest.me")

# RFC 9728: on a step-up challenge the web BFF fetches the protected-resource
# metadata document to learn the authorization server, and the two agents run
# the full discovery chain (401 → resource_metadata → PRM → RFC 8414) against the
# agentgateway. The URLs involved are PUBLIC https://*.localtest.me identifiers —
# rewriting them to cluster-internal names would defeat the point of a stable
# resource identifier (a spec-shaped client checks PRM.resource == the URL it
# calls). Inside a pod those hosts resolve to 127.0.0.1 (the pod itself), so each
# consumer needs the same ingress alias Curity gets.
RESOURCE_HOSTS=("mcp-ops.localtest.me" "mcp-observability.localtest.me" "mcp-gateway.localtest.me")
# The agents call the MCP front door by its public name (MCP_*_URL in
# k8s/workloads/agent-*.yaml) — see the RFC 9728 note above.
AGENT_MCP_HOSTS=("mcp-gateway.localtest.me")

# extra_hosts_for <ns> <deploy> — hostnames this target needs aliased BEYOND
# $CURITY_HOST, one per line. (bash 3.2 on macOS: no associative arrays.)
extra_hosts_for() {
  case "$1/$2" in
    web/web) printf '%s\n' "${RESOURCE_HOSTS[@]}" ;;
    agents/agent-copilot|agents/agent-specialist) printf '%s\n' "${AGENT_MCP_HOSTS[@]}" ;;
  esac
}

# verify_routing: confirm every target deployment carries the hostAlias mapping
# $CURITY_HOST -> the *current* $INGRESS_IP and the NODE_EXTRA_CA_CERTS env.
# Both live in the Deployment spec, so this needs no mkcert binary and catches
# the two real-world drift modes: never-patched (missing alias) and
# stale-after-cluster-recreate (alias points at an old ClusterIP). Returns
# non-zero and lists offenders if any target is not fully wired.
verify_routing() {
  local missing=()
  local entry ns deploy ha caenv
  for entry in "${TARGETS[@]}"; do
    read -r ns deploy <<< "$entry"
    if ! kubectl -n "$ns" get deploy "$deploy" >/dev/null 2>&1; then
      missing+=("$ns/$deploy (deployment not found)")
      continue
    fi
    ha="$(kubectl -n "$ns" get deploy "$deploy" \
      -o jsonpath='{.spec.template.spec.hostAliases}' 2>/dev/null || true)"
    caenv="$(kubectl -n "$ns" get deploy "$deploy" \
      -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="NODE_EXTRA_CA_CERTS")].value}' 2>/dev/null || true)"
    if [[ "$ha" != *"$CURITY_HOST"* ]]; then
      missing+=("$ns/$deploy (no hostAlias for $CURITY_HOST)")
    elif [[ "$ha" != *"$INGRESS_IP"* ]]; then
      missing+=("$ns/$deploy (hostAlias points at stale IP, expected $INGRESS_IP)")
    elif [[ -z "$caenv" ]]; then
      missing+=("$ns/$deploy (no NODE_EXTRA_CA_CERTS / mkcert CA mount)")
    else
      # Per-target extras (e.g. web's RFC 9728 resource hosts) drift the same way.
      while IFS= read -r extra_host; do
        [[ -n "$extra_host" && "$ha" != *"$extra_host"* ]] &&
          missing+=("$ns/$deploy (no hostAlias for $extra_host)")
      done < <(extra_hosts_for "$ns" "$deploy")
    fi
  done

  # Curity → agent CIMD-host reachability (hostAlias only; no CA env on JVM).
  if kubectl -n "$CURITY_NS" get deploy "$CURITY_DEPLOY" >/dev/null 2>&1; then
    local cha h
    cha="$(kubectl -n "$CURITY_NS" get deploy "$CURITY_DEPLOY" \
      -o jsonpath='{.spec.template.spec.hostAliases}' 2>/dev/null || true)"
    for h in "${CIMD_HOSTS[@]}"; do
      if [[ "$cha" != *"$h"* ]]; then
        missing+=("$CURITY_NS/$CURITY_DEPLOY (no hostAlias for $h)")
      fi
    done
    if [[ "$cha" == *"localtest.me"* && "$cha" != *"$INGRESS_IP"* ]]; then
      missing+=("$CURITY_NS/$CURITY_DEPLOY (CIMD hostAlias points at stale IP, expected $INGRESS_IP)")
    fi
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    echo "" >&2
    echo "ERROR: routing is incomplete — these targets are NOT wired to reach $CURITY_HOST:" >&2
    local m
    for m in "${missing[@]}"; do echo "  - $m" >&2; done
    echo "" >&2
    echo "Fix: re-run 'make routing' (idempotent). A partial run leaves backends" >&2
    echo "unable to fetch Curity's JWKS -> tokens are rejected as invalid_token -> 502." >&2
    return 1
  fi
  echo "==> Verified: all ${#TARGETS[@]} targets route $CURITY_HOST -> $INGRESS_IP and trust the mkcert CA."
  return 0
}

echo "==> Looking up ingress ClusterIP"
INGRESS_IP="$(kubectl -n "$INGRESS_NS" get svc "$INGRESS_SVC" -o jsonpath='{.spec.clusterIP}')"
if [[ -z "$INGRESS_IP" ]]; then
  echo "ERROR: could not resolve $INGRESS_NS/$INGRESS_SVC ClusterIP" >&2
  exit 1
fi
echo "    $INGRESS_NS/$INGRESS_SVC = $INGRESS_IP"

if [[ "$MODE" == "check" ]]; then
  verify_routing
  exit $?
fi

echo "==> Locating mkcert root CA"
CAROOT="$(mkcert -CAROOT)"
ROOTCA="$CAROOT/rootCA.pem"
if [[ ! -f "$ROOTCA" ]]; then
  echo "ERROR: mkcert root CA not found at $ROOTCA" >&2
  echo "Run: mkcert -install" >&2
  exit 1
fi
echo "    $ROOTCA"

for entry in "${TARGETS[@]}"; do
  read -r ns deploy <<< "$entry"
  echo ""
  echo "==> $ns/$deploy"

  kubectl -n "$ns" create secret generic mkcert-ca \
    --from-file=rootCA.pem="$ROOTCA" \
    --dry-run=client -o yaml | kubectl apply -f -

  # Patch: hostAliases + CA volume + NODE_EXTRA_CA_CERTS env.
  # Use strategic-merge JSON. Container name must match the manifest.
  container_name="$(kubectl -n "$ns" get deploy/"$deploy" -o jsonpath='{.spec.template.spec.containers[0].name}')"
  if [[ -z "$container_name" ]]; then
    echo "  skip: deployment $deploy not found"
    continue
  fi

  # $CURITY_HOST plus any per-target extras (see extra_hosts_for).
  target_hosts=("$CURITY_HOST")
  while IFS= read -r extra_host; do
    [[ -n "$extra_host" ]] && target_hosts+=("$extra_host")
  done < <(extra_hosts_for "$ns" "$deploy")
  target_hosts_json="$(printf '"%s",' "${target_hosts[@]}")"
  target_hosts_json="[${target_hosts_json%,}]"

  patch="$(cat <<EOF
{
  "spec": {
    "template": {
      "spec": {
        "hostAliases": [
          {
            "ip": "$INGRESS_IP",
            "hostnames": $target_hosts_json
          }
        ],
        "volumes": [
          {
            "name": "mkcert-ca",
            "secret": { "secretName": "mkcert-ca" }
          }
        ],
        "containers": [
          {
            "name": "$container_name",
            "volumeMounts": [
              {
                "name": "mkcert-ca",
                "mountPath": "/etc/ssl/certs/mkcert",
                "readOnly": true
              }
            ],
            "env": [
              { "name": "NODE_EXTRA_CA_CERTS", "value": "/etc/ssl/certs/mkcert/rootCA.pem" }
            ]
          }
        ]
      }
    }
  }
}
EOF
)"
  # strategic-merge merges arrays by name (containers, volumeMounts, env). We
  # rely on Kubernetes' default merge keys.
  kubectl -n "$ns" patch deploy "$deploy" --type=strategic --patch "$patch"
  kubectl -n "$ns" rollout status deploy "$deploy" --timeout=120s
done

# Curity → agent CIMD hosts: hostAlias only (no CA mount — JVM trusts the mkcert
# CA via its config server-truststore). Skipped gracefully if Curity isn't up yet.
if kubectl -n "$CURITY_NS" get deploy "$CURITY_DEPLOY" >/dev/null 2>&1; then
  echo ""
  echo "==> $CURITY_NS/$CURITY_DEPLOY (CIMD client_id reachability)"
  hostnames_json="$(printf '"%s",' "${CIMD_HOSTS[@]}")"
  hostnames_json="[${hostnames_json%,}]"
  curity_patch="$(cat <<EOF
{
  "spec": {
    "template": {
      "spec": {
        "hostAliases": [
          { "ip": "$INGRESS_IP", "hostnames": $hostnames_json }
        ]
      }
    }
  }
}
EOF
)"
  kubectl -n "$CURITY_NS" patch deploy "$CURITY_DEPLOY" --type=strategic --patch "$curity_patch"
  kubectl -n "$CURITY_NS" rollout status deploy "$CURITY_DEPLOY" --timeout=120s
else
  echo "  note: $CURITY_NS/$CURITY_DEPLOY not found yet — re-run 'make routing' after Curity is up."
fi

echo ""
# Guard: only declare success if EVERY target actually carries the routing. If
# the loop above died mid-way, `set -e` already exited non-zero before here; this
# additionally catches a patch that was accepted but didn't take.
verify_routing
