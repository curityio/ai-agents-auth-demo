#!/usr/bin/env bash
# Smoke test for the authorization rules enforced AT agentgateway (as opposed to
# the coarse per-tier scope gate, which smoke-mcp-protocol.sh covers, or the
# downstream checks in mcp-ops, which smoke-stepup.sh covers).
#
# Two rules live in the gateway's `authorization` policy
# (k8s/workloads/agentgateway-config.yaml). Both are HTTP-layer rules keyed on
# 2026-07-28 request headers, which is why they only became expressible once the
# 2025 fallback was removed — on a legacy hop neither header exists:
#
#   1. Per-tool role split — `set_deployment_image` requires the `sre` role,
#      keyed on `Mcp-Name`. It is expressed here rather than in `mcpAuthorization`
#      because the MCP-layer policy couples call-denial to tools/list visibility:
#      gating it there would HIDE the tool from an oncall caller and its LLM would
#      loop silently instead of surfacing a denial. mcp-ops still enforces the same
#      split downstream — the gateway rule is a first line, not the only one.
#
#   2. Namespace confinement — any explicit namespace other than `prod` is refused,
#      keyed on `Mcp-Param-Namespace` (SEP-2243). The tools declare
#      `x-mcp-header: Namespace` on their `namespace` input so a conforming client
#      mirrors the argument into that header. Previously this constraint existed
#      only as ops-api/inspect-api RBAC, i.e. two hops later.
#
# Assertions:
#   [1/4] omitting `namespace` is unaffected by the confinement rule (the server
#         defaults it to prod) — guards against the rule over-blocking.
#   [2/4] an explicit `namespace: prod` is allowed.
#   [3/4] `namespace: kube-system` is refused at the gateway, on BOTH tiers.
#   [4/4] `set_deployment_image` is allowed for alice (sre). If SMOKE_TOKEN_CAROL
#         is set (carol = oncall, no sre) the denial is asserted too; otherwise
#         skipped, since alice (sre) passes the rule and cannot demonstrate it.
#
# Required env: SMOKE_SUBJECT_TOKEN — a fresh MFA'd Curity access token for Alice.
# Optional env: SMOKE_TOKEN_CAROL   — enables the [4/4] negative half.
#
# Exit codes: 0 on success, non-zero on any failed assertion.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_BASE="${GATEWAY_BASE:-http://agentgateway.mcp.svc.cluster.local:8080}"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
note()   { printf '==> %s\n' "$*"; }

if [[ -z "${SMOKE_SUBJECT_TOKEN:-}" ]]; then
  red "SMOKE_SUBJECT_TOKEN env var is required (a fresh MFA'd Curity token for Alice)."
  red "See scripts/mint-mcp-token.sh for how to grab one."
  exit 78  # EX_CONFIG
fi

# One 2026-07-28 tools/call through the gateway, from inside a cluster pod.
# Echoes "<status>:<body-slice>". Mirrors what a conforming client sends: the
# Mcp-Name and Mcp-Param-Namespace headers ARE the rules' inputs, so omitting them
# would exercise a different policy path than production traffic.
# Args: $1 url  $2 bearer  $3 tool  $4 arguments-json
call_tool() {
  kubectl -n agents exec deploy/agent-copilot -c agent -- \
    env U="$1" B="$2" T="$3" A="$4" node -e '
(async () => {
  const args = JSON.parse(process.env.A);
  const params = { name: process.env.T, arguments: args, _meta: {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "smoke", version: "0" },
    "io.modelcontextprotocol/clientCapabilities": {}
  } };
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer " + process.env.B,
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": "tools/call",
    "mcp-name": process.env.T
  };
  if (args.namespace) headers["mcp-param-namespace"] = args.namespace;
  const r = await fetch(process.env.U, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) });
  process.stdout.write(String(r.status) + ":" + (await r.text()).slice(0, 20000));
})().catch(e => process.stdout.write("ERR:" + e.message));
' 2>/dev/null || true
}

note "Minting gateway tokens for both tiers"
INSPECT_TOKEN=$(SMOKE_SUBJECT_TOKEN="$SMOKE_SUBJECT_TOKEN" bash "$SCRIPT_DIR/mint-mcp-token.sh" inspect 2>/dev/null)
OPS_TOKEN=$(SMOKE_SUBJECT_TOKEN="$SMOKE_SUBJECT_TOKEN" bash "$SCRIPT_DIR/mint-mcp-token.sh" ops 2>/dev/null)
[[ -n "$INSPECT_TOKEN" && -n "$OPS_TOKEN" ]] || { red "could not mint gateway tokens (is the subject token acr=mfa?)"; exit 1; }
INSPECT_URL="$GATEWAY_BASE/inspect/mcp"
OPS_URL="$GATEWAY_BASE/ops/mcp"

# ----- [1/4] omitted namespace must NOT trip the confinement rule ----------------
note "[1/4] namespace omitted → allowed (server defaults to prod)"
OUT=$(call_tool "$INSPECT_URL" "$INSPECT_TOKEN" list_pods '{}')
case "$OUT" in
  200*) green "  OK (allowed)" ;;
  *) red "  the confinement rule over-blocks a call that omits namespace: ${OUT:0:200}"; exit 1 ;;
esac

