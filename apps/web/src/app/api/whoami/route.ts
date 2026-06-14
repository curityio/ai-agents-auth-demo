import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getToken } from 'next-auth/jwt';

/**
 * Debug route. Returns the user's session metadata + whether an access token
 * is currently stashed server-side (the raw token NEVER leaves the server).
 * debug-only; gate behind a DEBUG flag before production.
 */
export async function GET(req: Request): Promise<Response> {
  const session = await auth();
  if (!session) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  // Auth.js v5: secureCookie does NOT autodetect from req.url (unlike v4).
  // Without it, getToken derives cookieName + HKDF salt as `authjs.session-token`
  // and silently returns null because the actual cookie is `__Secure-authjs.session-token`.
  const token = await getToken({
    req,
    secret: process.env.AUTH_SECRET,
    secureCookie: true,
  });

  if (process.env.AUTH_DEBUG === 'true') {
    const cookieNames = (req.headers.get('cookie') ?? '')
      .split(';')
      .map((c) => c.trim().split('=')[0])
      .filter(Boolean);
    console.log(
      JSON.stringify({
        tag: 'whoami.debug',
        token_present: Boolean(token),
        token_keys: token ? Object.keys(token) : [],
        token_sub: token?.sub,
        accessToken_typeof: typeof (token as Record<string, unknown> | null)?.accessToken,
        cookies: cookieNames,
      }),
    );
  }

  const safe = {
    sub: token?.sub ?? session.user?.id,
    name: session.user?.name,
    email: session.user?.email,
    has_access_token: Boolean(token?.accessToken),
    access_token_jwt_header: token?.accessToken
      ? safeJwtHeader(token.accessToken as string)
      : null,
    access_token_payload_preview: token?.accessToken
      ? safeJwtPayload(token.accessToken as string)
      : null,
    token_type: token?.tokenType,
    expires_at: token?.expiresAt,
  };
  return NextResponse.json(safe);
}

function safeJwtHeader(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[0]!, 'base64url').toString());
  } catch {
    return null;
  }
}

/** Decode JWT payload — for narrative purposes only (never trust unverified claims). */
function safeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString());
    // Strip anything sensitive-looking before returning to a (server-trusted) UI consumer.
    delete claims.signature;
    return claims;
  } catch {
    return null;
  }
}
