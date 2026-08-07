import { describe, it, expect } from 'vitest';
import { generateText, isStepCount, tool } from 'ai';
import { z } from 'zod';
import { buildLlm } from './llm.js';

/**
 * Characterization tests for the ONE SDK behaviour the specialist's step-up
 * handling depends on. These assert what `ai` itself does, not what our code
 * does, and they exist because that behaviour changed silently between majors.
 *
 * Up to ai@4 a throw from inside a tool's `execute` was wrapped in a
 * `ToolExecutionError` and re-thrown, so `agent-specialist` could catch a
 * mid-flight RFC 9470 challenge from the tool-call path. In ai@5+ the SDK
 * swallows it into a `tool-error` content part and keeps looping — which is why
 * the challenge now has to travel out-of-band through a sink
 * (`apps/agent-specialist/src/mcp-ops-client.ts` `StepUpSink`).
 *
 * If a future upgrade restores propagation, THESE tests fail — which is the
 * signal to reconsider the sink. Without them, that change would be invisible.
 */

/** One OpenAI chat-completions response asking for a single tool call. */
function toolCallResponse(name: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-1',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name, arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** A final assistant turn with prose and no further tool calls. */
function textResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-2',
      object: 'chat.completion',
      created: 0,
      model: 'gpt-4.1',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Serve a fixed script of responses, one per outbound request. */
function scriptedFetch(responses: Response[]): typeof fetch {
  let i = 0;
  return async () => responses[i++] ?? textResponse('done');
}

const cfg = {
  llmProvider: 'gateway' as const,
  llmModel: 'gpt-4.1',
  llmGatewayUrl: 'http://gw:8080/llm',
};

class Boom extends Error {
  constructor() {
    super('step-up required');
    this.name = 'Boom';
  }
}

describe('ai@7 tool-execution error semantics', () => {
  it('RESOLVES instead of rejecting when a tool execute() throws', async () => {
    const model = buildLlm(cfg, {
      accessToken: 't',
      fetchImpl: scriptedFetch([
        toolCallResponse('explode'),
        textResponse('I could not complete that.'),
      ]),
    });

    const result = await generateText({
      model,
      prompt: 'go',
      stopWhen: isStepCount(2),
      tools: {
        explode: tool({
          description: 'always throws',
          inputSchema: z.object({}),
          execute: async () => {
            throw new Boom();
          },
        }),
      },
    });

    // The throw did NOT surface here. This is the whole reason the sink exists:
    // a step-up challenge raised inside a tool would otherwise be lost, and the
    // caller would report success with the model's invented explanation.
    expect(result.text).toBe('I could not complete that.');
  });

  it('records the thrown error as a tool-error content part rather than propagating it', async () => {
    const model = buildLlm(cfg, {
      accessToken: 't',
      fetchImpl: scriptedFetch([toolCallResponse('explode'), textResponse('done')]),
    });

    const result = await generateText({
      model,
      prompt: 'go',
      stopWhen: isStepCount(2),
      tools: {
        explode: tool({
          description: 'always throws',
          inputSchema: z.object({}),
          execute: async () => {
            throw new Boom();
          },
        }),
      },
    });

    const toolErrors = result.steps.flatMap((s) =>
      s.content.filter((p: { type: string }) => p.type === 'tool-error'),
    );
    expect(toolErrors).toHaveLength(1);
  });
});
