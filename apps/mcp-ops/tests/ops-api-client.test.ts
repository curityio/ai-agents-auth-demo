import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock the exchange + the SVID source so we assert WIRING, not network.
vi.mock('@ai-agents-demo/auth-curity', async () => {
  const actual = await vi.importActual<typeof import('@ai-agents-demo/auth-curity')>(
    '@ai-agents-demo/auth-curity',
  );
  return { ...actual, exchangeToken: vi.fn() };
});
vi.mock('@ai-agents-demo/spiffe', () => ({
  SpiffeJwtSvidSource: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_cfg: any) {}
    async getSvid() {
      return { jwt: 'svid.jwt.value', claims: {}, audience: 'a', filePath: 'f' };
    }
  },
}));

import { exchangeToken } from '@ai-agents-demo/auth-curity';
import { peekLastExchange, obtainOpsApiToken, callOpsApiRestart } from '../src/ops-api-client.js';
import type { Config } from '../src/config.js';

const cfg = {
  curityTokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-ops',
  clientSecret: 'shh',
  opsApiUrl: 'http://ops-api.apis.svc.cluster.local:8083/restart',
  opsApiAudience: 'ops-api',
  opsApiScope: 'ops:write',
  targetNamespace: 'prod',
} as unknown as Config;

describe('obtainOpsApiToken', () => {
  beforeEach(() => vi.mocked(exchangeToken).mockReset());

  it('exchanges with ops-api audience, mcp-ops SVID as actor, inbound as subject', async () => {
    vi.mocked(exchangeToken).mockResolvedValueOnce({
      accessToken: 'exchanged-token',
      tokenType: 'Bearer',
      expiresInSec: 300,
      scope: 'ops:write',
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    });
    const token = await obtainOpsApiToken({ cfg, subjectToken: 'inbound-bearer' });
    expect(token).toBe('exchanged-token');
    expect(exchangeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenEndpoint: cfg.curityTokenEndpoint,
        clientId: 'mcp-ops',
        clientSecret: 'shh',
        subjectToken: 'inbound-bearer',
        actorToken: 'svid.jwt.value',
        audience: 'ops-api',
        scope: 'ops:write',
      }),
    );
  });
  it('records the INBOUND subject token next to the exchanged one, so /last-token can show the real gateway → mcp-ops leg', async () => {
    // /last-token used to decode its own request bearer as that leg — but the
    // chain walk itself travels through agentgateway, so that bearer is a token
    // minted for the walk, not the one the tool call ran with (fresh TTL, other jti).
    vi.mocked(exchangeToken).mockResolvedValueOnce({
      accessToken: 'exchanged-token',
      tokenType: 'Bearer',
      expiresInSec: 300,
      scope: 'ops:write',
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    });
    await obtainOpsApiToken({ cfg, subjectToken: 'inbound-from-tool-call' });
    expect(peekLastExchange()).toMatchObject({
      subjectToken: 'inbound-from-tool-call',
      accessToken: 'exchanged-token',
    });
  });
});

describe('callOpsApiRestart', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs the args with the exchanged Bearer and returns parsed JSON', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ deployment: 'api-gateway', namespace: 'prod' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const result = await callOpsApiRestart({
      cfg,
      bearer: 'exchanged-token',
      args: { name: 'api-gateway', namespace: 'prod', reason: 'demo' },
    });
    expect(result).toMatchObject({ deployment: 'api-gateway' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(cfg.opsApiUrl);
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).headers).toMatchObject({
      authorization: 'Bearer exchanged-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ name: 'api-gateway' });
  });

  it('throws when ops-api returns non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'restart_failed' }), { status: 403 }),
    );
    await expect(
      callOpsApiRestart({ cfg, bearer: 't', args: { name: 'x' } }),
    ).rejects.toThrow(/ops-api/);
  });
});
