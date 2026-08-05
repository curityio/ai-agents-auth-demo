import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

// Stub the obs-api hop: this exercises the MCP transport + auth plumbing, not
// the backend call. `obtainObsApiToken` echoes back the subject token it was
// handed so the test can assert the per-request bearer reached the tool.
const seenSubjectTokens: string[] = [];
vi.mock('../src/obs-api-client.js', () => ({
  obtainObsApiToken: async ({ subjectToken }: { subjectToken: string }) => {
    seenSubjectTokens.push(subjectToken);
    return `exchanged(${subjectToken})`;
  },
  callListPods: async ({ bearer, namespace }: { bearer: string; namespace: string }) => ({
    bearer,
    namespace,
  }),
  callGetPodLogs: async () => ({ lines: [] }),
  callGetDeployment: async () => ({ image: 'x' }),
}));

const { buildMcpRequestHandler } = await import('../src/mcp-http.js');
const cfg = {
  targetNamespace: 'prod',
  resourceMetadataUrl:
    'https://mcp-observability.localtest.me/.well-known/oauth-protected-resource',
} as unknown as Parameters<typeof buildMcpRequestHandler>[0];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '4mb' }));
  const router = express.Router();
  // Stand-in for authMiddleware: publish the bearer as AuthInfo exactly as the
  // real one does. That contract — not the JWT validation — is what this route
  // depends on.
  router.use((req, res, next) => {
    const authz = req.header('authorization') ?? '';
    if (!authz.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    (req as express.Request & { auth?: unknown }).auth = {
      token: authz.slice('bearer '.length).trim(),
      clientId: 'test',
      scopes: ['obs:read'],
      extra: { sub: 'alice' },
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

async function connect(mode: 'auto' | 'legacy' | { pin: string }) {
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

describe('MCP HTTP route', () => {
  it('serves protocol revision 2026-07-28 with no session', async () => {
    const { client, transport } = await connect({ pin: '2026-07-28' });
    expect(transport.protocolVersion).toBe('2026-07-28');
    // The revision removed sessions outright — a session id here would mean we
    // silently fell back to the 2025 transport.
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

  it('lists all three read tools', async () => {
    const { client } = await connect('auto');
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual([
      'get_deployment',
      'get_pod_logs',
      'list_pods',
    ]);
    await client.close();
  });

  it('advertises tools with a JSON Schema derived from the zod input schema', async () => {
    const { client } = await connect('auto');
    const listed = await client.listTools();
    const listPods = listed.tools.find((t) => t.name === 'list_pods');
    expect(listPods?.inputSchema).toMatchObject({
      type: 'object',
      properties: { namespace: { type: 'string' } },
    });
    await client.close();
  });

  it('routes the per-request bearer from AuthInfo through to the tool', async () => {
    seenSubjectTokens.length = 0;
    const { client } = await connect('auto');
    const result = await client.callTool({ name: 'list_pods', arguments: { namespace: 'prod' } });
    // The tool must have exchanged the caller's own token, not a stale or
    // process-wide one — this is the whole point of the per-request factory.
    expect(seenSubjectTokens).toEqual(['test.subject.token']);
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text)).toMatchObject({
      bearer: 'exchanged(test.subject.token)',
      namespace: 'prod',
    });
    await client.close();
  });

  it('applies the tool input schema default when an argument is omitted', async () => {
    const { client } = await connect('auto');
    const result = await client.callTool({ name: 'list_pods', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ namespace: 'prod' });
    await client.close();
  });
});
