import { describe, it, expect, vi, afterEach } from 'vitest';
import { ExchangeCache } from '../src/exchange-cache.js';

const token = { access_token: 'narrowed', token_type: 'Bearer', expires_in: 600 };

afterEach(() => {
  vi.useRealTimers();
});

describe('ExchangeCache', () => {
  it('returns a stored token for the same caller token + audience', () => {
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 10 });
    c.set('caller.jwt', 'mcp-inspect', token);
    expect(c.get('caller.jwt', 'mcp-inspect')?.access_token).toBe('narrowed');
  });

  it('keys on the WHOLE caller token, so a re-issued token (new jti) is a miss', () => {
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 10 });
    c.set('caller.jwt.A', 'mcp-inspect', token);
    expect(c.get('caller.jwt.B', 'mcp-inspect')).toBeUndefined();
  });

  it('keys on the audience, so the same caller token exchanged for another tier is a miss', () => {
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 10 });
    c.set('caller.jwt', 'mcp-inspect', token);
    expect(c.get('caller.jwt', 'mcp-ops')).toBeUndefined();
  });

  it('never stores the raw caller token as the key', () => {
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 10 });
    c.set('super-secret-caller-jwt', 'mcp-inspect', token);
    expect(JSON.stringify([...c.keys()])).not.toContain('super-secret-caller-jwt');
  });

  it('expires after the configured TTL', () => {
    vi.useFakeTimers();
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 10 });
    c.set('caller.jwt', 'mcp-inspect', token);
    vi.advanceTimersByTime(59_000);
    expect(c.get('caller.jwt', 'mcp-inspect')).toBeDefined();
    vi.advanceTimersByTime(1_001);
    expect(c.get('caller.jwt', 'mcp-inspect')).toBeUndefined();
  });

  it('bounds the TTL by the issued token lifetime minus the skew, whichever is shorter', () => {
    vi.useFakeTimers();
    const c = new ExchangeCache({ ttlSeconds: 600, maxEntries: 10, skewSeconds: 30 });
    c.set('caller.jwt', 'mcp-inspect', { ...token, expires_in: 90 });
    vi.advanceTimersByTime(59_000);
    expect(c.get('caller.jwt', 'mcp-inspect')).toBeDefined();
    vi.advanceTimersByTime(1_001);
    expect(c.get('caller.jwt', 'mcp-inspect')).toBeUndefined();
  });

  it('does not store a token whose lifetime is within the skew', () => {
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 10, skewSeconds: 30 });
    c.set('caller.jwt', 'mcp-inspect', { ...token, expires_in: 30 });
    expect(c.get('caller.jwt', 'mcp-inspect')).toBeUndefined();
  });

  it('reports the REMAINING lifetime on a hit, not the original expires_in', () => {
    vi.useFakeTimers();
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 10 });
    c.set('caller.jwt', 'mcp-inspect', { ...token, expires_in: 600 });
    vi.advanceTimersByTime(20_000);
    expect(c.get('caller.jwt', 'mcp-inspect')?.expires_in).toBe(580);
  });

  it('evicts the least recently used entry beyond maxEntries', () => {
    const c = new ExchangeCache({ ttlSeconds: 60, maxEntries: 2 });
    c.set('t1', 'mcp-ops', token);
    c.set('t2', 'mcp-ops', token);
    c.get('t1', 'mcp-ops'); // t1 is now most recently used
    c.set('t3', 'mcp-ops', token);
    expect(c.get('t2', 'mcp-ops')).toBeUndefined();
    expect(c.get('t1', 'mcp-ops')).toBeDefined();
    expect(c.get('t3', 'mcp-ops')).toBeDefined();
  });

  it('a TTL of 0 disables caching', () => {
    const c = new ExchangeCache({ ttlSeconds: 0, maxEntries: 10 });
    c.set('caller.jwt', 'mcp-inspect', token);
    expect(c.get('caller.jwt', 'mcp-inspect')).toBeUndefined();
  });
});
