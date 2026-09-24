import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TokenExchangeCache, type CacheKey } from '../src/token-exchange-cache.js';

const key: CacheKey = { sub: 'alice', scope: 'obs:read', audience: 'mcp-observability', acr: 'mfa' };
const value = { accessToken: 'tok.1', expiresInSec: 300, scope: 'obs:read' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-25T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('TokenExchangeCache', () => {
  it('returns undefined on miss', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    expect(c.get(key)).toBeUndefined();
  });

  it('returns a stored value within TTL', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set(key, value);
    expect(c.get(key)).toEqual(value);
  });

  it('expires entries past TTL', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set(key, value);
    vi.advanceTimersByTime(60_001);
    expect(c.get(key)).toBeUndefined();
  });

  it('treats different sub/scope/audience tuples as distinct keys', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set(key, value);
    expect(c.get({ ...key, sub: 'bob' })).toBeUndefined();
    expect(c.get({ ...key, scope: 'obs:read ops:read' })).toBeUndefined();
    expect(c.get({ ...key, audience: 'mcp-ops' })).toBeUndefined();
  });

  // Regression: a step-up changes the subject token's acr (password -> mfa).
  // The exchanged token inherits acr, so the same (sub, scope, audience) with a
  // new acr MUST be a cache miss — otherwise the stale pre-step-up token is
  // reused and the resource server keeps demanding step-up (the MFA loop).
  it('treats a changed acr (step-up) as a distinct key', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set({ ...key, acr: 'urn:se:curity:authentication:html-form:html-auth' }, value);
    expect(c.get({ ...key, acr: 'mfa' })).toBeUndefined();
  });

  it('does not collide when a field happens to contain a space', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set({ sub: 'alice mcp-observability', scope: 'obs:read', audience: 'foo', acr: 'mfa' }, value);
    expect(
      c.get({ sub: 'alice', scope: 'obs:read', audience: 'mcp-observability foo', acr: 'mfa' }),
    ).toBeUndefined();
  });

  it('rejects non-positive ttlMs', () => {
    expect(() => new TokenExchangeCache({ ttlMs: 0 })).toThrow(/ttlMs/);
    expect(() => new TokenExchangeCache({ ttlMs: -1 })).toThrow(/ttlMs/);
  });

  it('invalidate() removes an entry', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set(key, value);
    c.invalidate(key);
    expect(c.get(key)).toBeUndefined();
  });
});

describe('TokenExchangeCache per-call TTL (TOKEN_EXCHANGE_CACHE_TTL_SECONDS)', () => {
  // The demo sets the agents' exchange caches to 0 so EVERY question shows its
  // exchanges in the trace — a second question within 60 s used to show none.
  it('set(key, value, 0) stores nothing', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set(key, value, 0);
    expect(c.get(key)).toBeUndefined();
  });

  it('set(key, value, ttlMs) overrides the constructor TTL for that entry', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set(key, value, 5_000);
    vi.advanceTimersByTime(4_999);
    expect(c.get(key)).toEqual(value);
    vi.advanceTimersByTime(2);
    expect(c.get(key)).toBeUndefined();
  });

  it('set(key, value) without a TTL keeps the constructor default', () => {
    const c = new TokenExchangeCache({ ttlMs: 60_000 });
    c.set(key, value);
    vi.advanceTimersByTime(59_999);
    expect(c.get(key)).toEqual(value);
  });
});
