/**
 * obtainMcpToken's 60 s cache vs the transport's 401 seam. When the SDK reports a
 * 401 the provider re-acquires with `forced`, which must reach here as
 * `bypassCache` and produce a FRESH exchange — otherwise the retry re-sends the
 * very token that just failed and the seam is a no-op (found in review).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const exchangeToken = vi.fn();
vi.mock('@ai-agents-demo/auth-curity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-agents-demo/auth-curity')>();
  return { ...actual, exchangeToken: (...a: unknown[]) => exchangeToken(...a) };
});
vi.mock('@ai-agents-demo/spiffe', () => ({
  SpiffeJwtSvidSource: class {
    async getSvid() {
      return { jwt: 'svid.jwt' };
    }
  },
}));
vi.mock('../src/cimd-identity.js', () => ({ getCimdIdentity: async () => ({ kid: 'k1' }) }));

import { obtainMcpToken } from '../src/mcp-client.js';
import type { Config } from '../src/config.js';

const cfg = {
  agentClientId: 'https://copilot.localtest.me/.well-known/oauth-client',
  agentPrivateKeyPem: 'pem',
  mcpObservabilityAudience: 'mcp-gateway',
} as unknown as Config;

const base = {
  cfg,
  subjectToken: 'U',
  subjectSub: 'alice-cache-test',
  subjectAcr: 'mfa',
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  scope: 'obs:read',
  recordLastExchange: false,
};

beforeEach(() => {
  exchangeToken.mockReset();
  let n = 0;
  exchangeToken.mockImplementation(async () => ({ accessToken: `TOKEN-${++n}`, expiresInSec: 600, scope: 'obs:read' }));
});

describe('obtainMcpToken cache bypass', () => {
  it('serves a repeat from cache, but bypassCache re-exchanges and replaces the cached token', async () => {
    expect(await obtainMcpToken(base)).toBe('TOKEN-1');
    expect(await obtainMcpToken(base)).toBe('TOKEN-1');
    expect(exchangeToken).toHaveBeenCalledTimes(1);
    expect(await obtainMcpToken({ ...base, bypassCache: true })).toBe('TOKEN-2');
    expect(exchangeToken).toHaveBeenCalledTimes(2);
    // The failing token is gone for later callers too.
    expect(await obtainMcpToken(base)).toBe('TOKEN-2');
    expect(exchangeToken).toHaveBeenCalledTimes(2);
  });
});
