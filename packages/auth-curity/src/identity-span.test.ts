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
      vj({ sub: 'alice', scope: 'obs:read ops:write', acr: 'mfa' }),
    );
    expect(attrs['auth.sub']).toBe('alice');
    expect(attrs['auth.scope']).toBe('obs:read ops:write');
    expect(attrs['auth.acr']).toBe('mfa');
  });

  it('maps audience as array', () => {
    const attrs = buildIdentityAttributes(
      vj({ sub: 'alice', aud: ['web-app', 'agent-copilot'] }),
    );
    expect(attrs['auth.aud']).toEqual(['web-app', 'agent-copilot']);
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

  it('maps auth.scope from an scp array (no scope string)', () => {
    const attrs = buildIdentityAttributes({
      payload: { sub: 'alice', scp: ['obs:read', 'ops:write'] },
      protectedHeader: { alg: 'RS256' },
      scopes: new Set(['obs:read', 'ops:write']),
    });
    expect(attrs['auth.scope']).toBe('obs:read ops:write');
  });
});
