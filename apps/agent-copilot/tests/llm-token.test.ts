/**
 * obtainLlmToken's exchange cache honours cfg.exchangeCacheTtlMs
 * (TOKEN_EXCHANGE_CACHE_TTL_SECONDS). The demo sets 0 so every question's trace
 * shows the aud=llm-gateway exchange; with the old fixed 60 s a second question
 * within a minute showed none.
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

import { obtainLlmToken } from '../src/llm-token.js';
import type { Config } from '../src/config.js';

const base = {
  agentClientId: 'https://agent.localtest.me/.well-known/oauth-client',
  agentPrivateKeyPem: 'pem',
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  llmGatewayAudience: 'llm-gateway',
  llmGatewayScope: 'llm:invoke',
} as unknown as Config;
// a signed-looking subject token, so jtiOf() (copilot) can decode it
const U = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhbGljZSIsImp0aSI6ImoxIn0.sig';

beforeEach(() => {
  exchangeToken.mockReset();
  exchangeToken.mockResolvedValue({ accessToken: 'LLM', tokenType: 'Bearer', expiresInSec: 600, scope: 'llm:invoke', issuedTokenType: 'x' });
});

describe('obtainLlmToken exchange cache', () => {
  it('caches for cfg.exchangeCacheTtlMs (60 s default): a second call within the window does not exchange', async () => {
    const cfg = { ...base, exchangeCacheTtlMs: 60_000 } as Config;
    const args = { cfg, subjectToken: U, subjectSub: 'alice-cached', subjectAcr: 'html-form' };
    await obtainLlmToken(args);
    await obtainLlmToken(args);
    expect(exchangeToken).toHaveBeenCalledTimes(1);
  });

  it('with cfg.exchangeCacheTtlMs = 0 (the demo setting) every call exchanges', async () => {
    const cfg = { ...base, exchangeCacheTtlMs: 0 } as Config;
    const args = { cfg, subjectToken: U, subjectSub: 'alice-nocache', subjectAcr: 'html-form' };
    await obtainLlmToken(args);
    await obtainLlmToken(args);
    expect(exchangeToken).toHaveBeenCalledTimes(2);
  });
});
