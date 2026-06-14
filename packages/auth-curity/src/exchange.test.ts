import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { decodeJwt, exportPKCS8, generateKeyPair } from 'jose';
import { exchangeToken } from './exchange.js';
import { CurityAuthError } from './errors.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

const baseParams = {
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'agent-copilot',
  clientSecret: 's3cret',
  subjectToken: 'eyJ.subject.jwt',
  actorToken: 'eyJ.actor.svid',
  audience: 'mcp-observability',
  scope: 'obs:read',
} as const;

describe('exchangeToken', () => {
  it('sends RFC 8693 form-encoded body and Basic auth header', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'exchanged.jwt',
          issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
          token_type: 'Bearer',
          expires_in: 300,
          scope: 'obs:read',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await exchangeToken(baseParams);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(baseParams.tokenEndpoint);
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe(
      'Basic ' + Buffer.from('agent-copilot:s3cret').toString('base64'),
    );
    expect(init.headers['content-type']).toBe('application/x-www-form-urlencoded');

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('subject_token')).toBe(baseParams.subjectToken);
    expect(body.get('subject_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(body.get('actor_token')).toBe(baseParams.actorToken);
    expect(body.get('actor_token_type')).toBe('urn:ietf:params:oauth:token-type:jwt');
    expect(body.get('requested_token_type')).toBe('urn:ietf:params:oauth:token-type:access_token');
    expect(body.get('audience')).toBe('mcp-observability');
    expect(body.get('scope')).toBe('obs:read');

    expect(result.accessToken).toBe('exchanged.jwt');
    expect(result.expiresInSec).toBe(300);
    expect(result.scope).toBe('obs:read');
  });

  it('maps invalid_scope errors', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_scope', error_description: 'ops:write not allowed' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({
      name: 'CurityAuthError',
      code: 'invalid_scope',
    });
  });

  it('maps invalid_grant errors (e.g. expired subject_token)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_grant', error_description: 'subject token expired' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('maps access_denied errors (e.g. claims policy refusal)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'access_denied', error_description: 'user role missing' }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('maps Curity-sanitized access_denied (invalid_request + access_denied-prefixed description)', async () => {
    // Curity rewrites a procedure `fail('access_denied', msg)` to error=invalid_request
    // with the code prefixed into the description. We must still classify it access_denied.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_request',
          error_description: "access_denied user lacks required role 'sre' for ops:write",
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('maps Curity-sanitized invalid_scope (invalid_request + invalid_scope-prefixed description)', async () => {
    // Same sanitization as access_denied: procedure `fail('invalid_scope', msg)` becomes
    // error=invalid_request with the code prefixed into the description.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'invalid_request',
          error_description:
            'invalid_scope no scope intersects subject + policy for client https://specialist.localtest.me/.well-known/oauth-client / audience mcp-ops',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({ code: 'invalid_scope' });
  });

  it('throws invalid_actor when Curity reports an unrecognized actor_token', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_request', error_description: 'invalid actor_token' }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({ code: 'invalid_actor' });
  });

  it('throws exchange_failed on unexpected non-OK responses', async () => {
    fetchMock.mockResolvedValue(new Response('upstream down', { status: 502 }));
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({ code: 'exchange_failed' });
  });

  it('throws exchange_failed on network errors', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(exchangeToken(baseParams)).rejects.toBeInstanceOf(CurityAuthError);
  });

  it('throws exchange_failed when a 2xx response has malformed JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('not json at all', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({
      name: 'CurityAuthError',
      code: 'exchange_failed',
    });
  });

  it('maps invalid_client errors (e.g. unfetchable CIMD document)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'invalid_client', error_description: 'metadata fetch failed' }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );
    await expect(exchangeToken(baseParams)).rejects.toMatchObject({ code: 'invalid_client' });
  });
});

describe('exchangeToken with private_key_jwt', () => {
  const clientId = 'https://copilot.localtest.me/.well-known/oauth-client';

  async function paramsWithKey() {
    const { privateKey } = await generateKeyPair('RS256');
    const pem = await exportPKCS8(privateKey);
    return {
      tokenEndpoint: baseParams.tokenEndpoint,
      clientId,
      subjectToken: baseParams.subjectToken,
      actorToken: baseParams.actorToken,
      audience: baseParams.audience,
      scope: baseParams.scope,
      clientAuth: {
        method: 'private_key_jwt' as const,
        privateKeyPkcs8Pem: pem,
        kid: 'test-kid',
        assertionAudience: baseParams.tokenEndpoint,
      },
    };
  }

  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'exchanged.jwt', expires_in: 300, scope: 'obs:read' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  it('sends a signed client_assertion and no Basic auth header', async () => {
    const params = await paramsWithKey();
    await exchangeToken(params);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.authorization).toBeUndefined();

    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe(clientId);
    expect(body.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    const assertion = body.get('client_assertion');
    expect(assertion).toBeTruthy();
  });

  it('signs an assertion with iss=sub=clientId and aud=token endpoint', async () => {
    const params = await paramsWithKey();
    await exchangeToken(params);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(init.body as string);
    const claims = decodeJwt(body.get('client_assertion')!);
    expect(claims.iss).toBe(clientId);
    expect(claims.sub).toBe(clientId);
    expect(claims.aud).toBe(baseParams.tokenEndpoint);
    expect(claims.jti).toBeTruthy();
    expect(typeof claims.exp).toBe('number');
    expect(typeof claims.iat).toBe('number');
  });

  it('still sends the RFC 8693 token-exchange body params', async () => {
    const params = await paramsWithKey();
    await exchangeToken(params);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(body.get('actor_token')).toBe(baseParams.actorToken);
    expect(body.get('audience')).toBe('mcp-observability');
  });
});
