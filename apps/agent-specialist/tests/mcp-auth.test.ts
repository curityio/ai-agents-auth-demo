/**
 * Both specialist providers pin the discovered authorization server to the issuer
 * this agent already trusts: a PRM (or a compromised gateway) must not be able to
 * redirect the user's delegated token to a foreign AS.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/mcp-ops-client.js', () => ({ obtainOpsToken: vi.fn(async () => 'OPS') }));
vi.mock('../src/obs-token.js', () => ({ obtainObsToken: vi.fn(async () => 'OBS') }));
const createMcpAuthProvider = vi.fn();
vi.mock('@ai-agents-demo/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-agents-demo/agent-runtime')>();
  return { ...actual, createMcpAuthProvider: (...a: unknown[]) => createMcpAuthProvider(...a) };
});

import { buildOpsAuthProvider, buildObsAuthProvider } from '../src/mcp-auth.js';
import type { Config } from '../src/config.js';

const cfg = {
  mcpOpsUrl: 'https://mcp-gateway.localtest.me/ops/mcp',
  mcpObservabilityUrl: 'https://mcp-gateway.localtest.me/observability/mcp',
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
} as unknown as Config;

describe('specialist auth providers', () => {
  it('pin the authorization server to CURITY_ISSUER on both tiers', () => {
    createMcpAuthProvider.mockImplementation((o: unknown) => o);
    const ops = buildOpsAuthProvider({ cfg, subjectToken: 'U', subjectSub: 'alice' }) as unknown as { serverUrl: string; allowedAuthorizationServers: string[] };
    const obs = buildObsAuthProvider({ cfg, subjectToken: 'U' }) as unknown as { serverUrl: string; allowedAuthorizationServers: string[] };
    expect(ops.serverUrl).toBe(cfg.mcpOpsUrl);
    expect(obs.serverUrl).toBe(cfg.mcpObservabilityUrl);
    expect(ops.allowedAuthorizationServers).toEqual([cfg.curityIssuer]);
    expect(obs.allowedAuthorizationServers).toEqual([cfg.curityIssuer]);
  });
});
