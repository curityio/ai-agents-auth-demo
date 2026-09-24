import { describe, it, expect, beforeEach } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import {
  resolveAuthorizationServer,
  validateAuthorizationServerMetadata,
  _resetAuthorizationServerCache,
} from './authorization-server.js';

const ISSUER = 'https://curity.localtest.me/oauth/v2/oauth-anonymous';
// RFC 8414 §3.1 path-insertion form — the first URL the SDK tries for a path issuer.
const RFC8414_URL = 'https://curity.localtest.me/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous';

const GOOD = {
  issuer: ISSUER,
  token_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  authorization_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-authorize',
  jwks_uri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
};

/** A fetch that serves `routes` by exact URL and 404s everything else; records calls. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

beforeEach(() => _resetAuthorizationServerCache());

describe('validateAuthorizationServerMetadata', () => {
  it('returns the issuer and an https token endpoint', () => {
    const r = validateAuthorizationServerMetadata(GOOD as never);
    expect(r.issuer).toBe(ISSUER);
    expect(r.tokenEndpoint).toBe('https://curity.localtest.me/oauth/v2/oauth-token');
  });

  it('refuses an AS that does not advertise CIMD support (the agents have no other registration path)', () => {
    expect(() => validateAuthorizationServerMetadata({ ...GOOD, client_id_metadata_document_supported: false } as never))
      .toThrowError(expect.objectContaining({ code: 'cimd_unsupported' }));
    const { client_id_metadata_document_supported: _drop, ...absent } = GOOD;
    expect(() => validateAuthorizationServerMetadata(absent as never))
      .toThrowError(expect.objectContaining({ code: 'cimd_unsupported' }));
  });

  it('refuses a plain-http token endpoint', () => {
    expect(() =>
      validateAuthorizationServerMetadata({ ...GOOD, token_endpoint: 'http://curity.curity.svc:8443/oauth/v2/oauth-token' } as never),
    ).toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('refuses metadata without a token endpoint', () => {
    const { token_endpoint: _drop, ...noTe } = GOOD;
    expect(() => validateAuthorizationServerMetadata(noTe as never))
      .toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });
});

describe('resolveAuthorizationServer', () => {
  it('fetches RFC 8414 metadata in path-insertion form first and validates it', async () => {
    const { f, calls } = fakeFetch({ [RFC8414_URL]: GOOD });
    const r = await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    expect(r.tokenEndpoint).toBe(GOOD.token_endpoint);
    expect(calls[0]).toBe(RFC8414_URL);
  });

  it('serves a second call from cache without fetching', async () => {
    const { f, calls } = fakeFetch({ [RFC8414_URL]: GOOD });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    expect(calls.filter((u) => u === RFC8414_URL)).toHaveLength(1);
  });

  it('force refetches', async () => {
    const { f, calls } = fakeFetch({ [RFC8414_URL]: GOOD });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f, force: true });
    expect(calls.filter((u) => u === RFC8414_URL)).toHaveLength(2);
  });

  it('rejects a document whose issuer does not echo the URL (RFC 8414 §3.3) as discovery_failed', async () => {
    const { f } = fakeFetch({ [RFC8414_URL]: { ...GOOD, issuer: 'https://honest.example' } });
    await expect(resolveAuthorizationServer(ISSUER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('refuses a plain-http issuer without fetching anything', async () => {
    const { f, calls } = fakeFetch({});
    await expect(resolveAuthorizationServer('http://curity.curity.svc:8443/oauth/v2/oauth-anonymous', { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
    expect(calls).toHaveLength(0);
  });

  it('fails discovery_failed when no well-known document exists', async () => {
    const { f } = fakeFetch({});
    const err = await resolveAuthorizationServer(ISSUER, { fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(CurityAuthError);
    expect(err.code).toBe('discovery_failed');
  });
});
