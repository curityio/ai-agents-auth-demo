import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.js';

/**
 * The shim is served through express rather than a bare `node:http` listener.
 * That is a TELEMETRY requirement, not a style choice: `instrumentation-http`
 * patches the CJS `http` module, and express reaches it through a CJS `require`
 * that is reliably hooked. A bare ESM `import { createServer } from 'node:http'`
 * raced the SDK's ESM hook registration and was frequently left unpatched — no
 * server span, therefore no `propagation.extract`, therefore every
 * `auth.token_exchange` span started its own orphan trace instead of joining the
 * caller's. Verified in-cluster: an unparented request to the bare listener
 * produced no span at all.
 */

const svid = {
  jwt: 'svid-jwt',
  claims: {
    sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway',
    aud: ['https://curity.localtest.me/oauth/v2/oauth-token'],
    iss: 'https://oidc-discovery.demo.curity.local',
    iat: 1,
    exp: 2 ** 31,
  },
};

const cfg = {
  port: 0,
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'agentgateway',
  clientSecret: 'secret',
  svidAudience: 'https://curity.localtest.me/oauth/v2/oauth-token',
  svidFile: '/run/spiffe/curity-actor.jwt',
  audienceScopes: { 'mcp-observability': 'obs:read', 'mcp-ops': 'ops:write' },
  cacheTtlSeconds: 60,
  cacheMaxEntries: 100,
} as never;

const exchanged: Array<{ audience: string; scope: string }> = [];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp({
    cfg,
    getSvid: async () => svid as never,
    exchange: (async (p: { audience: string; scope: string }) => {
      exchanged.push({ audience: p.audience, scope: p.scope });
      return {
        accessToken: `narrowed-for-${p.audience}-${exchanged.length}`,
        tokenType: 'Bearer',
        expiresInSec: 300,
        scope: p.scope,
        issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
      };
    }) as never,
  });
  await new Promise<void>((r) => {
    server = app.listen(0, r);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

describe('exchange-shim app', () => {
  it('serves the unauthenticated health probe', async () => {
    const r = await fetch(`${baseUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('ok');
  });

  it('exposes the gateway workload identity at /spiffe-id', async () => {
    const r = await fetch(`${baseUrl}/spiffe-id`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sub: string; ttl_seconds: number };
    expect(body.sub).toBe('spiffe://demo.curity.local/ns/mcp/sa/agentgateway');
    expect(body.ttl_seconds).toBeGreaterThan(0);
  });

  it('performs the exchange and returns a token-endpoint-shaped body', async () => {
    const r = await fetch(`${baseUrl}/exchange`, {
      method: 'POST',
      headers: {
        'x-caller-authorization': 'Bearer caller-token',
        'x-target-audience': 'mcp-ops',
      },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      access_token: 'narrowed-for-mcp-ops-1',
      token_type: 'Bearer',
      expires_in: 300,
    });
    // Scope is derived server-side from the audience allow-list, never taken
    // from the caller.
    expect(exchanged.at(-1)).toEqual({ audience: 'mcp-ops', scope: 'ops:write' });
  });

  it('accepts GET on /exchange, because extAuthz mirrors the original method', async () => {
    // agentgateway's extAuthz check copies the inbound method onto the callout.
    // The OBO-chain walk hits /last-token with GET, so rejecting non-POST made
    // that callout 404 at the shim, which the gateway surfaced as a route-level
    // 404 and silently dropped the mcp→api hops from the chain.
    const r = await fetch(`${baseUrl}/exchange`, {
      method: 'GET',
      headers: {
        'x-caller-authorization': 'Bearer caller-token',
        'x-target-audience': 'mcp-observability',
      },
    });
    expect(r.status).toBe(200);
  });

  it('rejects an exchange with no caller token as invalid_request', async () => {
    const r = await fetch(`${baseUrl}/exchange`, { method: 'POST' });
    expect(r.status).toBe(400);
    expect(await r.json()).toEqual({ error: 'invalid_request' });
  });

  it('refuses an audience outside the server-side allow-list', async () => {
    const r = await fetch(`${baseUrl}/exchange`, {
      method: 'POST',
      headers: {
        'x-caller-authorization': 'Bearer caller-token',
        'x-target-audience': 'obs-api',
      },
    });
    expect(r.status).toBe(403);
  });

  it('reuses one exchanged token across the three extAuthz callouts one question costs', async () => {
    // server/discover, tools/list, tools/call arrive as three callouts carrying the
    // SAME caller token and audience. cfg.cacheTtlSeconds=60 → one Curity exchange.
    const before = exchanged.length;
    const bodies: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${baseUrl}/exchange`, {
        method: 'POST',
        headers: {
          'x-caller-authorization': 'Bearer same-question-token',
          'x-target-audience': 'mcp-observability',
        },
      });
      expect(r.status).toBe(200);
      bodies.push(((await r.json()) as { access_token: string }).access_token);
    }
    expect(exchanged.length - before).toBe(1);
    expect(new Set(bodies).size).toBe(1);
  });

  it('404s an unknown path', async () => {
    expect((await fetch(`${baseUrl}/nope`)).status).toBe(404);
  });
});
