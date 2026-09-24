import { createHash } from 'node:crypto';
import type { ExchangeResponse } from './exchange-handler.js';

/**
 * Short-lived memory of exchanged tokens, keyed by (caller token, audience).
 *
 * Why it exists: Streamable HTTP is stateless, so one question from the user is
 * three gateway requests (server/discover, tools/list, tools/call), and agentgateway
 * calls this shim's extAuthz on every one — three Curity exchanges per question,
 * three `auth.token_exchange` spans, three `jti`s. The exchanged token is a pure
 * function of (caller token, actor SVID, route audience): Curity's decision — role
 * gate, `may_act`, the ACR TIA — was made against exactly that caller token, so
 * handing the same token back for the same inputs is the same decision, reused.
 *
 * Why the key is a hash of the WHOLE caller token, not its claims: a re-issued
 * token (new login, step-up to acr=mfa, refresh) is a different byte string and
 * therefore a different key by construction — nothing is inferred from `sub`/`acr`,
 * and the raw token never sits in a Map key. Revocation is unchanged: the origin
 * validates the issued JWT offline, so a minted token is good until `exp` whether
 * or not the shim remembers it; the cache only reuses it within a window that is
 * the SHORTER of the configured TTL and the issued lifetime minus a skew.
 */
export interface ExchangeCacheOptions {
  /** Cap on how long an entry may be reused. 0 disables caching. */
  ttlSeconds: number;
  /** LRU bound: a burst of distinct caller tokens cannot grow memory unbounded. */
  maxEntries: number;
  /** Safety margin under the issued token's `expires_in` (default 30 s). */
  skewSeconds?: number;
}

interface Entry {
  access_token: string;
  token_type: string;
  expiresAtMs: number; // issued token expiry (minus skew), for the remaining-lifetime report
  reuseUntilMs: number; // when this entry stops being served
}

export class ExchangeCache {
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly skewMs: number;

  constructor(opts: ExchangeCacheOptions) {
    if (opts.ttlSeconds < 0) throw new Error('ttlSeconds must be >= 0');
    if (opts.maxEntries < 1) throw new Error('maxEntries must be >= 1');
    this.ttlMs = opts.ttlSeconds * 1000;
    this.maxEntries = opts.maxEntries;
    this.skewMs = (opts.skewSeconds ?? 30) * 1000;
  }

  private static keyOf(callerToken: string, audience: string): string {
    return `${createHash('sha256').update(callerToken).digest('base64url')}\0${audience}`;
  }

  get(callerToken: string, audience: string): ExchangeResponse | undefined {
    const k = ExchangeCache.keyOf(callerToken, audience);
    const e = this.store.get(k);
    if (!e) return undefined;
    const now = Date.now();
    if (now >= e.reuseUntilMs) {
      this.store.delete(k);
      return undefined;
    }
    // Refresh recency (Map preserves insertion order → delete + set = move to the end).
    this.store.delete(k);
    this.store.set(k, e);
    return {
      access_token: e.access_token,
      token_type: e.token_type,
      expires_in: Math.floor((e.expiresAtMs + this.skewMs - now) / 1000),
    };
  }

  set(callerToken: string, audience: string, token: ExchangeResponse): void {
    if (this.ttlMs === 0) return;
    const now = Date.now();
    const lifetimeMs = token.expires_in * 1000 - this.skewMs;
    if (lifetimeMs <= 0) return; // about to expire: not worth handing out twice
    const k = ExchangeCache.keyOf(callerToken, audience);
    this.store.delete(k);
    this.store.set(k, {
      access_token: token.access_token,
      token_type: token.token_type,
      expiresAtMs: now + lifetimeMs,
      reuseUntilMs: now + Math.min(this.ttlMs, lifetimeMs),
    });
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
  }

  /** Test/diagnostic view of the keys (hashes + audiences, never raw tokens). */
  keys(): IterableIterator<string> {
    return this.store.keys();
  }

  get size(): number {
    return this.store.size;
  }
}
