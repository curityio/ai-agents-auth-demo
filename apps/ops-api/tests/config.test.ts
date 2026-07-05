import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  CURITY_ISSUER: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  CURITY_JWKS_URI: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
};

describe('loadConfig (ops-api)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved };
    Object.assign(process.env, REQUIRED);
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('applies ops-api defaults', () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8083);
    expect(cfg.expectedAudience).toBe('ops-api');
    expect(cfg.requiredScopes).toEqual(['ops:write']);
    expect(cfg.requiredAcr).toBe('mfa');
    expect(cfg.targetNamespace).toBe('prod');
    expect(cfg.expectedActorChain.map((re) => re.source)).toEqual([
      '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/mcp\\/sa\\/mcp-ops$',
      '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/mcp\\/sa\\/agentgateway$',
      '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/agents\\/sa\\/agent-specialist$',
      '^spiffe:\\/\\/demo\\.curity\\.local\\/ns\\/agents\\/sa\\/agent-copilot$',
    ]);
  });

  it('throws when a required env var is missing', () => {
    delete process.env.CURITY_ISSUER;
    expect(() => loadConfig()).toThrow(/CURITY_ISSUER/);
  });

  it('includes agentgateway as the second chain position', () => {
    const cfg = loadConfig();
    expect(cfg.expectedActorChain.length).toBe(4);
    expect(cfg.expectedActorChain[1]!.test('spiffe://demo.curity.local/ns/mcp/sa/agentgateway')).toBe(
      true,
    );
  });
});
