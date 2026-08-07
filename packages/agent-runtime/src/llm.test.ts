import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateText } from 'ai';
import { buildLlm, type LlmConfig } from './llm.js';

const gw: LlmConfig = {
  llmProvider: 'gateway',
  llmModel: 'gpt-4.1',
  llmGatewayUrl: 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
};

/** A minimal well-formed OpenAI chat-completions body, enough for generateText. */
function chatCompletion(): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4.1',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function recordingFetch() {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({ url, headers });
    return chatCompletion();
  };
  return { impl, seen };
}

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
  });

  // The regression this pins: since ai@5 the plain `@ai-sdk/openai` provider
  // defaults to the Responses API, so `openai(model)` would POST /llm/responses.
  // agentgateway's /llm route is chat-completions-shaped and is the only source
  // of gen_ai.usage.* accounting, so that drift breaks the LLM hop AND its
  // telemetry. Asserting on `model.provider` alone cannot see this — only the
  // request path can.
  it('gateway mode POSTs to the chat completions path under the gateway base URL', async () => {
    const { impl, seen } = recordingFetch();
    const model = buildLlm(gw, { accessToken: 'tok-123', fetchImpl: impl });
    await generateText({ model, prompt: 'hi' });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe('/llm/chat/completions');
  });

  // The exchanged aud=llm-gateway JWT must arrive as the bearer: that is what the
  // gateway validates and what it requires `llm:invoke` on before swapping in the
  // Azure api-key upstream. Sending the wrong header means a 401 at the gateway.
  it('sends the exchanged token as the Authorization bearer', async () => {
    const { impl, seen } = recordingFetch();
    const model = buildLlm(gw, { accessToken: 'tok-123', fetchImpl: impl });
    await generateText({ model, prompt: 'hi' });
    expect(seen[0].headers.authorization).toBe('Bearer tok-123');
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
