import { describe, it, expect, vi } from 'vitest';
import { handleExchange } from '../src/exchange-handler.js';

const deps = {
  getSvidJwt: vi.fn(async () => 'svid.jwt.compact'),
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-gateway',
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
        clientId: 'mcp-gateway',
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
});
