#!/usr/bin/env bash
# Smoke test for the MCP protocol revision negotiated ACROSS agentgateway.
#
# The other smoke scripts drive MCP as hand-rolled 2025-era JSON-RPC, so they
# pass regardless of which revision the hop actually speaks. This one connects
# with the real v2 client (the same `@modelcontextprotocol/client` the agents
# use, run from inside the agent-copilot pod) and reports what was negotiated.
#
# Why it matters: 2026-07-28 is REQUIRED end to end. The MCP servers run
# `legacy: 'reject'` and the agents pin the revision, because a 2025-era hop
# carries no `Mcp-Name` header — and the gateway's per-tool authz rules key on
# exactly that header. A silent downgrade would therefore not just be cosmetic,
# it would open an authorization gap. This test is what makes the negotiated
# revision observable rather than assumed.
#
# The MCP servers' own support is proven by their unit tests
# (apps/mcp-*/tests/mcp-http.test.ts pin the revision). So if a hop below
# negotiates anything else, agentgateway altered the negotiation — the origin
# servers are not the limiter.
#
# Assertions:
#   [1/4] READ tier through the gateway: connect + tools/list succeeds, on
#         revision 2026-07-28 with no session id.
#   [2/4] Tier filtering still holds in whatever revision was negotiated: an
#         inspect:read caller sees ONLY the inspect tools.
#   [3/4] WRITE tier through the gateway: connect + tools/list succeeds (needs
#         acr=mfa + role sre/oncall), on revision 2026-07-28.
#   [4/4] Cross-tier denial survives: the inspect:read token is refused on /ops/mcp.
#
# Required env: SMOKE_SUBJECT_TOKEN — a fresh Curity access token for Alice,
# obtained WITH MFA (the write tier needs acr=mfa). See scripts/mint-mcp-token.sh.
#
# Exit codes: 0 on success, non-zero on any failed assertion.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATEWAY_BASE="${GATEWAY_BASE:-http://agentgateway.mcp.svc.cluster.local:8080}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note()  { printf '==> %s\n' "$*"; }

if [[ -z "${SMOKE_SUBJECT_TOKEN:-}" ]]; then
  red "SMOKE_SUBJECT_TOKEN env var is required (a fresh MFA'd Curity token for Alice)."
  red "See scripts/mint-mcp-token.sh for how to grab one."
  exit 78  # EX_CONFIG
fi

