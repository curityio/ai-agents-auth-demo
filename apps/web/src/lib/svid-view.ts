/**
 * View model for the Workload identities panel. Pure: no React, no Date, so
 * every rule that decides what the cards show is unit-testable.
 */
import { listClaim } from '@/lib/token-view';

export interface SvidView {
  workload: string;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  iat?: number;
  exp?: number;
  ttl_seconds?: number;
  error?: string;
}

const SPIFFE_NS = /^spiffe:\/\/[^/]+\/ns\/([^/]+)\/sa\/[^/]+$/;

export function svidNamespace(sub: string | undefined): string | undefined {
  if (!sub) return undefined;
  const m = SPIFFE_NS.exec(sub);
  return m ? m[1] : undefined;
}

export interface SharedFacts {
  iss: string;
  aud: string[];
}

/**
 * `iss` and `aud` are what make an SVID acceptable as an `actor_token` at
 * Curity's token endpoint, so every workload's SVID carries the same values.
 * Hoist them out of the cards when they all agree; if they ever differ, return
 * nothing and let each card show its own.
 */
export function sharedFacts(svids: SvidView[]): SharedFacts | undefined {
  const usable = svids.filter((s) => !s.error && s.iss);
  if (usable.length === 0) return undefined;
  const iss = usable[0]!.iss!;
  const aud = listClaim(usable[0]!.aud);
  const same = usable.every((s) => s.iss === iss && listClaim(s.aud).join(' ') === aud.join(' '));
  return same ? { iss, aud } : undefined;
}

export interface Lifetime {
  remaining: number;
  /** Total lifetime in seconds, when `iat` is known. */
  total?: number;
  /** Fraction of the lifetime still left, 0..1 (1 when total is unknown). */
  fraction: number;
  level: 'ok' | 'low' | 'expired';
}

const LOW_SECONDS = 60;

export function lifetime(s: { iat?: number; exp?: number }, nowMs: number): Lifetime | undefined {
  if (s.exp === undefined) return undefined;
  const remaining = Math.max(0, Math.round(s.exp - nowMs / 1000));
  const total = s.iat !== undefined ? Math.max(0, s.exp - s.iat) : undefined;
  const fraction = total ? Math.min(1, remaining / total) : remaining > 0 ? 1 : 0;
  const level = remaining <= 0 ? 'expired' : remaining < LOW_SECONDS ? 'low' : 'ok';
  return { remaining, total, fraction, level };
}

/** Workloads whose SVID in `next` was issued after the one in `prev`. */
export function rotatedWorkloads(prev: SvidView[] | null, next: SvidView[]): Set<string> {
  const out = new Set<string>();
  if (!prev) return out;
  const before = new Map(prev.map((s) => [s.workload, s.iat]));
  for (const s of next) {
    const was = before.get(s.workload);
    if (was !== undefined && s.iat !== undefined && s.iat > was) out.add(s.workload);
  }
  return out;
}
