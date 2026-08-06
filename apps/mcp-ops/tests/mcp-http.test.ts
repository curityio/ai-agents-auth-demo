import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Stub the ops-api hop: this exercises the MCP transport + auth plumbing, not
// the backend call.
const opsApiCalls: Array<{ kind: string; bearer: string }> = [];
vi.mock('../src/ops-api-client.js', () => ({
  obtainOpsApiToken: async ({ subjectToken }: { subjectToken: string }) =>
    `exchanged(${subjectToken})`,
  callOpsApiRestart: async ({ bearer }: { bearer: string }) => {
    opsApiCalls.push({ kind: 'restart', bearer });
    return { restarted: true };
  },
  callOpsApiSetImage: async ({ bearer }: { bearer: string }) => {
    opsApiCalls.push({ kind: 'set_image', bearer });
    return { updated: true };
  },
  callOpsApiScale: async ({ bearer }: { bearer: string }) => {
    opsApiCalls.push({ kind: 'scale', bearer });
    return { scaled: true };
  },
}));

const { buildMcpRequestHandler } = await import('../src/mcp-http.js');
const cfg = {
  targetNamespace: 'prod',
  setImageRequiredRoles: ['sre'],
  resourceMetadataUrl: 'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
} as unknown as Parameters<typeof buildMcpRequestHandler>[0];

let server: Server;
let baseUrl: string;
// Mutated per test to stand in for different callers.
let callerRoles: string[] = ['sre'];

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const router = express.Router();
  // Stand-in for authMiddleware: publish the bearer AND the caller's roles as
  // AuthInfo exactly as the real one does. `roles` riding in `extra` is what
  // the set_deployment_image gate depends on.
  router.use((req, res, next) => {
    const authz = req.header('authorization') ?? '';
    if (!authz.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    (req as express.Request & { auth?: unknown }).auth = {
      token: authz.slice('bearer '.length).trim(),
      clientId: 'test',
      scopes: ['ops:write'],
      extra: { sub: 'alice', roles: callerRoles },
    };
    next();
  });
  router.post('/', buildMcpRequestHandler(cfg));
  app.use('/mcp', router);

  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect(mode: 'auto' | 'legacy' | { pin: string } = 'auto') {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { authorization: 'Bearer test.subject.token' } },
  });
  const client = new Client(
    { name: 'test-client', version: '0.0.1' },
    { versionNegotiation: { mode } },
  );
  await client.connect(transport);
  return { client, transport };
}

function textOf(result: { content: unknown }) {
  return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
}

describe('mcp-ops MCP HTTP route', () => {
  it('serves protocol revision 2026-07-28 with no session', async () => {
    const { client, transport } = await connect({ pin: '2026-07-28' });
    expect(transport.protocolVersion).toBe('2026-07-28');
    expect(transport.sessionId).toBeUndefined();
    await client.close();
  });

  // `legacy: 'reject'` is what guarantees every tools/call carries `Mcp-Name`.
  // If a 2025-era client could still be served, a caller could silently drop to
  // a revision without that header — and the gateway's per-tool authz rules
  // key on it.
  it('refuses 2025-era clients (legacy: reject)', async () => {
    await expect(connect('legacy')).rejects.toThrow();
  });

  it('lists all three write tools', async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      'restart_deployment',
      'scale_deployment',
      'set_deployment_image',
    ]);
    await client.close();
  });

  // SEP-2243. The gateway's namespace-confinement rule authorizes on the
  // `Mcp-Param-Namespace` header, which only exists because the tool declares
  // `x-mcp-header` here. Dropping the declaration would not fail any call — it
  // would silently remove the gateway's authz input, so assert it explicitly.
  it('declares x-mcp-header on namespace so clients mirror Mcp-Param-Namespace', async () => {
    const { client } = await connect();
    const listed = await client.listTools();
    for (const tool of listed.tools) {
      const props = (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(props.namespace, `${tool.name}.namespace`).toMatchObject({
        'x-mcp-header': 'Namespace',
      });
    }
    await client.close();
  });

  it('routes the per-request bearer from AuthInfo through to ops-api', async () => {
    callerRoles = ['sre'];
    opsApiCalls.length = 0;
    const { client } = await connect();
    await client.callTool({ name: 'restart_deployment', arguments: { name: 'order-service' } });
    expect(opsApiCalls).toEqual([
      { kind: 'restart', bearer: 'exchanged(test.subject.token)' },
    ]);
    await client.close();
  });

  // The role gate is the reason `roles` rides in AuthInfo.extra: the per-request
  // factory has no access to the express request, so a regression here would
  // silently hand every caller sre powers.
  it('allows set_deployment_image for an sre caller', async () => {
    callerRoles = ['sre'];
    opsApiCalls.length = 0;
    const { client } = await connect();
    const result = await client.callTool({
      name: 'set_deployment_image',
      arguments: { name: 'order-service', image: 'ghcr.io/demo/order-service:v2' },
    });
    expect(result.isError).toBeFalsy();
    expect(opsApiCalls.map((c) => c.kind)).toEqual(['set_image']);
    await client.close();
  });

  it('denies set_deployment_image for an oncall caller, before the ops-api hop', async () => {
    callerRoles = ['oncall'];
    opsApiCalls.length = 0;
    const { client } = await connect();
    const result = await client.callTool({
      name: 'set_deployment_image',
      arguments: { name: 'order-service', image: 'ghcr.io/demo/order-service:v2' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({ error: 'forbidden' });
    expect(String(textOf(result).message)).toContain('sre');
    // Denial must happen before any privileged call is made.
    expect(opsApiCalls).toEqual([]);
    await client.close();
  });
});
