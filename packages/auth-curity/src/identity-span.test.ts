import { describe, it, expect } from 'vitest';
import { buildIdentityAttributes } from './identity-span.js';
import type { VerifiedJwt } from './verify.js';

function vj(payload: VerifiedJwt['payload']): VerifiedJwt {
  return {
    payload,
    protectedHeader: { alg: 'RS256' },
    scopes: new Set(
      (payload.scope ?? '').split(' ').filter(Boolean),
    ),
  };
}

describe('buildIdentityAttributes', () => {
  it('maps sub, scope and acr', () => {
    const attrs = buildIdentityAttributes(
      vj({ sub: 'alice', scope: 'inspect:read ops:write', acr: 'mfa' }),
    );
    expect(attrs['auth.sub']).toBe('alice');
    expect(attrs['auth.scope']).toBe('inspect:read ops:write');
    expect(attrs['auth.acr']).toBe('mfa');
  });

  it('maps audience as array', () => {
    const attrs = buildIdentityAttributes(
      vj({ sub: 'alice', aud: ['web', 'agent-copilot'] }),
    );
    expect(attrs['auth.aud']).toEqual(['web', 'agent-copilot']);
  });

  it('maps single audience string as array', () => {
    const attrs = buildIdentityAttributes(
      vj({ sub: 'alice', aud: 'agent-copilot' }),
    );
    expect(attrs['auth.aud']).toEqual(['agent-copilot']);
  });

  it('maps roles claim', () => {
    const attrs = buildIdentityAttributes(
      vj({ sub: 'alice', roles: ['sre', 'oncall'] } as VerifiedJwt['payload']),
    );
    expect(attrs['auth.roles']).toEqual(['sre', 'oncall']);
  });

  it('flattens the nested RFC 8693 act chain outer→inner', () => {
    const attrs = buildIdentityAttributes(
      vj({
        sub: 'alice',
        act: { sub: 'agent-specialist', act: { sub: 'agent-copilot' } },
      }),
    );
    expect(attrs['auth.act']).toEqual(['agent-specialist', 'agent-copilot']);
  });

  it('omits auth.act when there is no act claim', () => {
    const attrs = buildIdentityAttributes(vj({ sub: 'alice' }));
    expect('auth.act' in attrs).toBe(false);
  });

  it('stops at the first node missing a string sub', () => {
    const attrs = buildIdentityAttributes(
      vj({ sub: 'alice', act: { sub: 'agent-copilot', act: { foo: 'bar' } as never } }),
    );
    expect(attrs['auth.act']).toEqual(['agent-copilot']);
  });

  it('maps the RFC 8693 may_act sub as the full SPIFFE ID', () => {
    const attrs = buildIdentityAttributes(
      vj({
        sub: 'alice',
        may_act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/mcp-inspect' },
      } as VerifiedJwt['payload']),
    );
    expect(attrs['auth.may_act']).toBe('spiffe://demo.curity.local/ns/mcp/sa/mcp-inspect');
  });

  it('omits auth.may_act when the claim is absent or has no string sub', () => {
    expect('auth.may_act' in buildIdentityAttributes(vj({ sub: 'alice' }))).toBe(false);
    const malformed = buildIdentityAttributes(
      vj({ sub: 'alice', may_act: { client_id: 'x' } } as VerifiedJwt['payload']),
    );
    expect('auth.may_act' in malformed).toBe(false);
  });

  it('maps auth.scope from an scp array (no scope string)', () => {
    const attrs = buildIdentityAttributes({
      payload: { sub: 'alice', scp: ['inspect:read', 'ops:write'] },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['inspect:read', 'ops:write']),
    });
    expect(attrs['auth.scope']).toBe('inspect:read ops:write');
  });
});

describe('buildIdentityAttributes DPoP binding', () => {
  it('maps cnf.jkt so a receiver span shows the inbound token is sender-constrained', () => {
    const attrs = buildIdentityAttributes(vj({ sub: 'alice', cnf: { jkt: 'thumb' } } as VerifiedJwt['payload']));
    expect(attrs['auth.cnf_jkt']).toBe('thumb');
    expect('auth.cnf_jkt' in buildIdentityAttributes(vj({ sub: 'alice' }))).toBe(false);
  });
});

describe('upstreamVerifiedIdentityAttributes', () => {
  it('maps a token a trusted upstream already verified (the shim behind the gateway JWT check)', async () => {
    const { upstreamVerifiedIdentityAttributes } = await import('./identity-span.js');
    const token =
      [{ alg: 'RS256' }, {
        sub: 'alice', aud: 'mcp-gateway', scope: 'inspect:read',
        act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot' },
        may_act: { sub: 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway' },
        cnf: { jkt: 'thumb' },
      }].map((o) => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.sig';
    expect(upstreamVerifiedIdentityAttributes(token)).toMatchObject({
      'auth.sub': 'alice',
      'auth.scope': 'inspect:read',
      'auth.aud': ['mcp-gateway'],
      'auth.act': ['spiffe://demo.curity.local/ns/agents/sa/agent-copilot'],
      'auth.may_act': 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway',
      'auth.cnf_jkt': 'thumb',
    });
  });

  it('yields nothing for an undecodable token rather than throwing', async () => {
    const { upstreamVerifiedIdentityAttributes } = await import('./identity-span.js');
    expect(upstreamVerifiedIdentityAttributes('garbage')).toEqual({});
  });
});
