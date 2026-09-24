import { describe, it, expect, vi } from 'vitest';
import { handleExchange } from '../src/exchange-handler.js';
import { ExchangeCache } from '../src/exchange-cache.js';

const deps = {
  getSvidJwt: vi.fn(async () => 'svid.jwt.compact'),
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'agentgateway',
  clientSecret: 'Password1',
  audienceScopes: { 'mcp-observability': 'obs:read', 'mcp-ops': 'ops:write' },
  exchange: vi.fn(async () => ({
    accessToken: 'narrowed.token',
    tokenType: 'Bearer',
    expiresInSec: 300,
    scope: 'obs:read',
    issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
  })),
};

describe('handleExchange', () => {
  it('exchanges caller token using the SVID as actor and returns a token-endpoint body', async () => {
    const res = await handleExchange(
      { callerToken: 'caller.token', targetAudience: 'mcp-observability' },
      deps,
    );
    expect(deps.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'agentgateway',
        clientSecret: 'Password1',
        subjectToken: 'caller.token',
        actorToken: 'svid.jwt.compact',
        audience: 'mcp-observability',
        scope: 'obs:read',
      }),
    );
    expect(res).toEqual({ access_token: 'narrowed.token', token_type: 'Bearer', expires_in: 300 });
  });

  it('derives scope from the audience allow-list, not caller input, for mcp-ops', async () => {
    await handleExchange(
      { callerToken: 'caller.token', targetAudience: 'mcp-ops' },
      deps,
    );
    expect(deps.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'mcp-ops',
        scope: 'ops:write',
      }),
    );
  });

  it('rejects an audience not in the allow-list', async () => {
    await expect(
      handleExchange(
        { callerToken: 'c', targetAudience: 'evil' },
        deps,
      ),
    ).rejects.toThrow(/audience/i);
  });

  it('passes no log-label override: the client id IS the pod name (agentgateway)', async () => {
    // The Curity client is named after the workload that authenticates, like every
    // other client here, so auth-curity's derived label already matches the SPIFFE
    // ID in the `act` chain. An override would be a second name for the same pod.
    await handleExchange(
      { callerToken: 'caller.token', targetAudience: 'mcp-observability' },
      deps,
    );
    expect(deps.exchange).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'agentgateway' }));
    expect(deps.exchange).toHaveBeenCalledWith(
      expect.not.objectContaining({ serviceLabel: expect.anything() }),
    );
  });
});

describe('handleExchange with a cache', () => {
  // Streamable HTTP makes one question three gateway requests (server/discover,
  // tools/list, tools/call) and extAuthz calls the shim on every one, so without a
  // cache each question cost three Curity exchanges. The exchanged token is a pure
  // function of (caller token, audience); remembering it for a short window is the
  // same authorization decision, reused.
  const freshDeps = () => ({
    ...deps,
    exchange: vi.fn(async () => ({
      accessToken: `narrowed.${Math.random()}`,
      tokenType: 'Bearer',
      expiresInSec: 600,
      scope: 'obs:read',
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    })),
    cache: new ExchangeCache({ ttlSeconds: 60, maxEntries: 100 }),
  });

  it('exchanges once for the same caller token + audience and reuses the token', async () => {
    const d = freshDeps();
    const a = await handleExchange({ callerToken: 'caller.token', targetAudience: 'mcp-observability' }, d);
    const b = await handleExchange({ callerToken: 'caller.token', targetAudience: 'mcp-observability' }, d);
    const c = await handleExchange({ callerToken: 'caller.token', targetAudience: 'mcp-observability' }, d);
    expect(d.exchange).toHaveBeenCalledTimes(1);
    expect(b.access_token).toBe(a.access_token);
    expect(c.access_token).toBe(a.access_token);
  });

  it('exchanges again for a different caller token (new login / step-up)', async () => {
    const d = freshDeps();
    await handleExchange({ callerToken: 'caller.token.1', targetAudience: 'mcp-observability' }, d);
    await handleExchange({ callerToken: 'caller.token.2', targetAudience: 'mcp-observability' }, d);
    expect(d.exchange).toHaveBeenCalledTimes(2);
  });

  it('exchanges again for a different audience (other tier)', async () => {
    const d = freshDeps();
    await handleExchange({ callerToken: 'caller.token', targetAudience: 'mcp-observability' }, d);
    await handleExchange({ callerToken: 'caller.token', targetAudience: 'mcp-ops' }, d);
    expect(d.exchange).toHaveBeenCalledTimes(2);
  });

  it('does not cache a refused exchange', async () => {
    const d = { ...freshDeps(), exchange: vi.fn(async () => { throw new Error('invalid_scope'); }) };
    await expect(handleExchange({ callerToken: 'c', targetAudience: 'mcp-ops' }, d)).rejects.toThrow();
    await expect(handleExchange({ callerToken: 'c', targetAudience: 'mcp-ops' }, d)).rejects.toThrow();
    expect(d.exchange).toHaveBeenCalledTimes(2);
  });

  it('exchanges every time when no cache is configured', async () => {
    const d = { ...freshDeps(), cache: undefined };
    await handleExchange({ callerToken: 'caller.token', targetAudience: 'mcp-observability' }, d);
    await handleExchange({ callerToken: 'caller.token', targetAudience: 'mcp-observability' }, d);
    expect(d.exchange).toHaveBeenCalledTimes(2);
  });
});
