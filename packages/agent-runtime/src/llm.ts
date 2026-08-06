import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * A constructed model instance.
 *
 * The SDK's `LanguageModel` is a union that also admits a bare model-id string
 * (resolved through its own gateway), which we never use — every model here is
 * built explicitly against an audience-scoped endpoint. Excluding the string form
 * keeps `.provider` reachable on the result.
 *
 * Deliberately NOT the versioned spec type (`LanguageModelV1`/`V3`/…): pinning to
 * a spec version is what turned the 4→7 upgrade into a source change in this file.
 */
export type AgentLanguageModel = Exclude<LanguageModel, string>;

export interface LlmConfig {
  llmProvider: 'gateway' | 'anthropic' | 'ollama';
  llmModel: string;
  /** Base URL of the agentgateway LLM route. Only used when llmProvider === 'gateway'. */
  llmGatewayUrl?: string;
}

export interface BuildLlmOptions {
  /** Per-request aud=llm-gateway bearer. Required in gateway mode. */
  accessToken?: string;
  /** Override the HTTP client. Tests use this to assert the outbound request. */
  fetchImpl?: typeof fetch;
}

export function buildLlm(cfg: LlmConfig, opts: BuildLlmOptions = {}): AgentLanguageModel {
  if (cfg.llmProvider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
    return createAnthropic({ apiKey, ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}) })(
      cfg.llmModel,
    );
  }

  if (cfg.llmProvider === 'gateway') {
    if (!cfg.llmGatewayUrl) throw new Error('LLM_GATEWAY_URL is required when LLM_PROVIDER=gateway');
    if (!opts.accessToken)
      throw new Error('buildLlm gateway mode requires a per-request accessToken (aud=llm-gateway)');
    // `@ai-sdk/openai-compatible`, NOT `@ai-sdk/openai`: agentgateway's /llm route
    // is an OpenAI-COMPATIBLE proxy in front of Azure, and it implements Chat
    // Completions only. Since ai@5 the plain OpenAI provider defaults to the
    // Responses API, so `createOpenAI(...)(model)` POSTs `${baseURL}/responses`
    // and the hop breaks — along with the gateway's gen_ai.usage.* accounting,
    // which is the only place LLM token usage is recorded. This provider has no
    // Responses implementation to drift onto. Pinned by llm.test.ts.
    //
    // The apiKey is sent as `Authorization: Bearer`: we pass the exchanged
    // aud=llm-gateway JWT, which the gateway validates (requiring `llm:invoke`)
    // before swapping in the real Azure api-key upstream.
    return createOpenAICompatible({
      name: 'agentgateway',
      baseURL: cfg.llmGatewayUrl,
      apiKey: opts.accessToken,
      ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
    })(cfg.llmModel);
  }

  throw new Error('Ollama provider not yet wired. Set LLM_PROVIDER=gateway|anthropic.');
}
