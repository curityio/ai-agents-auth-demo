import { describe, it, expect } from 'vitest';
import { formatOboLog, summarizeJwt, flattenAct } from './obo-log.js';

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
});
