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
