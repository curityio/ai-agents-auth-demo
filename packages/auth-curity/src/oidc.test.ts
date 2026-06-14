import { describe, it, expect, beforeEach } from 'vitest';
import { getOidcConfig, _clearOidcCache } from './oidc.js';
import { CurityAuthError } from './errors.js';

function mockFetch(responses: Array<{ url: string; status: number; body: unknown }>): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = responses[i++];
    if (!r) throw new Error(`unexpected extra fetch: ${url}`);
    if (!url.endsWith(r.url) && url !== r.url) {
      throw new Error(`unexpected fetch url: ${url}, wanted suffix ${r.url}`);
    }
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('getOidcConfig', () => {
  beforeEach(() => _clearOidcCache());

  it('fetches and returns the discovery document', async () => {
    const issuer = 'https://curity.test/oauth/v2/oauth-anonymous';
    const doc = {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    };
    const cfg = await getOidcConfig(issuer, {
      fetchImpl: mockFetch([{ url: '/.well-known/openid-configuration', status: 200, body: doc }]),
    });
    expect(cfg.jwks_uri).toBe(doc.jwks_uri);
  });

  it('caches subsequent calls within TTL', async () => {
    const issuer = 'https://curity.test/oauth/v2/oauth-anonymous';
    const doc = {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      jwks_uri: `${issuer}/jwks`,
    };
    const f = mockFetch([{ url: '/.well-known/openid-configuration', status: 200, body: doc }]);
    await getOidcConfig(issuer, { fetchImpl: f });
    // Second call with the same mock that has no more responses — should not throw thanks to cache.
    const cfg2 = await getOidcConfig(issuer, { fetchImpl: f });
    expect(cfg2.issuer).toBe(issuer);
  });

  it('rejects when discovery returns non-200', async () => {
    const issuer = 'https://curity.test/oauth/v2/oauth-anonymous';
    await expect(
      getOidcConfig(issuer, {
        fetchImpl: mockFetch([
          { url: '/.well-known/openid-configuration', status: 500, body: { error: 'oops' } },
        ]),
      }),
    ).rejects.toBeInstanceOf(CurityAuthError);
  });

  it('rejects when the document issuer does not match', async () => {
    const issuer = 'https://curity.test/oauth/v2/oauth-anonymous';
    const doc = {
      issuer: 'https://attacker.example',
      authorization_endpoint: 'x',
      token_endpoint: 'x',
      jwks_uri: 'x',
    };
    await expect(
      getOidcConfig(issuer, {
        fetchImpl: mockFetch([{ url: '/.well-known/openid-configuration', status: 200, body: doc }]),
      }),
    ).rejects.toMatchObject({ code: 'invalid_issuer' });
  });

  it('handles trailing slash on issuer URL', async () => {
    const issuer = 'https://curity.test/oauth/v2/oauth-anonymous/';
    const doc = {
      issuer: issuer.slice(0, -1),
      authorization_endpoint: 'x',
      token_endpoint: 'x',
      jwks_uri: 'x',
    };
    const cfg = await getOidcConfig(issuer, {
      fetchImpl: mockFetch([{ url: '/.well-known/openid-configuration', status: 200, body: doc }]),
    });
    expect(cfg.issuer).toBe(doc.issuer);
  });
});
