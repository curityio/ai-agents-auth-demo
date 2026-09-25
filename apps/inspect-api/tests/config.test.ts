import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  CURITY_ISSUER: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  CURITY_JWKS_URI: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
};

describe('loadConfig (inspect-api)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved };
    Object.assign(process.env, REQUIRED);
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('applies inspect-api defaults', () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8084);
    expect(cfg.expectedAudience).toBe('inspect-api');
    expect(cfg.requiredScopes).toEqual(['inspect:read']);
    expect(cfg.targetNamespace).toBe('prod');
    expect(cfg.expectedActorChains.map((c) => c.map((re) => re.source))).toEqual([
      [
        '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/mcp\\/sa\\/mcp-inspect$',
        '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/mcp\\/sa\\/agentgateway$',
        '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/agents\\/sa\\/agent-copilot$',
      ],
      [
        '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/mcp\\/sa\\/mcp-inspect$',
        '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/mcp\\/sa\\/agentgateway$',
        '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/agents\\/sa\\/agent-specialist$',
        '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/agents\\/sa\\/agent-copilot$',
      ],
    ]);
  });

  it('throws when a required env var is missing', () => {
    delete process.env.CURITY_JWKS_URI;
    expect(() => loadConfig()).toThrow(/CURITY_JWKS_URI/);
  });

  it('accepts the agentgateway position in both read chains', () => {
    const cfg = loadConfig();
    const gw = 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway';
    // Path A: [mcp-inspect, gateway, copilot]
    expect(cfg.expectedActorChains[0]![1]!.test(gw)).toBe(true);
    expect(cfg.expectedActorChains[0]!.length).toBe(3);
    // Path B: [mcp-inspect, gateway, specialist, copilot]
    expect(cfg.expectedActorChains[1]![1]!.test(gw)).toBe(true);
    expect(cfg.expectedActorChains[1]!.length).toBe(4);
  });
});
