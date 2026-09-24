import { describe, it, expect, vi, afterEach } from 'vitest';
import { trace } from '@opentelemetry/api';
import { formatOboLog, summarizeJwt, flattenAct, oboLog, traceFields } from './obo-log.js';

const TRACE_ID = '2e167fa6e19030ede6429c533dab3874';
const SPAN_ID = 'b6dda66790f72dd9';

function makeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.`;
}

describe('flattenAct', () => {
  it('returns undefined for non-object input', () => {
    expect(flattenAct(undefined)).toBeUndefined();
    expect(flattenAct(null)).toBeUndefined();
    expect(flattenAct('nope')).toBeUndefined();
  });

  it('renders a single actor', () => {
    expect(flattenAct({ sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' })).toBe(
      'agent-copilot',
    );
  });

  it('renders a nested chain oldest→newest, shortened to SA', () => {
    const act = {
      sub: 'spiffe://demo.curity.local/ns/mcp/sa/mcp-ops',
      act: {
        sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-specialist',
        act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
      },
    };
    expect(flattenAct(act)).toBe('agent-copilot ▸ agent-specialist ▸ mcp-ops');
  });
});

describe('summarizeJwt', () => {
  it('returns empty object for missing/garbage tokens', () => {
    expect(summarizeJwt(undefined)).toEqual({});
    expect(summarizeJwt('not-a-jwt')).toEqual({});
  });

  it('extracts identity claims', () => {
    const jwt = makeJwt({
      sub: 'alice',
      aud: ['agent-copilot'],
      scope: 'obs:read ops:write',
      acr: 'mfa',
      roles: ['sre', 'oncall'],
      act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
    });
    expect(summarizeJwt(jwt)).toEqual({
      sub: 'alice',
      aud: 'agent-copilot',
      scope: 'obs:read ops:write',
      acr: 'mfa',
      roles: 'sre, oncall',
      act: 'agent-copilot',
    });
  });
});

describe('formatOboLog', () => {
  it('renders an aligned box with a headline and fields', () => {
    const out = formatOboLog({
      service: 'agent-copilot',
      kind: 'EXCHANGE',
      headline: '→ mcp-observability',
      fields: { user: 'alice', scope: 'obs:read' },
    });
    expect(out).toContain('┌─ INFO [agent-copilot] EXCHANGE → mcp-observability');
    expect(out).toContain('│  user  : alice');
    expect(out).toContain('│  scope : obs:read');
    expect(out.endsWith('└─')).toBe(true);
  });

  it('omits empty/undefined fields', () => {
    const out = formatOboLog({
      service: 'obs-api',
      kind: 'RECEIVE',
      headline: 'GET /pods',
      fields: { sub: 'alice', acr: undefined, note: '' },
    });
    expect(out).toContain('sub');
    expect(out).not.toContain('acr');
    expect(out).not.toContain('note');
  });
  it('renders a DISCOVER block for an OAuth discovery run', () => {
    const out = formatOboLog({
      service: 'agent-specialist',
      kind: 'DISCOVER',
      headline: '→ https://mcp-gateway.localtest.me/ops/mcp',
      fields: {
        resource_metadata: 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp',
        'authorization srv': 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
        'scope selected': 'ops:write (from scopes_supported)',
      },
    });
    expect(out).toContain('┌─ INFO [agent-specialist] DISCOVER → https://mcp-gateway.localtest.me/ops/mcp');
    expect(out).toContain('│  authorization srv : https://curity.localtest.me/oauth/v2/oauth-anonymous');
  });
});

describe('traceFields', () => {
  it('extracts the trace and span ids from a span', () => {
    const span = trace.wrapSpanContext({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 });
    expect(traceFields(span)).toEqual({ traceId: TRACE_ID, spanId: SPAN_ID });
  });

  it('returns nothing when there is no active span', () => {
    expect(traceFields(undefined)).toEqual({});
  });

  it('ignores an all-zero span context rather than logging a useless id', () => {
    const span = trace.wrapSpanContext({
      traceId: '0'.repeat(32),
      spanId: '0'.repeat(16),
      traceFlags: 0,
    });
    expect(traceFields(span)).toEqual({});
  });
});

describe('formatOboLog timestamp', () => {
  it('renders the emission time on the header line', () => {
    const out = formatOboLog({
      service: 'obs-api',
      kind: 'RECEIVE',
      headline: 'GET /pods',
      at: '2026-08-07T07:48:08.619Z',
    });
    expect(out.split('\n')[0]).toBe('┌─ 2026-08-07T07:48:08.619Z INFO [obs-api] RECEIVE GET /pods');
  });

  it('leaves the header unchanged when no time is supplied', () => {
    const out = formatOboLog({ service: 'obs-api', kind: 'RECEIVE', headline: 'GET /pods' });
    expect(out.split('\n')[0]).toBe('┌─ INFO [obs-api] RECEIVE GET /pods');
  });
});

describe('formatOboLog trace correlation', () => {
  it('renders trace ▸ span as the first field, ahead of the caller fields', () => {
    const out = formatOboLog({
      service: 'mcp-observability',
      kind: 'RECEIVE',
      headline: 'MCP tool list_pods',
      trace: { traceId: TRACE_ID, spanId: SPAN_ID },
      fields: { user: 'alice' },
    });
    const lines = out.split('\n');
    expect(lines[1]).toBe(`│  trace : ${TRACE_ID} ▸ ${SPAN_ID}`);
    expect(lines[2]).toBe('│  user  : alice');
  });

  it('renders the trace id alone when there is no span id', () => {
    const out = formatOboLog({
      service: 'web',
      kind: 'CALL',
      headline: '→ agent-copilot',
      trace: { traceId: TRACE_ID },
    });
    expect(out).toContain(`│  trace : ${TRACE_ID}`);
    expect(out).not.toContain('▸');
  });

  it('omits the trace field entirely when no trace context exists', () => {
    const out = formatOboLog({
      service: 'web',
      kind: 'CALL',
      headline: '→ agent-copilot',
      trace: {},
      fields: { user: 'alice' },
    });
    expect(out).not.toContain('trace');
  });
});

describe('oboLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stamps every line it emits with the current time', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    oboLog({ service: 'obs-api', kind: 'RECEIVE', headline: 'GET /pods' });
    const header = spy.mock.calls[0]![0]!.split('\n')[0]!;
    expect(header).toMatch(/^┌─ \d{4}-\d{2}-\d{2}T[\d:.]+Z INFO \[obs-api\] RECEIVE GET \/pods$/);
  });
});

describe('may_act (RFC 8693 §4.4)', () => {
  const enc = (o: unknown) => `x.${Buffer.from(JSON.stringify(o)).toString('base64url')}.y`;

  it('surfaces may_act.sub shortened to its service account', () => {
    const jwt = enc({
      sub: 'alice',
      may_act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' },
    });
    expect(summarizeJwt(jwt).mayAct).toBe('agentgateway');
  });

  it('is undefined on terminal tokens that carry no may_act', () => {
    expect(summarizeJwt(enc({ sub: 'alice' })).mayAct).toBeUndefined();
  });

  it('distinguishes who DID act from who MAY act next', () => {
    // The specialist has acted (act chain); the gateway is permitted next.
    const s = summarizeJwt(
      enc({
        sub: 'alice',
        act: {
          sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-specialist',
          act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
        },
        may_act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' },
      }),
    );
    expect(s.act).toBe('agent-copilot ▸ agent-specialist');
    expect(s.mayAct).toBe('agentgateway');
  });

  it('ignores a malformed may_act rather than throwing', () => {
    expect(summarizeJwt(enc({ may_act: 'not-an-object' })).mayAct).toBeUndefined();
    expect(summarizeJwt(enc({ may_act: {} })).mayAct).toBeUndefined();
  });
});

describe('activeTraceId', () => {
  afterEach(() => vi.restoreAllMocks());
  it('returns the trace id of the active span, so a response can carry it to the UI', async () => {
    const { activeTraceId } = await import('./obo-log.js');
    const span = trace.wrapSpanContext({
      traceId: 'abcdefabcdefabcdefabcdefabcdef12',
      spanId: '1234567812345678',
      traceFlags: 1,
    });
    // The bare API ships a no-op context manager, so stub the lookup itself.
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span);
    expect(activeTraceId()).toBe('abcdefabcdefabcdefabcdefabcdef12');
  });
  it('is undefined with no active span — never a string of zeros that looks real', async () => {
    const { activeTraceId } = await import('./obo-log.js');
    expect(activeTraceId()).toBeUndefined();
  });
});
