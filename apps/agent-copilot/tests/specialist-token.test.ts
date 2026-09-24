/**
 * obtainSpecialistToken's exchange cache honours cfg.exchangeCacheTtlMs
 * (TOKEN_EXCHANGE_CACHE_TTL_SECONDS); the demo sets 0 so every privileged question
 * shows the aud=agent-specialist exchange in its trace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const exchangeToken = vi.fn();
vi.mock('@ai-agents-demo/auth-curity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-agents-demo/auth-curity')>();
  return { ...actual, exchangeToken: (...a: unknown[]) => exchangeToken(...a) };
});
vi.mock('@ai-agents-demo/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-agents-demo/agent-runtime')>();
  return { ...actual, resolveAuthorizationServer: async () => ({ tokenEndpoint: 'https://as/token' }) };
});
vi.mock('@ai-agents-demo/spiffe', () => ({
  SpiffeJwtSvidSource: class {
    async getSvid() {
      return { jwt: 'svid.jwt' };
    }
  },
}));
vi.mock('../src/cimd-identity.js', () => ({ getCimdIdentity: async () => ({ kid: 'k1' }) }));

import { obtainSpecialistToken } from '../src/specialist-client.js';
import type { Config } from '../src/config.js';

const base = {
  agentClientId: 'https://copilot.localtest.me/.well-known/oauth-client',
  agentPrivateKeyPem: 'pem',
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  specialistAudience: 'agent-specialist',
  specialistScope: 'ops:write obs:read llm:invoke',
} as unknown as Config;
const U = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSIsImp0aSI6ImoxIn0.sig';

beforeEach(() => {
  exchangeToken.mockReset();
  exchangeToken.mockResolvedValue({ accessToken: 'SPEC', tokenType: 'Bearer', expiresInSec: 600, scope: 'ops:write', issuedTokenType: 'x' });
});

describe('obtainSpecialistToken exchange cache', () => {
  it('caches for cfg.exchangeCacheTtlMs (60 s default)', async () => {
    const cfg = { ...base, exchangeCacheTtlMs: 60_000 } as Config;
    const args = { cfg, subjectToken: U, subjectSub: 'alice-cached', subjectAcr: 'mfa' };
    await obtainSpecialistToken(args);
    await obtainSpecialistToken(args);
    expect(exchangeToken).toHaveBeenCalledTimes(1);
  });

  it('with cfg.exchangeCacheTtlMs = 0 (the demo setting) every call exchanges', async () => {
    const cfg = { ...base, exchangeCacheTtlMs: 0 } as Config;
    const args = { cfg, subjectToken: U, subjectSub: 'alice-nocache', subjectAcr: 'mfa' };
    await obtainSpecialistToken(args);
    await obtainSpecialistToken(args);
    expect(exchangeToken).toHaveBeenCalledTimes(2);
  });
});