# Connect with the real v2 client from inside the agent-copilot pod and print a
# one-line JSON verdict. `mode: 'auto'` mirrors packages/agent-runtime exactly.
# Args: $1 url  $2 bearer
probe() {
  kubectl -n agents exec deploy/agent-copilot -c agent -- \
    env U="$1" B="$2" sh -c 'cd /app/packages/agent-runtime && node -e "
(async () => {
  const { Client, StreamableHTTPClientTransport } = await import(\"@modelcontextprotocol/client\");
  const url = process.env.U, bearer = process.env.B;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { authorization: \"Bearer \" + bearer } },
  });
  const client = new Client({ name: \"protocol-probe\", version: \"0.0.1\" },
    { versionNegotiation: { mode: \"auto\" } });
  await client.connect(transport);
  const listed = await client.listTools();
  process.stdout.write(JSON.stringify({
    ok: true,
    protocolVersion: transport.protocolVersion,
    sessionId: transport.sessionId ?? null,
    tools: listed.tools.map(t => t.name).sort(),
  }));
  await client.close();
})().catch(e => process.stdout.write(JSON.stringify({ ok: false, error: String(e && e.message || e) })));
"' 2>/dev/null || true
}

# Assert the negotiated revision. 2026-07-28 is now REQUIRED, not preferred:
# the servers run `legacy: 'reject'` and the agents pin the revision, so anything
# else means a hop in between rewrote the negotiation — and a hop that can
# downgrade us to a revision without `Mcp-Name` can bypass the gateway's
# per-tool authz rules. Hence a hard failure rather than a warning.
require_era() {
  local verdict="$1" label="$2"
  local ver
  ver=$(echo "$verdict" | jq -r '.protocolVersion // "unknown"')
  if [[ "$ver" != "2026-07-28" ]]; then
    red "  $label negotiated MCP $ver, expected 2026-07-28."
    red "  The MCP servers reject 2025-era callers and the agents pin the revision,"
    red "  so this means agentgateway altered the negotiation. Per-tool authz keyed"
    red "  on Mcp-Name cannot be trusted in this state."
    return 1
  fi
  green "  $label negotiated MCP $ver (modern: no session, server/discover)"
  [[ "$(echo "$verdict" | jq -r '.sessionId')" == "null" ]] \
    || { red "  expected no session id on the modern revision"; return 1; }
}

# ----- mint the READ-tier token -------------------------------------------------
note "[1/4] READ tier: connect through the gateway at /inspect/mcp"
INSPECT_TOKEN=$(SMOKE_SUBJECT_TOKEN="$SMOKE_SUBJECT_TOKEN" bash "$SCRIPT_DIR/mint-mcp-token.sh" inspect 2>/dev/null)
[[ -n "$INSPECT_TOKEN" ]] || { red "could not mint an inspect:read gateway token"; exit 1; }

INSPECT_VERDICT=$(probe "$GATEWAY_BASE/inspect/mcp" "$INSPECT_TOKEN")
if [[ "$(echo "$INSPECT_VERDICT" | jq -r '.ok // false')" != "true" ]]; then
  red "  connect/tools-list failed: $INSPECT_VERDICT"
  exit 1
fi
green "  OK (tools: $(echo "$INSPECT_VERDICT" | jq -rc '.tools'))"
require_era "$INSPECT_VERDICT" "READ tier"

# ----- [2/4] tier filtering ------------------------------------------------------
note "[2/4] Tier filtering: an inspect:read caller must see ONLY inspect tools"
OBS_TOOLS=$(echo "$INSPECT_VERDICT" | jq -rc '.tools')
EXPECTED_INSPECT='["get_deployment","get_pod_logs","list_pods"]'
if [[ "$OBS_TOOLS" != "$EXPECTED_INSPECT" ]]; then
  red "  tools/list mismatch: got $OBS_TOOLS, expected $EXPECTED_INSPECT"
  red "  (an ops tool leaking in here would mean the gateway's tier filter broke)"
  exit 1
fi
green "  OK (no ops tools visible to an inspect:read caller)"

# ----- [3/4] write tier ----------------------------------------------------------
note "[3/4] WRITE tier: connect through the gateway at /ops/mcp (needs acr=mfa)"
OPS_TOKEN=$(SMOKE_SUBJECT_TOKEN="$SMOKE_SUBJECT_TOKEN" bash "$SCRIPT_DIR/mint-mcp-token.sh" ops 2>/dev/null)
[[ -n "$OPS_TOKEN" ]] || { red "could not mint an ops:write gateway token (is the subject token acr=mfa?)"; exit 1; }

OPS_VERDICT=$(probe "$GATEWAY_BASE/ops/mcp" "$OPS_TOKEN")
if [[ "$(echo "$OPS_VERDICT" | jq -r '.ok // false')" != "true" ]]; then
  red "  connect/tools-list failed: $OPS_VERDICT"
  exit 1
fi
green "  OK (tools: $(echo "$OPS_VERDICT" | jq -rc '.tools'))"
require_era "$OPS_VERDICT" "WRITE tier"

OPS_TOOLS=$(echo "$OPS_VERDICT" | jq -rc '.tools')
EXPECTED_OPS='["restart_deployment","scale_deployment","set_deployment_image"]'
if [[ "$OPS_TOOLS" != "$EXPECTED_OPS" ]]; then
  red "  tools/list mismatch: got $OPS_TOOLS, expected $EXPECTED_OPS"
  exit 1
fi

# ----- [4/4] cross-tier denial ---------------------------------------------------
note "[4/4] Cross-tier denial: the inspect:read token must be refused on /ops/mcp"
CROSS_VERDICT=$(probe "$GATEWAY_BASE/ops/mcp" "$INSPECT_TOKEN")
if [[ "$(echo "$CROSS_VERDICT" | jq -r '.ok // false')" == "true" ]]; then
  red "  inspect:read token was ACCEPTED on the ops tier: $(echo "$CROSS_VERDICT" | jq -rc '.tools')"
  exit 1
fi
green "  OK (denied: $(echo "$CROSS_VERDICT" | jq -r '.error' | head -c 120))"

echo
green "ALL MCP PROTOCOL SMOKE CHECKS COMPLETED"
