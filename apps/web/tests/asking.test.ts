/**
 * The "Asking as …" line under the prompt box shows the claims the request
 * will carry BEFORE it is sent, so the presenter can point at acr before
 * clicking a privileged prompt. They are decoded from the access token on
 * the server; the token itself never reaches the browser.
 */
import { describe, it, expect } from 'vitest';
import { identityFromAccessToken } from '../src/lib/asking';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

describe('identityFromAccessToken', () => {
  it('reads sub, roles and acr', () => {
    expect(
      identityFromAccessToken(jwt({ sub: 'alice', roles: ['sre', 'oncall'], acr: 'html-form' })),
    ).toEqual({ sub: 'alice', roles: ['sre', 'oncall'], acr: 'html-form' });
  });
  it('tolerates a single-string roles claim and missing claims', () => {
    expect(identityFromAccessToken(jwt({ sub: 'bob', roles: 'developer' }))).toEqual({
      sub: 'bob',
      roles: ['developer'],
      acr: undefined,
    });
  });
  it('returns nothing usable for garbage, never throws', () => {
    expect(identityFromAccessToken('not.a.jwt')).toEqual({
      sub: undefined,
      roles: [],
      acr: undefined,
    });
    expect(identityFromAccessToken(undefined)).toEqual({
      sub: undefined,
      roles: [],
      acr: undefined,
    });
  });
});
