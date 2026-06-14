import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getToken } from 'next-auth/jwt';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';

const AGENT_URL = process.env.AGENT_COPILOT_URL ?? 'http://agent-copilot.agents.svc.cluster.local:8081';

/**
 * BFF endpoint. Browser calls this; this server-side handler calls the agent
 * over the cluster network with the user's Curity access token (which never
 * touches the browser).
 */
export async function POST(req: Request) {
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

  const body = (await req.json()) as { message?: string };
  if (!body.message) {
    return NextResponse.json({ error: 'message required' }, { status: 400 });
  }

  // OBO-chain INFO log: the BFF forwarding the user's token to agent-copilot.
  const tok = summarizeJwt(token.accessToken as string);
  oboLog({
    service: 'web',
    kind: 'CALL',
    headline: '→ agent-copilot POST /chat',
    fields: {
      user: tok.sub,
      scope: tok.scope,
      acr: tok.acr,
      roles: tok.roles,
      'token aud': tok.aud,
      message: body.message,
    },
  });

  const upstream = await fetch(`${AGENT_URL}/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token.accessToken}`,
    },
    body: JSON.stringify({ message: body.message }),
  });

  // Detect typed responses from the privileged (restart) path.
  if (upstream.status === 401 || upstream.status === 403) {
    const raw = await upstream.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      // non-JSON body — fall through to passthrough
    }
    const kind =
      parsed && typeof parsed === 'object' ? (parsed as { kind?: string }).kind : undefined;

    if (upstream.status === 401 && kind === 'step-up') {
      const body = parsed as { kind: string; acrValues: string; scope: string; resourceMetadata: string };
      let authServer = '';
      try {
        const md = await fetch(body.resourceMetadata, { signal: AbortSignal.timeout(3000) }).then(r =>
          r.json(),
        );
        authServer = (md as { authorization_servers?: string[] }).authorization_servers?.[0] ?? '';
      } catch {
        // best-effort: UI can still offer MFA without the authServer hint
      }
      return NextResponse.json(
        { kind: 'step-up', acrValues: body.acrValues, scope: body.scope, authServer },
        { status: 401 },
      );
    }

    if (upstream.status === 403 && kind === 'access-denied') {
      const body = parsed as { kind: string; reason: string };
      return NextResponse.json({ kind: 'access-denied', reason: body.reason }, { status: 403 });
    }

    // Non-typed or non-JSON: pass through with original status + content-type
    return new NextResponse(raw, {
      status: upstream.status,
      headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
    });
  }

  const text = await upstream.text();
  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}
