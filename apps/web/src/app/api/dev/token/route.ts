import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getToken } from 'next-auth/jwt';

/**
 * Demo-only escape hatch. Returns the raw user access token so it can be pasted
 * into `SMOKE_SUBJECT_TOKEN` for `make smoke`. Gated on `AUTH_DEBUG=true` —
 * returns 404 otherwise so the route doesn't even acknowledge its own existence.
 *
 * Remove (or convert to a structured debug stream) before production hardening.
 */
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
  const accessToken = token?.accessToken as string | undefined;
  if (!accessToken) {
    return NextResponse.json({ error: 'no access token in session' }, { status: 500 });
  }

  // SECURITY: intentionally logs the raw access token. Demo-only convenience
  // so the operator can `kubectl logs | grep dev.token` instead of clicking
  // through the browser. Gated on AUTH_DEBUG=true above. Remove together with
  // this route before production hardening.
  console.log(
    JSON.stringify({
      tag: 'dev.token',
      sub: token?.sub,
      access_token: accessToken,
    }),
  );

  return NextResponse.json({
    sub: token?.sub,
    expires_at: token?.expiresAt,
    access_token: accessToken,
    curl_smoke_hint:
      'export SMOKE_SUBJECT_TOKEN="<paste access_token value>"; make smoke',
  });
}
