export interface CacheKey {
  sub: string;
  scope: string;
  audience: string;
  /**
   * OIDC `acr` of the SUBJECT token. The exchanged token inherits the subject's
   * `acr` (the token-exchange procedure re-emits it), so `acr` is part of what
   * determines the cached value and MUST be part of the key. Omitting it means a
   * post-step-up request (acr=mfa) collides with the pre-step-up entry
   * (acr=password) and reuses a token the resource server rejects — leaving the
   * user stuck in a step-up loop until the TTL expires.
   */
  acr: string;
}

export interface CacheValue {
  accessToken: string;
  /** Seconds reported by the issuer in `expires_in`. */
  expiresInSec: number;
  /** Effective scope string from the issuer. */
  scope: string;
}

interface Entry extends CacheValue {
  expiresAtMs: number;
}

export class TokenExchangeCache {
  private readonly store = new Map<string, Entry>();
  private readonly ttlMs: number;

  constructor(opts: { ttlMs: number }) {
    if (opts.ttlMs <= 0) throw new Error('ttlMs must be positive');
    this.ttlMs = opts.ttlMs;
  }

  private static keyOf(k: CacheKey): string {
    return `${k.sub}\0${k.audience}\0${k.scope}\0${k.acr}`;
  }

  get(key: CacheKey): CacheValue | undefined {
    const k = TokenExchangeCache.keyOf(key);
    const entry = this.store.get(k);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAtMs) {
      this.store.delete(k);
      return undefined;
    }
    return { accessToken: entry.accessToken, expiresInSec: entry.expiresInSec, scope: entry.scope };
  }

  set(key: CacheKey, value: CacheValue): void {
    this.store.set(TokenExchangeCache.keyOf(key), {
      ...value,
      expiresAtMs: Date.now() + this.ttlMs,
    });
  }

  invalidate(key: CacheKey): void {
    this.store.delete(TokenExchangeCache.keyOf(key));
  }
}
