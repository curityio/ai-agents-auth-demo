import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getToken } from 'next-auth/jwt';

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

  const upstream = await fetch(`${AGENT_URL}/last-token`, {
    headers: { authorization: `Bearer ${token.accessToken as string}` },
    cache: 'no-store',
  });
  if (!upstream.ok) {
    // A 401 here means the user's access token expired (the agent rejected it).
    // Surface it distinctly so the UI can prompt a re-login rather than show a
    // raw 502 with a nested error body.
    if (upstream.status === 401) {
      return NextResponse.json({ error: 'session_expired' }, { status: 401 });
    }
    console.error('[obo-chain] upstream error', upstream.status, await upstream.text());
    return NextResponse.json({ error: 'upstream_error', status: upstream.status }, { status: 502 });
  }
  const body = await upstream.json();
  return NextResponse.json(body);
}
