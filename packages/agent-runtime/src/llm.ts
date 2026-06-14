import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import type { LanguageModelV1 } from 'ai';

export interface LlmConfig {
  llmProvider: 'anthropic' | 'azure' | 'ollama';
  llmModel: string;
  /** Only used when llmProvider === 'azure'. */
  azureEndpoint?: string;
  /** Only used when llmProvider === 'azure'. */
  azureApiVersion?: string;
}

export function buildLlm(cfg: LlmConfig): LanguageModelV1 {
  if (cfg.llmProvider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
    return createAnthropic({ apiKey })(cfg.llmModel);
  }

  if (cfg.llmProvider === 'azure') {
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is required when LLM_PROVIDER=azure');
    if (!cfg.azureEndpoint) throw new Error('AZURE_OPENAI_ENDPOINT is required when LLM_PROVIDER=azure');

    const baseURL = `${cfg.azureEndpoint.replace(/\/+$/, '')}/openai/deployments`;
    const azure = createAzure({
      apiKey,
      baseURL,
      apiVersion: cfg.azureApiVersion,
    });
    return azure(cfg.llmModel);
  }

  throw new Error('Ollama provider not yet wired. Set LLM_PROVIDER=anthropic|azure.');
}
