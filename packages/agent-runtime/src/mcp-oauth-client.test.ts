import { describe, it, expect, beforeEach } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import { _resetAuthorizationServerCache } from './authorization-server.js';
import { discoverMcpAuthorization, isDiscoveryFailure, _resetDiscoveryCache } from './mcp-oauth-client.js';

const SERVER = 'https://mcp-gateway.localtest.me/ops/mcp';
const PRM_URL = 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp';
const PRM_ROOT_URL = 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource';
const ISSUER = 'https://curity.localtest.me/oauth/v2/oauth-anonymous';
const AS_URL = 'https://curity.localtest.me/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous';

const PRM = {
  resource: SERVER,
  authorization_servers: [ISSUER],
  scopes_supported: ['ops:write'],
  bearer_methods_supported: ['header'],
  acr_values_supported: ['mfa'],
};
const AS = {
  issuer: ISSUER,
  token_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  authorization_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-authorize',
  jwks_uri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
};

interface Route { status?: number; body?: unknown; headers?: Record<string, string> }

/**
 * Fake fetch keyed by "METHOD url". Unrouted URLs 404. Records every call so a
 * test can assert the spec's request ORDER, not just the outcome.
 */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`;
    calls.push(key);
    const r = routes[key];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { f, calls };
}

const challenge401 = (extra = ''): Route => ({
  status: 401,
  headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"${extra}` },
});

const HAPPY = {
  [`POST ${SERVER}`]: challenge401(),
  [`GET ${PRM_URL}`]: { body: PRM },
  [`GET ${AS_URL}`]: { body: AS },
};

beforeEach(() => {
  _resetDiscoveryCache();
  _resetAuthorizationServerCache();
});

describe('discoverMcpAuthorization', () => {
  it('runs the spec sequence: unauthenticated probe → resource_metadata → PRM → AS metadata', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls).toEqual([`POST ${SERVER}`, `GET ${PRM_URL}`, `GET ${AS_URL}`]);
    expect(d).toMatchObject({
      serverUrl: SERVER,
      resourceMetadataUrl: PRM_URL,
      authorizationServer: ISSUER,
      tokenEndpoint: AS.token_endpoint,
      scope: 'ops:write',
      scopeSource: 'scopes_supported',
    });
    expect(d.resourceMetadata.acr_values_supported).toEqual(['mfa']);
  });

  it('prefers the scope named in the 401 challenge over scopes_supported (spec scope-selection order)', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`POST ${SERVER}`]: challenge401(', scope="ops:write obs:read"') });
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(d.scope).toBe('ops:write obs:read');
    expect(d.scopeSource).toBe('challenge');
  });

  it('falls back to well-known probing (path form, then root) when the 401 carries no resource_metadata', async () => {
    const { f, calls } = fakeFetch({
      [`POST ${SERVER}`]: { status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' } },
      [`GET ${PRM_ROOT_URL}`]: { body: PRM },
      [`GET ${AS_URL}`]: { body: AS },
    });
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls.slice(0, 3)).toEqual([`POST ${SERVER}`, `GET ${PRM_URL}`, `GET ${PRM_ROOT_URL}`]);
    expect(d.resourceMetadataUrl).toBe(PRM_ROOT_URL);
  });

  it('falls back the same way when the 401 has no WWW-Authenticate header at all', async () => {
    const { f, calls } = fakeFetch({
      [`POST ${SERVER}`]: { status: 401 },
      [`GET ${PRM_URL}`]: { body: PRM },
      [`GET ${AS_URL}`]: { body: AS },
    });
    await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls[1]).toBe(`GET ${PRM_URL}`);
  });

  it('refuses when the probe is not 401 (a server that does not require auth is not one we hand a token to)', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`POST ${SERVER}`]: { status: 200, body: {} } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('accepts a PRM resource that differs only by a trailing slash', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, resource: `${SERVER}/` } } });
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(d.serverUrl).toBe(SERVER);
  });

  it('refuses a PRM whose resource identifies another server (RFC 9728 §3.3)', async () => {
    const { f } = fakeFetch({
      ...HAPPY,
      [`GET ${PRM_URL}`]: { body: { ...PRM, resource: 'https://mcp-gateway.localtest.me/observability/mcp' } },
    });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
  });

  it('refuses a PRM with no authorization_servers', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, authorization_servers: [] } } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('refuses when neither the challenge nor scopes_supported says what to ask for', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, scopes_supported: [] } } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'scope_unavailable' }));
  });

  it('propagates an AS that lacks CIMD support as cimd_unsupported', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${AS_URL}`]: { body: { ...AS, client_id_metadata_document_supported: false } } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'cimd_unsupported' }));
  });

  it('serves a repeat from cache with no HTTP calls, and force re-probes', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    const n = calls.length;
    await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls.length).toBe(n);
    await discoverMcpAuthorization(SERVER, { fetchImpl: f, force: true });
    expect(calls.length).toBeGreaterThan(n);
  });

  it('uses a supplied 401 response as the challenge instead of probing', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const challenge = new Response(null, {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` },
    });
    await discoverMcpAuthorization(SERVER, { fetchImpl: f, challenge });
    expect(calls[0]).toBe(`GET ${PRM_URL}`);
  });
});

describe('isDiscoveryFailure', () => {
  it('is true for the four discovery codes and false for exchange refusals', () => {
    for (const code of ['discovery_failed', 'resource_mismatch', 'cimd_unsupported', 'scope_unavailable'] as const) {
      expect(isDiscoveryFailure(new CurityAuthError('x', code))).toBe(true);
    }
    expect(isDiscoveryFailure(new CurityAuthError('x', 'invalid_scope'))).toBe(false);
    expect(isDiscoveryFailure(new Error('x'))).toBe(false);
  });
});
