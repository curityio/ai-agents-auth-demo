import { describe, it, expect, vi } from 'vitest';
import { runRemediation, fallbackSummary, type RemediationDeps } from '../src/executor.js';
import type { StepUpSink } from '../src/mcp-ops-client.js';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';

describe('fallbackSummary', () => {
  it('surfaces a tool denial (e.g. set_deployment_image requires sre) over silence', () => {
    const summary = fallbackSummary([
      { toolCalls: [{ name: 'get_deployment', args: {} }], toolResults: [{ name: 'get_deployment', result: { ok: true } }] },
      {
        toolCalls: [{ name: 'set_deployment_image', args: {} }],
        toolResults: [
          { name: 'set_deployment_image', result: { error: 'forbidden', message: 'updating a deployment image requires one of these roles: sre; you have: oncall' } },
        ],
      },
    ]);
    expect(summary).toMatch(/set_deployment_image/);
    expect(summary).toMatch(/sre/);
  });

  it('reports inspection-only when no tool errored', () => {
    const summary = fallbackSummary([
      { toolCalls: [{ name: 'get_deployment', args: {} }], toolResults: [{ name: 'get_deployment', result: { ok: true } }] },
    ]);
    expect(summary).toMatch(/get_deployment/);
    expect(summary).toMatch(/did not complete/i);
  });

  it('never returns empty for an empty step list', () => {
    expect(fallbackSummary([]).length).toBeGreaterThan(0);
  });
});
import { StepUpRequiredError } from '@ai-agents-demo/a2a-helpers';

function makeStepUp(): StepUpRequiredError {
  return new StepUpRequiredError({
    acrValues: 'mfa',
    resourceMetadata: 'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
    scope: 'ops:write',
  });
}

const cfg = {
  requiredAcr: 'mfa',
  // Both MCP URLs are the agentgateway, as in production — the fixture used to
  // carry the pre-gateway direct-to-mcp-ops URL, which is why deriving the
  // RFC 9728 origin from `mcpOpsUrl` looked fine in tests and 404'd in the cluster.
  mcpOpsUrl: 'http://agentgateway.mcp.svc.cluster.local:8080/ops/mcp',
  mcpObservabilityUrl: 'http://agentgateway.mcp.svc.cluster.local:8080/observability/mcp',
  mcpOpsResourceMetadataUrl: 'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
  mcpOpsMetadataUrl: 'http://mcp-ops.mcp.svc.cluster.local:8080/.well-known/oauth-protected-resource',
  mcpOpsScope: 'ops:write',
  llmProvider: 'gateway',
  llmModel: 'gpt-4.1',
  llmGatewayUrl: 'http://gw:8080/llm',
  llmGatewayAudience: 'llm-gateway',
  llmGatewayScope: 'llm:invoke',
} as never;

function deps(over: Partial<RemediationDeps> = {}): RemediationDeps {
  return {
    obtainOpsToken: vi.fn().mockResolvedValue('ops-token'),
    obtainObsToken: vi.fn().mockResolvedValue('obs-token'),
    obtainLlmToken: vi.fn().mockResolvedValue('test-llm-token'),
    openMcpToolset: vi.fn().mockResolvedValue({ tools: {}, close: vi.fn() }),
    runLlm: vi.fn().mockResolvedValue({ text: 'done: restarted api-gateway', steps: [] }),
    fetchResourceMetadata: vi
      .fn()
      .mockResolvedValue({ scopes_supported: ['ops:write'], acr_values_supported: ['mfa'] }),
    buildStepUpInterceptingFetch: vi.fn(() => fetch),
    ...over,
  };
}

/**
 * Wire a fake interceptor factory that hands the sink back to the test, so a
 * `runLlm` stub can record a challenge into it the way the real fetch wrapper
 * does mid-loop. Returns a getter because the sink only exists once
 * `runRemediation` has allocated it.
 */
function withSinkCapture(over: Partial<RemediationDeps> = {}) {
  let captured: StepUpSink | undefined;
  const d = deps({
    buildStepUpInterceptingFetch: vi.fn((_scope: string, sink?: StepUpSink) => {
      captured = sink;
      return fetch;
    }),
    ...over,
  });
  return { deps: d, sink: () => captured as StepUpSink };
}

