import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { wrapFetch, installWireLog, type WireMode } from './wire-log.js';

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (payload: object, header: object = { alg: 'RS256' }) => `${b64(header)}.${b64(payload)}.sig`;
const json = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });

const jwk = { kty: 'EC', crv: 'P-256', x: 'xx', y: 'yy' };
const jkt = createHash('sha256').update('{"crv":"P-256","kty":"EC","x":"xx","y":"yy"}').digest('base64url');
const now = Math.floor(Date.now() / 1000);

/** A wrapped fetch over `respond`, plus a promise of the first block it logs. */
function harness(respond: () => Response | Promise<Response>, opts: { mode?: WireMode; maxBody?: number; traceId?: string } = {}) {
  let resolve!: (s: string) => void;
  const logged = new Promise<string>((r) => (resolve = r));
  const blocks: string[] = [];
  const f = wrapFetch(vi.fn(async () => respond()) as unknown as typeof fetch, {
    service: 'agent-copilot',
    mode: opts.mode ?? 'pretty',
    maxBody: opts.maxBody ?? 6000,
    write: (b) => {
      blocks.push(b);
      resolve(b);
    },
    spanContext: () => (opts.traceId ? { traceId: opts.traceId, spanId: 'span1' } : undefined),
  });
  return { f, logged, blocks };
}

const subject = jwt({ sub: 'alice', aud: 'agent-copilot', scope: 'openid inspect:read', exp: now + 600, jti: 'j1' });
const issued = jwt({
  sub: 'alice',
  aud: 'mcp-gateway',
  act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
  may_act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' },
  cnf: { jkt },
});
const proof = jwt({ htm: 'POST', htu: 'https://curity.localtest.me/oauth/v2/oauth-token', nonce: 'n1' }, { typ: 'dpop+jwt', alg: 'ES256', jwk });

async function exchange(mode: WireMode) {
  const { f, logged } = harness(
    () => json({ access_token: issued }, { headers: { 'x-frame-options': 'DENY', 'dpop-nonce': 'n2', date: 'x' } }),
    { mode, traceId: 't1' },
  );
  await f('https://curity.localtest.me/oauth/v2/oauth-token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', dpop: proof },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: subject,
      audience: 'mcp-gateway',
      scope: 'inspect:read',
    }),
  });
  return logged;
}

