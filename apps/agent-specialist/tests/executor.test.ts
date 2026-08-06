import { describe, it, expect, vi } from 'vitest';
import { ToolExecutionError } from 'ai';
import { runRemediation, fallbackSummary, type RemediationDeps } from '../src/executor.js';
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
    ...over,
  };
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

  it('returns step-up and STILL closes both toolsets when runLlm throws StepUpRequiredError', async () => {
    const readClose = vi.fn();
    const writeClose = vi.fn();
    const openMcpToolset = vi
      .fn()
      .mockResolvedValueOnce({ tools: {}, close: readClose })
      .mockResolvedValueOnce({ tools: {}, close: writeClose });
    const d = deps({
      openMcpToolset,
      runLlm: vi.fn().mockRejectedValue(makeStepUp()),
    });
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

  it('returns step-up when runLlm throws a ToolExecutionError wrapping a StepUpRequiredError (real ai@4 wrapping)', async () => {
    // generateText in ai@4.x does NOT re-throw a bare StepUpRequiredError from a
    // tool's execute — it wraps it in a ToolExecutionError with the original on
    // `.cause`. This pins the unwrap so a mid-flight step-up isn't misclassified.
    const wrapped = new ToolExecutionError({
      toolName: 'set_deployment_image',
      toolArgs: { deployment: 'api-gateway' },
      toolCallId: 'call_1',
      cause: makeStepUp(),
    });
    const d = deps({ runLlm: vi.fn().mockRejectedValue(wrapped) });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
  });

  it('returns step-up when the StepUpRequiredError is nested two causes deep', async () => {
    // The SDK can wrap more than once; the cause-walk must descend the chain.
    const inner = new ToolExecutionError({
      toolName: 'set_deployment_image',
      toolArgs: {},
      toolCallId: 'call_1',
      cause: makeStepUp(),
    });
    const outerWrap = new Error('downstream call failed');
    (outerWrap as { cause?: unknown }).cause = inner;
    const d = deps({ runLlm: vi.fn().mockRejectedValue(outerWrap) });
    const out = await runRemediation({
      cfg,
      bearer: 'b',
      goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
  });

  it('maps a ToolExecutionError with a non-step-up cause to a specialist_failure', async () => {
    const wrapped = new ToolExecutionError({
      toolName: 'set_deployment_image',
      toolArgs: {},
      toolCallId: 'call_1',
      cause: new Error('mcp-ops 500'),
    });
    const d = deps({ runLlm: vi.fn().mockRejectedValue(wrapped) });
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
