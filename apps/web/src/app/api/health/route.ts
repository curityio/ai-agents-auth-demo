import { NextResponse } from 'next/server';

/**
 * Unauthenticated liveness/readiness endpoint. Returns 200 once the Next.js
 * server is accepting requests. Deliberately does NOT call `auth()` — we don't
 * want the probe to fail just because Curity is briefly unavailable.
 */
export async function GET() {
  return NextResponse.json({ ok: true, service: 'web' });
}
