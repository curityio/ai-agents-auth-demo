import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const REQUIRED = {
  CURITY_ISSUER: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  CURITY_JWKS_URI: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  CURITY_TOKEN_ENDPOINT: 'https://curity.localtest.me/oauth/v2/oauth-token',
  CURITY_CLIENT_SECRET: 'test',
  INSPECT_API_URL: 'http://inspect-api.apis.svc.cluster.local:8084',
};

describe('loadConfig (mcp-inspect)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env = { ...saved };
    Object.assign(process.env, REQUIRED);
    // Ensure the default (not an override) is exercised.
    delete process.env.ACTOR_PATTERN;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('applies mcp-inspect defaults', () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8080);
    expect(cfg.expectedAudience).toBe('mcp-inspect');
    expect(cfg.requiredScopes).toEqual(['inspect:read']);
  });

  it('accepts the agentgateway as the immediate actor (all traffic is gateway-fronted)', () => {
    const cfg = loadConfig();
    expect(cfg.actorPattern.test('spiffe://demo.curity.local/ns/mcp/sa/agentgateway')).toBe(true);
  });

  it('rejects a bare agent actor — agents no longer call mcp-inspect directly', () => {
    const cfg = loadConfig();
    expect(cfg.actorPattern.test('spiffe://demo.curity.local/ns/agents/sa/agent-copilot')).toBe(false);
    expect(cfg.actorPattern.test('spiffe://demo.curity.local/ns/agents/sa/agent-specialist')).toBe(false);
  });
});