describe('pretty mode (HTTP_WIRE_LOG=on)', () => {
  it('heads a token exchange with what it asks for, then the URL and trace', async () => {
    const lines = (await exchange('pretty')).split('\n');
    expect(lines[0]).toMatch(/^┌─ #1 \S+ \[agent-copilot\] token-exchange {2}aud=mcp-gateway scope=inspect:read {2}\(DPoP-bound\)$/);
    expect(lines[1]).toBe('│ POST https://curity.localtest.me/oauth/v2/oauth-token');
    expect(lines[2]).toBe('│ trace t1 ▸ span1');
  });

  it('shortens raw JWTs and lists their claims one per line, identity claims first', async () => {
    const block = await exchange('pretty');
    expect(block).toContain(`│ subject_token=${subject.slice(0, 8)}…${subject.slice(-6)} (${subject.length} chars)`);
    expect(block).not.toContain(subject);
    expect(block).toMatch(/│ {5}sub {4}alice\n│ {5}aud {4}agent-copilot\n│ {5}scope {2}openid inspect:read\n│ {5}exp {4}\d\d:\d\d:\d\dZ \(in \d+s\)\n│ {5}other {2}jti/);
    expect(block).toContain('act      agent-copilot');
    expect(block).toContain('may_act  agentgateway');
    expect(block).toContain(`cnf      jkt=${jkt}`);
  });

  it("shows a DPoP proof's binding and its key thumbprint, which equals the issued token's cnf.jkt", async () => {
    const block = await exchange('pretty');
    expect(block).toContain('htu    https://curity.localtest.me/oauth/v2/oauth-token');
    expect(block).toContain('nonce  n1');
    expect(block).toContain(`key    jkt=${jkt} (ES256)`);
  });

  it('shows only protocol-relevant response headers', async () => {
    const block = await exchange('pretty');
    expect(block).toContain('│ dpop-nonce: n2');
    expect(block).not.toContain('x-frame-options');
  });

  it('names MCP calls by method and tool, and marks the unauthenticated discovery probe', async () => {
    const { f, blocks } = harness(() => json({}), { traceId: 't2' });
    const mcp = (body: object, auth?: string) =>
      f('https://mcp-gateway.localtest.me/inspect/mcp', {
        method: 'POST',
        headers: { 'mcp-protocol-version': '2026-07-28', ...(auth ? { authorization: auth } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
      });
    await mcp({ method: 'ping' });
    await mcp({ method: 'tools/call', params: { name: 'list_pods', arguments: { namespace: 'prod' } } }, `DPoP ${issued}`);
    await vi.waitFor(() => expect(blocks).toHaveLength(2));
    expect(blocks[0]).toMatch(/^┌─ #1 .* MCP ping {2}\(no token: discovery probe\)$/m);
    expect(blocks[1]).toMatch(/^┌─ #2 .* MCP tools\/call list_pods \{"namespace":"prod"\}$/m);
  });

  it('names A2A calls with the start of the delegated message', async () => {
    const { f, logged } = harness(() => json({}));
    await f('http://agent-specialist.agents.svc.cluster.local:8082/a2a', {
      method: 'POST',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'message/send', params: { message: { parts: [{ kind: 'text', text: 'restart checkout' }] } } }),
    });
    expect((await logged).split('\n')[0]).toMatch(/A2A message\/send {2}"restart checkout"$/);
  });

  it('cuts authorization-server metadata down to the fields the agents use', async () => {
    const { f, logged } = harness(() => json({ issuer: 'https://curity', token_endpoint: 'https://curity/token', a: 1, b: 2 }));
    await f('https://curity.localtest.me/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous');
    const block = await logged;
    expect(block).toContain('discovery  authorization-server metadata (RFC 8414)');
    expect(block).toContain('│ token_endpoint  https://curity/token');
    expect(block).toContain('│ … 2 more fields (HTTP_WIRE_LOG=full shows them)');
  });

  it('summarises an LLM exchange: tool names, clipped system prompt, tool calls, usage', async () => {
    const { f, logged } = harness(() =>
      json({
        model: 'claude-sonnet-4-6',
        choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ function: { name: 'list_pods', arguments: '{"namespace":"prod"}' } }] } }],
        usage: { prompt_tokens: 812, completion_tokens: 23 },
      }),
    );
    await f('http://agentgateway.mcp.svc.cluster.local:8080/llm/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'model-pinned-at-gateway',
        tool_choice: 'auto',
        tools: [{ type: 'function', function: { name: 'list_pods', parameters: { type: 'object' } } }],
        messages: [
          { role: 'system', content: 'l1\nl2\nl3\nl4\nl5\nl6' },
          { role: 'user', content: 'list the pods in prod' },
        ],
      }),
    });
    const block = await logged;
    expect(block.split('\n')[0]).toMatch(/LLM chat {2}2 messages, 1 tools$/);
    expect(block).toContain('│ tools        list_pods');
    expect(block).toContain('│ tool_choice  auto');
    expect(block).toContain('│   l4\n│   … (2 more lines)\n│ ── user\n│   list the pods in prod');
    expect(block).not.toContain('"parameters"');
    expect(block).toContain('│ finish  tool_calls');
    expect(block).toContain('│ usage   812 prompt → 23 completion tokens');
    expect(block).toContain('│   → tool_call list_pods {"namespace":"prod"}');
  });

  it('pretty-prints SSE data and prints an MCP tool result as text, not an escaped string', async () => {
    const rpc = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '[{"name":"checkout"}]' }] } };
    const { f, logged } = harness(
      () => new Response(`event: message\ndata: ${JSON.stringify(rpc)}\n\n`, { headers: { 'content-type': 'text/event-stream' } }),
    );
    await f('https://mcp-gateway.localtest.me/inspect/mcp', { method: 'POST' });
    const block = await logged;
    expect(block).toContain('│ event: message\n│ data:\n│   {\n│     "jsonrpc": "2.0"');
    expect(block).toContain('│   content[0] text:\n│     [\n│       {\n│         "name": "checkout"');
    expect(block).not.toMatch(/│\s*\n└─/);
  });

  it('expands a token once per trace and points back to it after that; a new trace starts over', async () => {
    let traceId = 't4';
    const blocks: string[] = [];
    const f = wrapFetch(vi.fn(async () => json({ access_token: issued })) as unknown as typeof fetch, {
      service: 'agent-copilot',
      mode: 'pretty',
      maxBody: 0,
      write: (b) => blocks.push(b),
      spanContext: () => ({ traceId, spanId: 's' }),
    });
    const call = () => f('https://mcp-gateway.localtest.me/inspect/mcp', { headers: { authorization: `DPoP ${issued}` } });
    await call();
    await vi.waitFor(() => expect(blocks).toHaveLength(1));
    await call();
    await vi.waitFor(() => expect(blocks).toHaveLength(2));
    traceId = 't5';
    await call();
    await vi.waitFor(() => expect(blocks).toHaveLength(3));

    const claimLines = (b: string) => b.split('\n').filter((l) => l.startsWith('│     may_act')).length;
    // #1: expanded on the request, then referenced in its own response.
    expect(claimLines(blocks[0]!)).toBe(1);
    expect(blocks[0]).toContain('(same token as above)');
    // #2: same trace, so only a reference.
    expect(claimLines(blocks[1]!)).toBe(0);
    expect(blocks[1]).toContain(`authorization: DPoP ${issued.slice(0, 8)}…${issued.slice(-6)} (${issued.length} chars) (same token as #1)`);
    // A different trace expands it again.
    expect(claimLines(blocks[2]!)).toBe(1);
  });

  it('numbers calls per trace, in the order they were sent', async () => {
    const { f, blocks } = harness(() => new Response(''), { traceId: 't3' });
    await f('http://x/a');
    await f('http://x/b');
    await vi.waitFor(() => expect(blocks).toHaveLength(2));
    expect(blocks.map((b) => /^┌─ (#\d+)/.exec(b)?.[1])).toEqual(['#1', '#2']);
  });
});

describe('full mode (HTTP_WIRE_LOG=full)', () => {
  it('keeps raw JWTs with their payload as one JSON line, and every non-noise header', async () => {
    const block = await exchange('full');
    expect(block).toContain(`│ subject_token=${subject}\n│     ⇢ {"sub":"alice"`);
    expect(block).toContain(`⇢ {"typ":"dpop+jwt","alg":"ES256","jwk":`);
    expect(block).toContain('x-frame-options: DENY');
    expect(block).not.toContain('date: x');
    expect(block).not.toContain('same token as');
  });
});

describe('wrapFetch', () => {
  it('hands the caller the untouched response, body still readable', async () => {
    const { f } = harness(() => new Response('hello'));
    const res = await f('http://x/', {});
    expect(await res.text()).toBe('hello');
  });

  it('logs a rejected fetch and rethrows the original error', async () => {
    const { f, logged } = harness(() => {
      throw new Error('ECONNREFUSED');
    });
    await expect(f('http://x/', { method: 'POST', body: '{}' })).rejects.toThrow('ECONNREFUSED');
    expect(await logged).toContain('◀ FAILED');
  });

  it('truncates long bodies and says how much was cut', async () => {
    const { f, logged } = harness(() => new Response('a'.repeat(50)), { maxBody: 10 });
    await f('http://x/');
    expect(await logged).toContain('… (40 more chars; raise HTTP_WIRE_LOG_MAX_BODY)');
  });

  it('reads the body of a Request input without consuming the one fetch sends', async () => {
    let sent = '';
    const g = wrapFetch(
      vi.fn(async (input: Request) => {
        sent = await input.text();
        return new Response('');
      }) as unknown as typeof fetch,
      { service: 's', mode: 'pretty', maxBody: 0, write: () => {} },
    );
    await g(new Request('http://x/', { method: 'POST', body: 'payload' }));
    expect(sent).toBe('payload');

    const { f, logged } = harness(() => new Response(''));
    await f(new Request('http://x/', { method: 'PUT', body: 'payload' }));
    expect(await logged).toContain('│ payload');
  });

  it('never fails a request because logging failed', async () => {
    const f = wrapFetch(vi.fn(async () => new Response('ok')) as unknown as typeof fetch, {
      service: 's',
      mode: 'pretty',
      maxBody: 0,
      write: () => {
        throw new Error('stdout closed');
      },
    });
    const res = await f('http://x/');
    expect(await res.text()).toBe('ok');
  });
});

describe('installWireLog', () => {
  it('is off unless HTTP_WIRE_LOG is on or full', () => {
    const before = globalThis.fetch;
    expect(installWireLog({})).toBe(false);
    expect(installWireLog({ HTTP_WIRE_LOG: 'yes' })).toBe(false);
    expect(globalThis.fetch).toBe(before);
  });
});