describe('runRemediation', () => {
  it('challenges step-up BEFORE the LLM when acr != required', async () => {
    const d = deps();
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'pwd' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    expect(d.runLlm).not.toHaveBeenCalled();
    expect(d.openMcpToolset).not.toHaveBeenCalled();
  });

  it('logs a DENY block naming the missing acr when it challenges before the LLM', async () => {
    // The acr pre-check never reaches packages/auth-curity, so this refusal is
    // the specialist's own and would otherwise leave no trace in `kubectl logs`
    // at all — the request would simply stop mid-chain.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'pwd' } } as never,
      deps: deps(),
    });
    const line = spy.mock.calls.map((c) => c[0]).join('\n');
    expect(line).toContain('INFO [agent-specialist] DENY');
    expect(line).toContain('step-up required');
    expect(line).toContain('alice');
    expect(line).toContain('pwd');
    expect(line).toContain('mfa');
  });

  it('logs a DENY block when the challenge arrives mid-flight via the sink', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps: d, sink } = withSinkCapture({
      runLlm: vi.fn(async () => {
        sink().err = makeStepUp();
        return { text: 'I was unable to restart api-gateway.', steps: [] };
      }),
    });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    expect(spy.mock.calls.map((c) => c[0]).join('\n')).toContain(
      'INFO [agent-specialist] DENY',
    );
  });

  it('logs no DENY block on a successful remediation', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: deps(),
    });
    expect(out.kind).toBe('ok');
    expect(spy.mock.calls.map((c) => c[0]).join('\n')).not.toContain('DENY');
  });

  it('opens both toolsets and runs the LLM when acr=mfa', async () => {
    const steps = [{ toolCalls: [{ name: 'get_deployment', args: { name: 'api-gateway' } }] }];
    const d = deps({
      runLlm: vi.fn().mockResolvedValue({ text: 'done: restarted api-gateway', steps }),
    });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('ok');
    expect(d.openMcpToolset).toHaveBeenCalledTimes(2);
    expect(d.runLlm).toHaveBeenCalledOnce();
    if (out.kind === 'ok') {
      expect(out.summary).toContain('restarted');
      // The LLM tool-calling steps are surfaced for the web UI's Trace tab.
      expect(out.steps).toEqual(steps);
    }
  });

  it('routes an invalid_scope on the write-token exchange to step-up (no LLM, no toolset)', async () => {
    const d = deps({
      obtainOpsToken: vi.fn().mockRejectedValue(new CurityAuthError('needs mfa', 'invalid_scope')),
    });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    expect(d.runLlm).not.toHaveBeenCalled();
    expect(d.openMcpToolset).not.toHaveBeenCalled();
  });

  it('fetches RFC 9728 metadata from mcp-ops itself, not from the agentgateway origin', async () => {
    // `mcpOpsUrl` points at the gateway (it is the MCP front door), and the
    // gateway serves no /.well-known/oauth-protected-resource — deriving the
    // metadata origin from it 404s and silently drops us onto hardcoded
    // defaults. The document lives on mcp-ops, so that is what must be fetched.
    const gatewayCfg = {
      ...(cfg as object),
      mcpOpsUrl: 'http://agentgateway.mcp.svc.cluster.local:8080/ops/mcp',
      mcpOpsMetadataUrl: 'http://mcp-ops.mcp.svc.cluster.local/.well-known/oauth-protected-resource',
    } as never;
    const d = deps({
      obtainOpsToken: vi.fn().mockRejectedValue(new CurityAuthError('needs mfa', 'invalid_scope')),
    });
    const out = await runRemediation({
      cfg: gatewayCfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    expect(d.fetchResourceMetadata).toHaveBeenCalledWith(
      'http://mcp-ops.mcp.svc.cluster.local/.well-known/oauth-protected-resource',
    );
  });

  it('maps a generic CurityAuthError on the write-token exchange to an error result', async () => {
    const d = deps({
      obtainOpsToken: vi
        .fn()
        .mockRejectedValue(new CurityAuthError('bob lacks sre', 'access_denied')),
    });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'bob', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error).toBe('access_denied');
    expect(d.runLlm).not.toHaveBeenCalled();
    expect(d.openMcpToolset).not.toHaveBeenCalled();
  });

  it('returns step-up and STILL closes both toolsets when a challenge is recorded', async () => {
    // Both MCP transports must be released even on the step-up exit, or a user
    // who re-authenticates and retries leaks a connection per attempt.
    const readClose = vi.fn();
    const writeClose = vi.fn();
    const openMcpToolset = vi
      .fn()
      .mockResolvedValueOnce({ tools: {}, close: readClose })
      .mockResolvedValueOnce({ tools: {}, close: writeClose });
    const { deps: d, sink } = withSinkCapture({ openMcpToolset });
    (d.runLlm as unknown as { mockImplementation: (f: () => Promise<unknown>) => void }).mockImplementation(
      async () => {
        sink().err = makeStepUp();
        return { text: 'could not restart', steps: [] };
      },
    );
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    expect(readClose).toHaveBeenCalledOnce();
    expect(writeClose).toHaveBeenCalledOnce();
  });

  it('returns step-up when the fetch wrapper recorded a challenge but runLlm resolved normally', async () => {
    // This is the ai@5+ reality and the reason the sink exists. A throw from
    // inside a tool's `execute` is NOT propagated: the SDK turns it into a
    // `tool-error` content part and the tool loop continues, so generateText
    // RESOLVES — with prose the model invented about why it failed. If the
    // step-up did not travel out-of-band, the browser would receive that prose
    // as a normal answer and the user would never be prompted for MFA.
    const { deps: d, sink } = withSinkCapture({
      runLlm: vi.fn(async () => {
        sink().err = makeStepUp(); // what the intercepting fetch does mid-loop
        return { text: 'I was unable to restart api-gateway.', steps: [] };
      }),
    });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    // The challenge that reaches the browser must be the one the resource server
    // actually sent, not a default — it is what drives the re-auth acr_values.
    if (out.kind === 'step-up') {
      expect(out.payload.data.acrValues).toBe('mfa');
      expect(out.payload.data.scope).toBe('ops:write');
    }
  });

  it('prefers a recorded step-up over specialist_failure when runLlm also throws', async () => {
    // A challenge recorded mid-loop must win over an unrelated later failure —
    // otherwise a transport error after the 401 downgrades a real MFA challenge
    // into a generic error and the user sees a dead end instead of a prompt.
    const { deps: d, sink } = withSinkCapture({
      runLlm: vi.fn(async () => {
        sink().err = makeStepUp();
        throw new Error('connection reset');
      }),
    });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
  });

  it('hands runLlm a live stopEarly predicate so the loop halts on the first challenge', async () => {
    // Without this the model keeps retrying into the same 401 until the step
    // limit, burning privileged calls and delaying the challenge.
    let stopEarly: (() => boolean) | undefined;
    const { deps: d, sink } = withSinkCapture({
      runLlm: vi.fn(async (o: { stopEarly?: () => boolean }) => {
        stopEarly = o.stopEarly;
        return { text: 'ok', steps: [] };
      }),
    });
    await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(stopEarly).toBeDefined();
    expect(stopEarly!()).toBe(false);
    sink().err = makeStepUp();
    expect(stopEarly!()).toBe(true);
  });

  it('wraps the write toolset fetch with the interceptor and leaves the read toolset bare', async () => {
    // Reads are unprivileged and never step-up; wrapping them would be noise.
    // Getting this backwards is invisible until a real 401 arrives.
    const d = deps();
    await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(d.buildStepUpInterceptingFetch).toHaveBeenCalledWith('ops:write', expect.any(Object));
    const calls = (
      d.openMcpToolset as unknown as {
        mock: { calls: Array<[{ fetchImpl?: unknown; label: string }]> };
      }
    ).mock.calls;
    expect(calls).toHaveLength(2);
    const [read, write] = calls.map((c) => c[0]);
    expect(read!.label).toBe('mcp-observability');
    expect(read!.fetchImpl).toBeUndefined();
    expect(write!.label).toBe('mcp-ops');
    expect(write!.fetchImpl).toBeDefined();
  });

  it('maps a non-step-up rejection from runLlm to a specialist_failure', async () => {
    const d = deps({ runLlm: vi.fn().mockRejectedValue(new Error('mcp-ops 500')) });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error).toBe('specialist_failure');
  });

  it('closes the already-open read toolset when opening the write toolset fails', async () => {
    const readClose = vi.fn();
    const openMcpToolset = vi
      .fn()
      .mockResolvedValueOnce({ tools: {}, close: readClose })
      .mockRejectedValueOnce(new Error('mcp-ops unreachable'));
    const d = deps({ openMcpToolset });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('error');
    expect(readClose).toHaveBeenCalledOnce();
    expect(d.runLlm).not.toHaveBeenCalled();
  });

  it('routes an invalid_scope on the obs path (acr=mfa, ops token ok) to step-up', async () => {
    const d = deps({
      obtainObsToken: vi
        .fn()
        .mockRejectedValue(new CurityAuthError('obs scope', 'invalid_scope')),
    });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    expect(d.runLlm).not.toHaveBeenCalled();
  });

  it('short-circuits an empty goal to bad_request before any exchange', async () => {
    const d = deps();
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: '   ',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.error).toBe('bad_request');
    expect(d.obtainOpsToken).not.toHaveBeenCalled();
    expect(d.openMcpToolset).not.toHaveBeenCalled();
    expect(d.runLlm).not.toHaveBeenCalled();
  });
});
