import { v4 as uuid } from 'uuid';
import { generateText, isStepCount, type ToolSet } from 'ai';
import type { AgentExecutor, ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import type { Message, Task, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import { bearerFromContext, StepUpRequiredError } from '@ai-agents-demo/a2a-helpers';
import {
  CurityAuthError,
  verifyJwt,
  decorateSpanWithIdentity,
  oboLog,
  summarizeJwt,
  type VerifiedJwt,
} from '@ai-agents-demo/auth-curity';
import { buildLlm, openMcpToolset } from '@ai-agents-demo/agent-runtime';
import {
  obtainOpsToken,
  fetchResourceMetadata,
  buildStepUpInterceptingFetch,
  type StepUpSink,
} from './mcp-ops-client.js';
import { obtainObsToken } from './obs-token.js';
import { obtainLlmToken } from './llm-token.js';
import { SPECIALIST_SYSTEM_PROMPT } from './system-prompt.js';
import type { Config } from './config.js';

// ---- testable orchestration core ----

/**
 * One serialized turn of the specialist's LLM tool-calling loop, shaped to match
 * what the copilot's observe path emits (so the web UI's Trace tab renders both
 * paths uniformly). Surfaced through the A2A response so the privileged run's
 * tool calls (get_deployment → restart/set-image/scale → verify) are visible.
 */
export interface RemediationStep {
  toolCalls?: Array<{ name: string; args: unknown }>;
  toolResults?: Array<{ name: string; result: unknown }>;
  finishReason?: string;
}

/**
 * Build a summary when the LLM ends its tool loop with no prose (e.g. it hit the
 * step limit, or stopped on a tool error). Prefer surfacing a tool error the model
 * saw — a gateway/mcp-ops denial like "requires the sre role" — so a blocked action
 * is legible instead of an empty "no summary" answer.
 */
export function fallbackSummary(steps: RemediationStep[]): string {
  const results = steps.flatMap((s) => s.toolResults ?? []);
  for (const r of results) {
    const text = typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
    if (/error|forbidden|denied|not allowed|requires|unauthor/i.test(text)) {
      return `The requested change could not be completed. \`${r.name}\` reported: ${text.slice(0, 400)}`;
    }
  }
  const tools = [...new Set(steps.flatMap((s) => (s.toolCalls ?? []).map((c) => c.name)))];
  if (tools.length) {
    return (
      `I inspected the deployment (called: ${tools.join(', ')}) but did not complete the ` +
      `requested change — no authorized action was available to fulfil the goal.`
    );
  }
  return 'No action was taken and no summary was produced.';
}

export interface RemediationDeps {
  obtainOpsToken: (o: { cfg: Config; subjectToken: string; subjectSub: string }) => Promise<string>;
  obtainObsToken: (o: { cfg: Config; subjectToken: string }) => Promise<string>;
  obtainLlmToken: (o: {
    cfg: Config;
    subjectToken: string;
    subjectSub: string;
    subjectAcr: string;
  }) => Promise<string>;
  openMcpToolset: typeof openMcpToolset;
  runLlm: (o: {
    system: string;
    goal: string;
    tools: ToolSet;
    accessToken: string;
    /**
     * Extra halt condition for the tool loop, on top of the step limit. Named
     * `stopEarly` rather than `stopWhen` so this dep stays free of the SDK's
     * `Arrayable<StopCondition>` type — the real implementation adapts it.
     */
    stopEarly?: () => boolean;
  }) => Promise<{ text: string; steps: RemediationStep[] }>;
  fetchResourceMetadata: typeof fetchResourceMetadata;
  buildStepUpInterceptingFetch: typeof buildStepUpInterceptingFetch;
}

export type RemediationResult =
  | { kind: 'ok'; summary: string; steps: RemediationStep[] }
  | { kind: 'step-up'; payload: ReturnType<StepUpRequiredError['toPayload']> }
  | { kind: 'error'; error: string; description: string };

export async function runRemediation(args: {
  cfg: Config;
  bearer: string;
  goal: string;
  verified: VerifiedJwt;
  deps: RemediationDeps;
}): Promise<RemediationResult> {
  const { cfg, bearer, goal, verified, deps } = args;
  const sub = String(verified.payload.sub ?? 'unknown');

  // 0. Guard empty goal BEFORE any token exchange / MCP connection / LLM call.
  if (goal.trim() === '') {
    return { kind: 'error', error: 'bad_request', description: 'empty request' };
  }

  // 1. Acquire the WRITE token (role gate / scope gate fire here).
  let opsToken: string;
  try {
    opsToken = await deps.obtainOpsToken({ cfg, subjectToken: bearer, subjectSub: sub });
  } catch (e) {
    if (e instanceof CurityAuthError && e.code === 'invalid_scope') {
      return stepUpFromMetadata(cfg, deps);
    }
    if (e instanceof CurityAuthError) return { kind: 'error', error: e.code, description: e.message };
    return { kind: 'error', error: 'specialist_failure', description: String(e) };
  }

  // 2. Deterministic acr pre-check — challenge BEFORE the LLM runs.
  const acr = String(verified.payload.acr ?? '');
  if (acr !== cfg.requiredAcr) {
    return stepUpFromMetadata(cfg, deps);
  }

  // 3. Acquire the READ token (no MFA needed) and open BOTH toolsets.
  // Both toolsets are opened INSIDE the try so a partial-open failure (e.g. the
  // second/privileged toolset rejects after the first connected) still closes
  // whatever was opened, and any thrown CurityAuthError / connection failure is
  // turned into a RemediationResult rather than escaping runRemediation.
  let readSet: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  let writeSet: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  // Carries a mid-flight RFC 9470 challenge out of the LLM tool loop. See
  // StepUpSink — since ai@5 a throw from inside a tool's `execute` does not
  // propagate, so this is the only path by which the challenge escapes.
  const stepUpSink: StepUpSink = {};
  try {
    const obsToken = await deps.obtainObsToken({ cfg, subjectToken: bearer });
    readSet = await deps.openMcpToolset({
      url: cfg.mcpObservabilityUrl,
      bearerToken: obsToken,
      clientName: 'agent-specialist',
      label: 'mcp-observability',
    });
    writeSet = await deps.openMcpToolset({
      url: cfg.mcpOpsUrl,
      bearerToken: opsToken,
      clientName: 'agent-specialist',
      label: 'mcp-ops',
      fetchImpl: deps.buildStepUpInterceptingFetch(cfg.mcpOpsScope, stepUpSink),
    });
  } catch (e) {
    await readSet?.close();
    await writeSet?.close();
    if (e instanceof CurityAuthError && e.code === 'invalid_scope') {
      return stepUpFromMetadata(cfg, deps);
    }
    if (e instanceof CurityAuthError) return { kind: 'error', error: e.code, description: e.message };
    return { kind: 'error', error: 'specialist_failure', description: String(e) };
  }

  try {
    const tools: ToolSet = { ...readSet.tools, ...writeSet.tools };
    const llmToken = await deps.obtainLlmToken({ cfg, subjectToken: bearer, subjectSub: sub, subjectAcr: acr });
    const { text, steps } = await deps.runLlm({
      system: SPECIALIST_SYSTEM_PROMPT,
      goal,
      tools,
      accessToken: llmToken,
      // Halt the loop the moment a challenge is recorded, instead of letting the
      // model retry into the same 401 until it hits the step limit.
      stopEarly: () => stepUpSink.err !== undefined,
    });
    // Checked BEFORE reporting success: the SDK resolves normally after
    // swallowing the tool's throw, so `text` here is the model's invented account
    // of the failure. A recorded challenge must win over it.
    if (stepUpSink.err) return { kind: 'step-up', payload: stepUpSink.err.toPayload() };
    return { kind: 'ok', summary: text, steps };
  } catch (e) {
    // Also checked on the failure path: an unrelated error after the 401 must not
    // downgrade a genuine MFA challenge into a generic specialist_failure.
    if (stepUpSink.err) return { kind: 'step-up', payload: stepUpSink.err.toPayload() };
    return { kind: 'error', error: 'specialist_failure', description: String(e) };
  } finally {
    await readSet?.close();
    await writeSet?.close();
  }
}

async function stepUpFromMetadata(cfg: Config, deps: RemediationDeps): Promise<RemediationResult> {
  let acrValues = cfg.requiredAcr;
  let scope = cfg.mcpOpsScope;
  try {
    const md = await deps.fetchResourceMetadata(cfg.mcpOpsMetadataUrl);
    scope = md.scopes_supported?.[0] ?? scope;
    acrValues = md.acr_values_supported?.[0] ?? acrValues;
  } catch (e) {
    console.error('[agent-specialist] RFC 9728 metadata fetch failed, using defaults', e);
  }
  const err = new StepUpRequiredError({
    acrValues,
    resourceMetadata: cfg.mcpOpsResourceMetadataUrl,
    scope,
  });
  return { kind: 'step-up', payload: err.toPayload() };
}

// ---- A2A adapter (publishes RemediationResult onto the event bus) ----

function goalFromMessage(message: Message): string {
  return (message.parts ?? [])
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'data' && p.data ? JSON.stringify(p.data) : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

function publishFinalMessage(
  bus: ExecutionEventBus,
  contextId: string,
  taskId: string,
  obj: unknown,
): void {
  const msg: Message = {
    kind: 'message',
    messageId: uuid(),
    role: 'agent',
    contextId,
    taskId,
    parts: [{ kind: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }],
  };
  bus.publish(msg);
}

function publishStatus(
  bus: ExecutionEventBus,
  taskId: string,
  contextId: string,
  state: 'working' | 'completed' | 'failed',
  final: boolean,
  text?: string,
): void {
  const evt: TaskStatusUpdateEvent = {
    kind: 'status-update',
    taskId,
    contextId,
    final,
    status: {
      state,
      timestamp: new Date().toISOString(),
      message: text
        ? {
            kind: 'message',
            messageId: uuid(),
            role: 'agent',
            contextId,
            taskId,
            parts: [{ kind: 'text', text }],
          }
        : undefined,
    },
  };
  bus.publish(evt);
}

function publishWorkingTask(bus: ExecutionEventBus, ctx: RequestContext): Task {
  const task: Task = {
    kind: 'task',
    id: ctx.taskId,
    contextId: ctx.contextId,
    status: { state: 'working', timestamp: new Date().toISOString() },
    history: [ctx.userMessage],
  };
  bus.publish(task);
  return task;
}

export function buildExecutor(cfg: Config): AgentExecutor {
  const runLlm: RemediationDeps['runLlm'] = async ({
    system,
    goal,
    tools,
    accessToken,
    stopEarly,
  }) => {
    const llm = buildLlm(cfg, { accessToken });
    const result = await generateText({
      model: llm,
      instructions: system,
      messages: [{ role: 'user', content: goal }],
      tools,
      stopWhen: stopEarly ? [isStepCount(8), stopEarly] : [isStepCount(8)],
    });
    // Serialize the tool-calling loop the same way agent-copilot does, so the
    // web UI's Trace tab renders the privileged path's steps uniformly. The
    // `{name, args/result}` shape is OUR wire contract with the web UI, so it is
    // held stable here while the SDK's own field names (input/output) move.
    const steps: RemediationStep[] = result.steps.map((s) => {
      const calls = s.toolCalls as Array<{ toolName: string; input: unknown }> | undefined;
      const results = s.toolResults as Array<{ toolName: string; output: unknown }> | undefined;
      return {
        toolCalls: calls?.map((tc) => ({ name: tc.toolName, args: tc.input })),
        toolResults: results?.map((tr) => ({ name: tr.toolName, result: tr.output })),
        finishReason: s.finishReason,
      };
    });
    // The model sometimes ends on a tool step with no final text (step limit, or
    // it stopped after a denied tool call). Never return empty — synthesize an
    // honest summary from the steps so the UI shows what happened, not silence.
    const text = result.text?.trim() ? result.text : fallbackSummary(steps);
    return { text, steps };
  };
  const deps: RemediationDeps = {
    obtainOpsToken,
    obtainObsToken,
    obtainLlmToken,
    openMcpToolset,
    runLlm,
    fetchResourceMetadata,
    buildStepUpInterceptingFetch,
  };

  return {
    async execute(reqCtx: RequestContext, bus: ExecutionEventBus): Promise<void> {
      const bearer = bearerFromContext(reqCtx.context);
      if (!bearer) {
        publishWorkingTask(bus, reqCtx);
        publishStatus(bus, reqCtx.taskId, reqCtx.contextId, 'failed', true, 'unauthenticated');
        bus.finished();
        return;
      }
      let verified: VerifiedJwt;
      try {
        verified = await verifyJwt(bearer, {
          issuer: cfg.curityIssuer,
          audience: cfg.expectedAudience,
          jwksUri: cfg.curityJwksUri,
        });
        decorateSpanWithIdentity(verified);
      } catch (e) {
        publishWorkingTask(bus, reqCtx);
        publishStatus(
          bus,
          reqCtx.taskId,
          reqCtx.contextId,
          'failed',
          true,
          e instanceof CurityAuthError ? `${e.code}: ${e.message}` : String(e),
        );
        bus.finished();
        return;
      }

      const goal = goalFromMessage(reqCtx.userMessage);
      publishWorkingTask(bus, reqCtx);
      oboLog({
        service: 'agent-specialist',
        kind: 'RECEIVE',
        headline: 'A2A task (LLM remediation)',
        fields: {
          user: String(verified.payload.sub ?? 'unknown'),
          scope: [...verified.scopes].join(' '),
          'inbound act': summarizeJwt(bearer).act,
          goal,
        },
      });

      // runRemediation is total (never throws for expected failures), but wrap
      // it defensively so no future throw can leave the task hanging — the
      // a2a-js handler swallows thrown errors, so we MUST always reach
      // bus.finished() ourselves.
      try {
        const out = await runRemediation({ cfg, bearer, goal, verified, deps });
        if (out.kind === 'step-up') {
          publishFinalMessage(bus, reqCtx.contextId, reqCtx.taskId, out.payload);
          publishStatus(bus, reqCtx.taskId, reqCtx.contextId, 'failed', true);
        } else if (out.kind === 'error') {
          publishFinalMessage(bus, reqCtx.contextId, reqCtx.taskId, {
            error: out.error,
            error_description: out.description,
          });
          publishStatus(bus, reqCtx.taskId, reqCtx.contextId, 'failed', true);
        } else {
          publishFinalMessage(bus, reqCtx.contextId, reqCtx.taskId, {
            ok: true,
            summary: out.summary,
            steps: out.steps,
          });
          publishStatus(bus, reqCtx.taskId, reqCtx.contextId, 'completed', true);
        }
      } catch (e) {
        console.error('[agent-specialist] remediation threw', e);
        publishFinalMessage(bus, reqCtx.contextId, reqCtx.taskId, {
          error: 'specialist_failure',
          error_description: String(e),
        });
        publishStatus(bus, reqCtx.taskId, reqCtx.contextId, 'failed', true);
      } finally {
        bus.finished();
      }
    },

    async cancelTask(): Promise<void> {},
  };
}