# ----- [2/4] explicit prod is allowed -------------------------------------------
note "[2/4] namespace=prod → allowed"
OUT=$(call_tool "$INSPECT_URL" "$INSPECT_TOKEN" list_pods '{"namespace":"prod"}')
case "$OUT" in
  200*) green "  OK (allowed)" ;;
  *) red "  expected 200 for the permitted namespace, got: ${OUT:0:200}"; exit 1 ;;
esac

# ----- [3/4] cross-namespace refused at the gateway, on BOTH tiers ---------------
note "[3/4] namespace=kube-system → refused at the gateway (read tier)"
OUT=$(call_tool "$INSPECT_URL" "$INSPECT_TOKEN" list_pods '{"namespace":"kube-system"}')
case "$OUT" in
  403*) green "  OK (gateway refused: ${OUT:0:60})" ;;
  200*) red "  cross-namespace READ was ALLOWED — namespace confinement is not in force"; exit 1 ;;
  *) red "  expected 403, got: ${OUT:0:200}"; exit 1 ;;
esac

note "      namespace=kube-system → refused at the gateway (write tier)"
OUT=$(call_tool "$OPS_URL" "$OPS_TOKEN" restart_deployment '{"name":"order-service","namespace":"kube-system"}')
case "$OUT" in
  403*) green "  OK (gateway refused: ${OUT:0:60})" ;;
  200*) red "  cross-namespace WRITE was ALLOWED — namespace confinement is not in force"; exit 1 ;;
  *) red "  expected 403, got: ${OUT:0:200}"; exit 1 ;;
esac

# ----- [4/4] per-tool role split -------------------------------------------------
# Re-applies the image the deployment already runs, so a pass is a no-op rollout.
note "[4/4] set_deployment_image as alice (sre) → allowed"
OUT=$(call_tool "$OPS_URL" "$OPS_TOKEN" set_deployment_image '{"name":"order-service","image":"busybox:1.37"}')
case "$OUT" in
  200*) green "  OK (allowed for an sre caller)" ;;
  403*) red "  alice holds the sre role but the gateway refused: ${OUT:0:200}"; exit 1 ;;
  *) red "  expected 200, got: ${OUT:0:200}"; exit 1 ;;
esac

if [[ -z "${SMOKE_TOKEN_CAROL:-}" ]]; then
  yellow "  SKIP [4/4-carol]: SMOKE_TOKEN_CAROL not set. Alice holds sre,"
  yellow "    so she cannot demonstrate the denial — sign in as carol (oncall, per"
  yellow "    docs/curity-seed.md) to exercise it."
else
  # A plain carol LOGIN is not enough and the failure downstream is opaque
  # ("could not mint an ops token"), so diagnose it here. Signing in normally
  # yields acr=html-form and scope WITHOUT ops:write; only completing the RFC 9470
  # step-up — ask the copilot to restart something, then re-authenticate with MFA —
  # produces a token carrying both.
  CAROL_ACR=$(printf '%s' "$SMOKE_TOKEN_CAROL" | cut -d. -f2 | python3 -c "
import sys, base64, json
s = sys.stdin.read().strip(); s += '=' * (-len(s) % 4)
p = json.loads(base64.urlsafe_b64decode(s))
print(p.get('acr', '<none>'), 'ops:write' in str(p.get('scope', '')).split())
" 2>/dev/null)
  if [[ "$CAROL_ACR" != "mfa True" ]]; then
    yellow "  SKIP [4/4-carol]: the supplied carol token cannot reach the ops tier"
    yellow "    (acr / has-ops:write = '$CAROL_ACR'; need 'mfa True')."
    yellow "    A plain login gives acr=html-form and no ops:write. Sign in as carol,"
    yellow "    ask the copilot to restart a deployment, complete the MFA step-up, then"
    yellow "    grab the token that flow produces."
    echo
    green "ALL GATEWAY AUTHZ SMOKE CHECKS COMPLETED"
    exit 0
  fi

  note "      set_deployment_image as carol (oncall, no sre) → refused at the gateway"
  CAROL_OPS=$(SMOKE_SUBJECT_TOKEN="$SMOKE_TOKEN_CAROL" bash "$SCRIPT_DIR/mint-mcp-token.sh" ops 2>/dev/null)
  [[ -n "$CAROL_OPS" ]] || { red "  could not mint an ops token for carol"; exit 1; }
  OUT=$(call_tool "$OPS_URL" "$CAROL_OPS" set_deployment_image '{"name":"order-service","image":"busybox:1.37"}')
  case "$OUT" in
    403*) green "  OK (gateway refused the non-sre caller: ${OUT:0:60})" ;;
    200*) red "  carol lacks the sre role but the image update SUCCEEDED"; exit 1 ;;
    *) red "  expected 403, got: ${OUT:0:200}"; exit 1 ;;
  esac
  note "      carol may still restart_deployment (oncall is enough)"
  OUT=$(call_tool "$OPS_URL" "$CAROL_OPS" restart_deployment '{"name":"order-service"}')
  case "$OUT" in
    200*) green "  OK (restart allowed — the rule targets only set_deployment_image)" ;;
    *) red "  the role rule over-blocks restart_deployment for an oncall caller: ${OUT:0:200}"; exit 1 ;;
  esac
fi

echo
green "ALL GATEWAY AUTHZ SMOKE CHECKS COMPLETED"
