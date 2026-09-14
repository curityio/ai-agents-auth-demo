import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getToken } from 'next-auth/jwt';

/**
 * BFF proxy for the copilot's GET /tools — the per-tier `tools/list` each MCP
 * tier's gateway route returns for the CURRENT user. Same posture as
 * /api/obo-chain: the browser never sees the access token; the BFF attaches it.
 */
const AGENT_URL = process.env.AGENT_COPILOT_URL ?? 'http://agent-copilot.agents.svc.cluster.local:8081';

export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: true,
  });
  if (!token?.accessToken) {
    return NextResponse.json({ error: 'no_access_token' }, { status: 401 });
  }

  const upstream = await fetch(`${AGENT_URL}/tools`, {
    headers: { authorization: `Bearer ${token.accessToken as string}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    if (upstream.status === 401) {
      return NextResponse.json({ error: 'session_expired' }, { status: 401 });
    }
    console.error('[tools] upstream error', upstream.status, await upstream.text());
    return NextResponse.json({ error: 'upstream_error', status: upstream.status }, { status: 502 });
  }
  return NextResponse.json(await upstream.json());
}
