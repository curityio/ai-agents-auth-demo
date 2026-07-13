import { type Attributes, trace } from '@opentelemetry/api';
import type { VerifiedJwt } from './verify.js';

interface ActNode {
  sub?: string;
  act?: ActNode | null;
}

/** Walk the RFC 8693 nested `act` claim outer→inner, collecting `sub` values. */
function flattenActChain(top: unknown): string[] {
  const chain: string[] = [];
  let cur = top as ActNode | null | undefined;
  while (cur && typeof cur === 'object') {
    if (typeof cur.sub !== 'string') break;
    chain.push(cur.sub);
    const next = cur.act;
    if (!next || typeof next !== 'object') break;
    cur = next;
  }
  return chain;
}

/**
 * Build the human-identity span attributes from a validated token.
 * Pure (no OTel side effects) so it is trivially testable.
 */
export function buildIdentityAttributes(verified: VerifiedJwt): Attributes {
  const { payload } = verified;
  const attrs: Attributes = {};
  if (typeof payload.sub === 'string') attrs['auth.sub'] = payload.sub;
  if (verified.scopes.size > 0) attrs['auth.scope'] = [...verified.scopes].join(' ');
  if (typeof payload.acr === 'string') attrs['auth.acr'] = payload.acr;

  if (payload.aud) {
    attrs['auth.aud'] = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  }

  const roles = (payload as Record<string, unknown>).roles;
  if (Array.isArray(roles) && roles.length > 0) {
    attrs['auth.roles'] = roles.filter((r): r is string => typeof r === 'string');
  }

  const act = flattenActChain(payload.act);
  if (act.length > 0) attrs['auth.act'] = act;
  return attrs;
}

/**
 * Stamp human-identity attributes onto the active span (the auto-instrumented
 * HTTP server span). No-op if there is no active span. Call right after
 * verifyJwt() succeeds.
 */
export function decorateSpanWithIdentity(verified: VerifiedJwt): void {
  trace.getActiveSpan()?.setAttributes(buildIdentityAttributes(verified));
}
