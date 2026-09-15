import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
      return { jwt: 'obs-svid.jwt', claims: {}, audience: 'a', filePath: 'f' };
    }
  },
}));

import { exchangeToken } from '@ai-agents-demo/auth-curity';
import { peekLastExchange, obtainObsApiToken, callListPods, callGetPodLogs } from '../src/obs-api-client.js';
import type { Config } from '../src/config.js';

const cfg = {
  curityTokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-observability',
  clientSecret: 'shh',
  obsApiBaseUrl: 'http://obs-api.apis.svc.cluster.local:8084',
  obsApiAudience: 'obs-api',
  obsApiScope: 'obs:read',
  targetNamespace: 'prod',
} as unknown as Config;

describe('obtainObsApiToken', () => {
  beforeEach(() => vi.mocked(exchangeToken).mockReset());

  it('exchanges with obs-api audience and mcp-observability SVID as actor', async () => {
    vi.mocked(exchangeToken).mockResolvedValueOnce({
      accessToken: 'obs-exchanged',
      tokenType: 'Bearer',
      expiresInSec: 300,
      scope: 'obs:read',
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    });
    const token = await obtainObsApiToken({ cfg, subjectToken: 'inbound' });
    expect(token).toBe('obs-exchanged');
    expect(exchangeToken).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: 'obs-api',
        scope: 'obs:read',
        actorToken: 'obs-svid.jwt',
        subjectToken: 'inbound',
        clientId: 'mcp-observability',
      }),
    );
  });
  it('records the INBOUND subject token next to the exchanged one, so /last-token can show the real gateway → mcp-observability leg', async () => {
    // /last-token used to decode its own request bearer as that leg — but the
    // chain walk itself travels through agentgateway, so that bearer is a token
    // minted for the walk, not the one the tool call ran with (fresh TTL, other jti).
    vi.mocked(exchangeToken).mockResolvedValueOnce({
      accessToken: 'obs-exchanged',
      tokenType: 'Bearer',
      expiresInSec: 300,
      scope: 'obs:read',
      issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
    });
    await obtainObsApiToken({ cfg, subjectToken: 'inbound-from-tool-call' });
    expect(peekLastExchange()).toMatchObject({
      subjectToken: 'inbound-from-tool-call',
      accessToken: 'obs-exchanged',
    });
  });
});

describe('callListPods / callGetPodLogs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('GETs /pods with namespace + Bearer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify([{ name: 'p1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const pods = await callListPods({ cfg, bearer: 'tok', namespace: 'prod' });
    expect(pods).toEqual([{ name: 'p1' }]);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://obs-api.apis.svc.cluster.local:8084/pods?namespace=prod');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer tok' });
  });

  it('GETs /pods/:name/logs with tailLines', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ podName: 'p1', lines: ['a', 'b'] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const logs = await callGetPodLogs({ cfg, bearer: 'tok', podName: 'p1', namespace: 'prod', tailLines: 10 });
    expect(logs).toMatchObject({ podName: 'p1' });
    expect(String(fetchSpy.mock.calls[0]![0])).toBe(
      'http://obs-api.apis.svc.cluster.local:8084/pods/p1/logs?namespace=prod&tailLines=10',
    );
  });

  it('throws on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 403 }));
    await expect(callListPods({ cfg, bearer: 't', namespace: 'prod' })).rejects.toThrow(/obs-api/);
  });
});
