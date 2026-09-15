import { NextResponse } from 'next/server';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';

const SVID_AUDIENCE = 'https://curity.localtest.me/oauth/v2/oauth-token';

// The web container has its own spiffe-helper sidecar writing to the same
// path. Read from disk rather than going through the network for the web's
// own SVID — round-trip cost matters for a debug endpoint hit on every
// "Show workload identity" click.
const webSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: '/run/spiffe/curity-actor.jwt' }],
});

const AGENT_URL = process.env.AGENT_COPILOT_URL ?? 'http://agent-copilot.agents.svc.cluster.local:8081';
const SPECIALIST_URL =
  process.env.AGENT_SPECIALIST_URL ?? 'http://agent-specialist.agents.svc.cluster.local:8082';
const MCP_URL = process.env.MCP_OBSERVABILITY_URL ?? 'http://mcp-observability.mcp.svc.cluster.local:8080';
const MCP_OPS_URL = process.env.MCP_OPS_URL ?? 'http://mcp-ops.mcp.svc.cluster.local:8080';
// agentgateway is the MCP front door and inserts its own SPIFFE ID into every
// downstream act chain. It's a Rust binary with no /spiffe-id of its own, so its
// co-located exchange-shim serves the pod's SVID at :8080/spiffe-id (a no-auth
// gateway route → localhost:8090). See k8s/workloads/agentgateway-config.yaml.
const AGENTGATEWAY_URL = process.env.AGENTGATEWAY_URL ?? 'http://agentgateway.mcp.svc.cluster.local:8080';

interface SvidView {
  workload: string;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  iat?: number;
  exp?: number;
  ttl_seconds?: number;
  error?: string;
}

async function fetchRemote(workload: string, url: string): Promise<SvidView> {
  try {
    const r = await fetch(`${url}/spiffe-id`, { cache: 'no-store' });
    if (!r.ok) return { workload, error: `${r.status} ${r.statusText}` };
    return { workload, ...((await r.json()) as Omit<SvidView, 'workload'>) };
  } catch (e) {
    return { workload, error: String(e) };
  }
}

async function readLocalWebSvid(): Promise<SvidView> {
  const svid = await webSource.getSvid(SVID_AUDIENCE);
  if (!svid) return { workload: 'web', error: 'spiffe_svid_unavailable' };
  const now = Math.floor(Date.now() / 1000);
  return {
    workload: 'web',
    sub: svid.claims.sub,
    aud: svid.claims.aud,
    iss: svid.claims.iss,
    iat: svid.claims.iat,
    exp: svid.claims.exp,
    ttl_seconds: svid.claims.exp - now,
  };
}

// No auth required: this endpoint exposes only SPIFFE IDs (not user identity).
// debug-only; gate behind a DEBUG flag before production.
//
// Returns ONLY the workloads that participate in the requested flow, so the panel
// mirrors the chain the user just exercised (every MCP hop now goes THROUGH the
// agentgateway, so it appears in both flows):
//   - read (default): web → agent-copilot → agentgateway → mcp-observability
//   - privileged:      web → agent-copilot → agent-specialist → agentgateway → mcp-observability + mcp-ops
// The specialist is an inspect → act → verify loop holding TWO tokens: it reads
// the deployment through mcp-observability before and after it writes through
// mcp-ops, so both MCP servers present their SVID as actor_token in that flow.
// (The obs-api/ops-api resource servers are intentionally omitted: they receive the
// exchanged token but perform no exchange of their own, so they aren't token-exchange
// participants.)
export async function GET(req: Request) {
  const flow = new URL(req.url).searchParams.get('flow') === 'privileged' ? 'privileged' : 'read';

  const tail: Promise<SvidView>[] =
    flow === 'privileged'
      ? [
          fetchRemote('agent-specialist', SPECIALIST_URL),
          fetchRemote('agentgateway', AGENTGATEWAY_URL),
          fetchRemote('mcp-observability', MCP_URL),
          fetchRemote('mcp-ops', MCP_OPS_URL),
        ]
      : [
          fetchRemote('agentgateway', AGENTGATEWAY_URL),
          fetchRemote('mcp-observability', MCP_URL),
        ];

  const workloads = await Promise.all([
    readLocalWebSvid(),
    fetchRemote('agent-copilot', AGENT_URL),
    ...tail,
  ]);
  return NextResponse.json({ workloads });
}
