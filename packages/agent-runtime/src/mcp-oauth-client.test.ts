import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import { _resetAuthorizationServerCache } from './authorization-server.js';
import {
  createMcpAuthProvider,
  discoverMcpAuthorization,
  isDiscoveryFailure,
  _resetDiscoveryCache,
} from './mcp-oauth-client.js';

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

  it('refuses a plain-http resource_metadata URL from the challenge without fetching it (RFC 9728 §3 requires https)', async () => {
    const HTTP_PRM = 'http://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp';
    const { f, calls } = fakeFetch({
      ...HAPPY,
      [`POST ${SERVER}`]: { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${HTTP_PRM}"` } },
      [`GET ${HTTP_PRM}`]: { body: PRM },
    });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
    expect(calls).not.toContain(`GET ${HTTP_PRM}`);
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

  it('ttlMs: 0 re-runs the whole chain on every call (the demo setting, so each question shows discovery)', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    await discoverMcpAuthorization(SERVER, { fetchImpl: f, ttlMs: 0 });
    const n = calls.length;
    await discoverMcpAuthorization(SERVER, { fetchImpl: f, ttlMs: 0 });
    expect(calls.length).toBe(2 * n);
    expect(calls.slice(n)).toEqual(calls.slice(0, n)); // probe → PRM → AS, again
  });

  it('a positive ttlMs overrides the 10-minute default', async () => {
    vi.useFakeTimers();
    try {
      const { f, calls } = fakeFetch(HAPPY);
      await discoverMcpAuthorization(SERVER, { fetchImpl: f, ttlMs: 5_000 });
      const n = calls.length;
      vi.advanceTimersByTime(4_000);
      await discoverMcpAuthorization(SERVER, { fetchImpl: f, ttlMs: 5_000 });
      expect(calls.length).toBe(n);
      vi.advanceTimersByTime(1_001);
      await discoverMcpAuthorization(SERVER, { fetchImpl: f, ttlMs: 5_000 });
      expect(calls.length).toBe(2 * n);
    } finally {
      vi.useRealTimers();
    }
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

describe('createMcpAuthProvider', () => {
  it('acquire() discovers then exchanges with the discovered token endpoint and scope; token() returns it', async () => {
    const { f } = fakeFetch(HAPPY);
    const exchange = vi.fn(async () => 'TOKEN-1');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 'agent-specialist', exchange, fetchImpl: f });
    expect(await p.token()).toBeUndefined();
    expect(await p.acquire()).toBe('TOKEN-1');
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ tokenEndpoint: AS.token_endpoint, scope: 'ops:write' }),
    );
    expect(await p.token()).toBe('TOKEN-1');
    expect(p.current().discovery?.resourceMetadataUrl).toBe(PRM_URL);
  });

  it('discover() mints nothing', async () => {
    const { f } = fakeFetch(HAPPY);
    const exchange = vi.fn(async () => 'TOKEN-1');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 's', exchange, fetchImpl: f });
    const d = await p.discover();
    expect(d.scope).toBe('ops:write');
    expect(exchange).not.toHaveBeenCalled();
    expect(await p.token()).toBeUndefined();
  });

  it('onUnauthorized re-acquires with a forced discovery from the received challenge', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const exchange = vi.fn().mockResolvedValueOnce('TOKEN-1').mockResolvedValueOnce('TOKEN-2');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 's', exchange, fetchImpl: f });
    await p.acquire();
    const before = calls.length;
    const response = new Response(null, {
      status: 401,
      headers: { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${PRM_URL}"` },
    });
    await p.onUnauthorized({ response, serverUrl: new URL(SERVER), fetchFn: f });
    // Forced: the PRM and AS were fetched again (cache bypassed), no second probe (challenge supplied).
    expect(calls.slice(before)).toEqual([`GET ${PRM_URL}`, `GET ${AS_URL}`]);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(await p.token()).toBe('TOKEN-2');
  });

  it('onUnauthorized refuses to exchange or retry on an RFC 9470 step-up challenge', async () => {
    const { f } = fakeFetch(HAPPY);
    const exchange = vi.fn(async () => 'TOKEN-1');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 's', exchange, fetchImpl: f });
    await p.acquire();
    const response = new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer realm="mcp-ops", error="insufficient_user_authentication", acr_values="mfa", resource_metadata="${PRM_URL}"`,
      },
    });
    await expect(p.onUnauthorized({ response, serverUrl: new URL(SERVER), fetchFn: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'step_up_required' }));
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('a discovery failure inside acquire() is logged as DENY once and rethrown with its code', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, resource: 'https://other/mcp' } } });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => { logs.push(String(s)); });
    try {
      const p = createMcpAuthProvider({ serverUrl: SERVER, service: 'agent-copilot', exchange: async () => 'x', fetchImpl: f });
      await expect(p.acquire()).rejects.toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
    } finally {
      spy.mockRestore();
    }
    expect(logs.filter((l) => l.includes('[agent-copilot] DENY')).length).toBe(1);
  });

  it('an exchange refusal is NOT double-logged here (exchangeToken already logs DENY)', async () => {
    const { f } = fakeFetch(HAPPY);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => { logs.push(String(s)); });
    try {
      const p = createMcpAuthProvider({
        serverUrl: SERVER,
        service: 'agent-copilot',
        exchange: async () => { throw new CurityAuthError('needs mfa', 'invalid_scope'); },
        fetchImpl: f,
      });
      await expect(p.acquire()).rejects.toThrowError(expect.objectContaining({ code: 'invalid_scope' }));
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => l.includes('DENY'))).toBe(false);
  });

  it('tells the exchange when it is FORCED (onUnauthorized) so a caller-side token cache is bypassed; acquire() is not forced', async () => {
    const { f } = fakeFetch(HAPPY);
    const exchange = vi.fn().mockResolvedValueOnce('TOKEN-1').mockResolvedValueOnce('TOKEN-2');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 's', exchange, fetchImpl: f });
    await p.acquire();
    expect(exchange).toHaveBeenLastCalledWith(expect.objectContaining({ forced: false }));
    const response = new Response(null, {
      status: 401,
      headers: { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${PRM_URL}"` },
    });
    await p.onUnauthorized({ response, serverUrl: new URL(SERVER), fetchFn: f });
    expect(exchange).toHaveBeenLastCalledWith(expect.objectContaining({ forced: true }));
  });

  it('refuses an authorization server outside allowedAuthorizationServers (the MCP server must not choose where the user token goes)', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const exchange = vi.fn(async () => 'x');
    const p = createMcpAuthProvider({
      serverUrl: SERVER, service: 's', exchange, fetchImpl: f,
      allowedAuthorizationServers: ['https://honest.example/oauth'],
    });
    await expect(p.acquire()).rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
    expect(calls).not.toContain(`GET ${AS_URL}`);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('accepts an allowed authorization server that differs only by a trailing slash', async () => {
    const { f } = fakeFetch(HAPPY);
    const p = createMcpAuthProvider({
      serverUrl: SERVER, service: 's', exchange: async () => 'TOKEN-1', fetchImpl: f,
      allowedAuthorizationServers: [`${ISSUER}/`],
    });
    expect(await p.acquire()).toBe('TOKEN-1');
  });
});

describe('createMcpAuthProvider discoveryTtlMs', () => {
  it('passes discoveryTtlMs through, so two acquires with 0 probe twice', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 't', exchange: async () => 'T', fetchImpl: f, discoveryTtlMs: 0 });
    await p.acquire();
    const n = calls.length;
    await p.acquire();
    expect(calls.length).toBe(2 * n);
  });
});
