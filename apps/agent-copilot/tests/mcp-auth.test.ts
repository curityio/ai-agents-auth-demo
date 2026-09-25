/**
 * The copilot's inspect auth provider wires discovery to the existing
 * exchange: the token endpoint and scope it exchanges with must be the ones
 * discovery returned, and the /tools probe's `recordLastExchange: false` must
 * reach the exchange (fact #34: probes are not flows).
 */
import { describe, it, expect, vi } from 'vitest';

const obtainMcpToken = vi.fn(async (..._a: unknown[]) => 'INSPECT_TOKEN');
vi.mock('../src/mcp-client.js', () => ({ obtainMcpToken: (...a: unknown[]) => obtainMcpToken(...a) }));

const createMcpAuthProvider = vi.fn();
vi.mock('@ai-agents-demo/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-agents-demo/agent-runtime')>();
  return { ...actual, createMcpAuthProvider: (...a: unknown[]) => createMcpAuthProvider(...a) };
});

import { buildInspectAuthProvider } from '../src/mcp-auth.js';
import type { Config } from '../src/config.js';

const cfg = {
  mcpInspectUrl: 'https://mcp-gateway.localtest.me/inspect/mcp',
  curityIssuer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
} as unknown as Config;

describe('buildInspectAuthProvider', () => {
  it('targets the configured server URL and exchanges with the DISCOVERED endpoint and scope', async () => {
    createMcpAuthProvider.mockImplementation((o: { serverUrl: string; exchange: (i: unknown) => Promise<string> }) => o);
    const p = buildInspectAuthProvider({ cfg, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa' }) as unknown as {
      serverUrl: string;
      service: string;
      exchange: (i: { tokenEndpoint: string; scope: string }) => Promise<string>;
    };
    expect(p.serverUrl).toBe(cfg.mcpInspectUrl);
    expect(p.service).toBe('agent-copilot');
    // The discovered AS must be the one this agent already trusts for inbound tokens.
    expect((p as unknown as { allowedAuthorizationServers: string[] }).allowedAuthorizationServers).toEqual([cfg.curityIssuer]);
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'inspect:read' });
    expect(obtainMcpToken).toHaveBeenCalledWith(
      expect.objectContaining({ tokenEndpoint: 'https://as/token', scope: 'inspect:read', subjectSub: 'alice', subjectAcr: 'mfa' }),
    );
  });

  it('passes the configured discovery TTL through (the demo sets 0 so every question shows the chain)', () => {
    createMcpAuthProvider.mockImplementation((o: unknown) => o);
    const p = buildInspectAuthProvider({ cfg: { ...cfg, mcpDiscoveryTtlMs: 0 } as Config, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa' }) as unknown as { discoveryTtlMs: number };
    expect(p.discoveryTtlMs).toBe(0);
  });

  it('passes recordLastExchange through so a probe is not recorded as a flow', async () => {
    createMcpAuthProvider.mockImplementation((o: { exchange: (i: unknown) => Promise<string> }) => o);
    const p = buildInspectAuthProvider({
      cfg, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa', recordLastExchange: false,
    }) as unknown as { exchange: (i: { tokenEndpoint: string; scope: string }) => Promise<string> };
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'inspect:read' });
    expect(obtainMcpToken).toHaveBeenCalledWith(expect.objectContaining({ recordLastExchange: false }));
  });

  it('a FORCED exchange (the transport saw a 401) bypasses the 60 s token cache; a normal one does not', async () => {
    createMcpAuthProvider.mockImplementation((o: { exchange: (i: unknown) => Promise<string> }) => o);
    const p = buildInspectAuthProvider({ cfg, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa' }) as unknown as {
      exchange: (i: { tokenEndpoint: string; scope: string; forced: boolean }) => Promise<string>;
    };
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'inspect:read', forced: false });
    expect(obtainMcpToken).toHaveBeenLastCalledWith(expect.objectContaining({ bypassCache: false }));
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'inspect:read', forced: true });
    expect(obtainMcpToken).toHaveBeenLastCalledWith(expect.objectContaining({ bypassCache: true }));
  });
});
