import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildLlm, type LlmConfig } from './llm.js';

const base: LlmConfig = {
  llmProvider: 'azure',
  llmModel: 'gpt-4.1',
  azureEndpoint: 'https://example.openai.azure.com',
  azureApiVersion: '2024-04-01-preview',
};

describe('buildLlm', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.AZURE_OPENAI_API_KEY = 'test-key';
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('builds an Azure model when provider=azure', () => {
    const model = buildLlm(base);
    expect(model).toBeDefined();
    expect(model.provider).toContain('azure');
  });

  it('throws when azure endpoint is missing', () => {
    expect(() => buildLlm({ ...base, azureEndpoint: undefined })).toThrow(
      /AZURE_OPENAI_ENDPOINT/,
    );
  });

  it('builds an Anthropic model when provider=anthropic', () => {
    const model = buildLlm({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-6' });
    expect(model.provider).toContain('anthropic');
  });
});
