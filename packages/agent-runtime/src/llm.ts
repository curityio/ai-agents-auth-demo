import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * A constructed model instance.
 *
 * The SDK's `LanguageModel` is a union that also admits a bare model-id string
 * (resolved through its own gateway), which we never use — the model here is
 * built explicitly against an audience-scoped endpoint. Excluding the string form
 * keeps `.provider` reachable on the result.
 *
 * Deliberately NOT the versioned spec type (`LanguageModelV1`/`V3`/…): pinning to
 * a spec version is what turned the 4→7 upgrade into a source change in this file.
 */
export type AgentLanguageModel = Exclude<LanguageModel, string>;

/**
 * The model the agents put on the wire.
 *
 * agentgateway's provider block sets `model:`, which overrides whatever the
 * client requests, so agents have no model to configure. Chat Completions still
 * requires the field, so we send this.
 *
 * The value is deliberately self-describing rather than something plausible like
 * "default": if a provider fragment ever omits `model:`, this string reaches the
 * upstream vendor and the error reads `model 'model-pinned-at-gateway' not found`,
 * which diagnoses itself in one line.
 */
const GATEWAY_PINNED_MODEL = 'model-pinned-at-gateway';

export interface LlmConfig {
  /** Base URL of the agentgateway LLM route. */
  llmGatewayUrl: string;
}

export interface BuildLlmOptions {
  /** Per-request aud=llm-gateway bearer. Required. */
  accessToken?: string;
  /** Override the HTTP client. Tests use this to assert the outbound request. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the model the agents reason with.
 *
 * There is exactly one path: agentgateway's `/llm` route. Direct-to-vendor modes
 * used to exist and were removed on purpose — they bypassed the `llm:invoke`
 * scope check and put a static vendor key back in the agent's environment, which
 * is the property this demo exists to argue against. Which vendor sits upstream
 * is the gateway's business, configured in k8s/workloads/llm-providers/.
 */
export function buildLlm(cfg: LlmConfig, opts: BuildLlmOptions = {}): AgentLanguageModel {
  if (!cfg.llmGatewayUrl) throw new Error('LLM_GATEWAY_URL is required');
  if (!opts.accessToken)
    throw new Error('buildLlm requires a per-request accessToken (aud=llm-gateway)');

  // `@ai-sdk/openai-compatible`, NOT `@ai-sdk/openai`: agentgateway's /llm route
  // is an OpenAI-COMPATIBLE proxy, and it implements Chat Completions only. Since
  // ai@5 the plain OpenAI provider defaults to the Responses API, so
  // `createOpenAI(...)(model)` POSTs `${baseURL}/responses` and the hop breaks —
  // along with the gateway's gen_ai.usage.* accounting, which is the only place
  // LLM token usage is recorded. This provider has no Responses implementation to
  // drift onto. Pinned by llm.test.ts.
  //
  // The apiKey is sent as `Authorization: Bearer`: we pass the exchanged
  // aud=llm-gateway JWT, which the gateway validates (requiring `llm:invoke`)
  // before swapping in the real upstream provider key.
  return createOpenAICompatible({
    name: 'agentgateway',
    baseURL: cfg.llmGatewayUrl,
    apiKey: opts.accessToken,
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  })(GATEWAY_PINNED_MODEL);
}
