import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getToken } from 'next-auth/jwt';

/**
 * Demo-only token inspector backend. Returns the full OBO chain WITH raw token
 * strings (each hop's `token`) so the /tokens UI can show + copy them.
 *
 * Gated on `AUTH_DEBUG=true` — 404 otherwise, so the route doesn't acknowledge
 * its own existence in a hardened build (same posture as /api/dev/token). The
 * raw tokens come from agent-copilot's /last-token?raw=1, which only includes
 * them on this explicit opt-in. Remove together with /api/dev/token before
 * production hardening.
 */
const AGENT_URL =
  process.env.AGENT_COPILOT_URL ?? 'http://agent-copilot.agents.svc.cluster.local:8081';

export async function GET(req: Request): Promise<Response> {
  if (process.env.AUTH_DEBUG !== 'true') {
    return new NextResponse('not found', { status: 404 });
  }
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

  // hop 0 of the returned chain IS the user access token (raw), so a single
  // upstream call covers both "the Curity token" and "the exchanged ones".
  const upstream = await fetch(`${AGENT_URL}/last-token?raw=1`, {
    headers: { authorization: `Bearer ${token.accessToken as string}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    // 401 = the user's access token expired; surface it distinctly so the UI
    // can prompt a re-login instead of showing a raw 502.
    if (upstream.status === 401) {
      return NextResponse.json({ error: 'session_expired' }, { status: 401 });
    }
    console.error('[tokens] upstream error', upstream.status, await upstream.text());
    return NextResponse.json({ error: 'upstream_error', status: upstream.status }, { status: 502 });
  }
  const body = (await upstream.json()) as { chain?: unknown[] };
  return NextResponse.json({
    sub: token.sub,
    expires_at: token.expiresAt,
    chain: body.chain ?? [],
  });
}
