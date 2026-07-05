import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';

export interface LlmConfig {
  llmProvider: 'gateway' | 'anthropic' | 'ollama';
  llmModel: string;
  /** Base URL of the agentgateway LLM route. Only used when llmProvider === 'gateway'. */
  llmGatewayUrl?: string;
}

export interface BuildLlmOptions {
  /** Per-request aud=llm-gateway bearer. Required in gateway mode. */
  accessToken?: string;
}

export function buildLlm(cfg: LlmConfig, opts: BuildLlmOptions = {}): LanguageModelV1 {
  if (cfg.llmProvider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
    return createAnthropic({ apiKey })(cfg.llmModel);
  }

  if (cfg.llmProvider === 'gateway') {
    if (!cfg.llmGatewayUrl) throw new Error('LLM_GATEWAY_URL is required when LLM_PROVIDER=gateway');
    if (!opts.accessToken)
      throw new Error('buildLlm gateway mode requires a per-request accessToken (aud=llm-gateway)');
    // The AI SDK OpenAI provider POSTs to `${baseURL}/chat/completions` and sends the
    // apiKey as `Authorization: Bearer`. We pass the exchanged aud=llm-gateway JWT as
    // that bearer; the gateway validates it and swaps in the Azure api-key upstream.
    const openai = createOpenAI({ baseURL: cfg.llmGatewayUrl, apiKey: opts.accessToken });
    return openai(cfg.llmModel);
  }

  throw new Error('Ollama provider not yet wired. Set LLM_PROVIDER=gateway|anthropic.');
}
