import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildLlm, type LlmConfig } from './llm.js';

const gw: LlmConfig = {
  llmProvider: 'gateway',
  llmModel: 'gpt-4.1',
  llmGatewayUrl: 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
};

describe('buildLlm', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('builds an OpenAI-compatible model in gateway mode with an injected token', () => {
    const model = buildLlm(gw, { accessToken: 'tok-123' });
    expect(model).toBeDefined();
    expect(model.provider).toContain('openai');
  });

  it('throws in gateway mode when accessToken is missing', () => {
    expect(() => buildLlm(gw)).toThrow(/accessToken/);
  });

  it('throws in gateway mode when llmGatewayUrl is missing', () => {
    expect(() => buildLlm({ llmProvider: 'gateway', llmModel: 'gpt-4.1' }, { accessToken: 't' })).toThrow(
      /LLM_GATEWAY_URL/,
    );
  });

  it('builds an Anthropic model when provider=anthropic (direct, no token)', () => {
    const model = buildLlm({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-6' });
    expect(model.provider).toContain('anthropic');
  });
});
