/**
 * The copilot's observability auth provider wires discovery to the existing
 * exchange: the token endpoint and scope it exchanges with must be the ones
 * discovery returned, and the /tools probe's `recordLastExchange: false` must
 * reach the exchange (fact #34: probes are not flows).
 */
import { describe, it, expect, vi } from 'vitest';

const obtainMcpToken = vi.fn(async (..._a: unknown[]) => 'OBS_TOKEN');
vi.mock('../src/mcp-client.js', () => ({ obtainMcpToken: (...a: unknown[]) => obtainMcpToken(...a) }));

const createMcpAuthProvider = vi.fn();
vi.mock('@ai-agents-demo/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-agents-demo/agent-runtime')>();
  return { ...actual, createMcpAuthProvider: (...a: unknown[]) => createMcpAuthProvider(...a) };
});

import { buildObservabilityAuthProvider } from '../src/mcp-auth.js';
import type { Config } from '../src/config.js';

const cfg = { mcpObservabilityUrl: 'https://mcp-gateway.localtest.me/observability/mcp' } as unknown as Config;

describe('buildObservabilityAuthProvider', () => {
  it('targets the configured server URL and exchanges with the DISCOVERED endpoint and scope', async () => {
    createMcpAuthProvider.mockImplementation((o: { serverUrl: string; exchange: (i: unknown) => Promise<string> }) => o);
    const p = buildObservabilityAuthProvider({ cfg, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa' }) as unknown as {
      serverUrl: string;
      service: string;
      exchange: (i: { tokenEndpoint: string; scope: string }) => Promise<string>;
    };
    expect(p.serverUrl).toBe(cfg.mcpObservabilityUrl);
    expect(p.service).toBe('agent-copilot');
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'obs:read' });
    expect(obtainMcpToken).toHaveBeenCalledWith(
      expect.objectContaining({ tokenEndpoint: 'https://as/token', scope: 'obs:read', subjectSub: 'alice', subjectAcr: 'mfa' }),
    );
  });

  it('passes recordLastExchange through so a probe is not recorded as a flow', async () => {
    createMcpAuthProvider.mockImplementation((o: { exchange: (i: unknown) => Promise<string> }) => o);
    const p = buildObservabilityAuthProvider({
      cfg, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa', recordLastExchange: false,
    }) as unknown as { exchange: (i: { tokenEndpoint: string; scope: string }) => Promise<string> };
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'obs:read' });
    expect(obtainMcpToken).toHaveBeenCalledWith(expect.objectContaining({ recordLastExchange: false }));
  });
});
