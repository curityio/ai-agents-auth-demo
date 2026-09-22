/**
 * Unit tests for listOpsTools — the "what can this identity see on the write
 * tier" probe behind GET /tools.
 *
 * The probe must reuse the SAME gates the real remediation runs through, in the
 * same order, so the card the presenter shows is truthful for every persona:
 *   acr pre-check (no token minted) → ops:write exchange (role gate) → tools/list.
 */
import { describe, it, expect, vi } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import { listOpsTools, toolInfos, type ToolsDeps } from '../src/tools-route.js';
import type { Config } from '../src/config.js';

const cfg = {
  mcpOpsUrl: 'http://gw/ops/mcp',
  mcpOpsScope: 'ops:write',
  requiredAcr: 'mfa',
} as unknown as Config;

function deps(overrides: Partial<ToolsDeps> = {}): ToolsDeps {
  return {
    obtainOpsToken: vi.fn(async () => 'OPS_TOKEN'),
    openMcpToolset: vi.fn(async () => ({
      tools: {},
      listed: [
        { name: 'restart_deployment', description: 'Restart a deployment' },
        { name: 'scale_deployment', description: 'Scale a deployment' },
      ],
      close: vi.fn(async () => {}),
    })) as unknown as ToolsDeps['openMcpToolset'],
    ...overrides,
  };
}

describe('listOpsTools', () => {
  it('reports step-up when the caller has not done MFA, WITHOUT minting a privileged token', async () => {
    const d = deps();
    const out = await listOpsTools({
      cfg,
      bearer: 'B',
      claims: { sub: 'alice', acr: 'html-form' },
      deps: d,
    });
    expect(out).toEqual({ status: 'step-up', acrValues: 'mfa', scope: 'ops:write' });
    expect(d.obtainOpsToken).not.toHaveBeenCalled();
  });

  it('reports a denial with Curity\'s error when the ops:write exchange is refused (role gate)', async () => {
    const d = deps({
      obtainOpsToken: vi.fn(async () => {
        throw new CurityAuthError('Role sre or oncall required', 'access_denied');
      }),
    });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'bob', acr: 'mfa' }, deps: d });
    expect(out).toEqual({
      status: 'denied',
      error: 'access_denied',
      description: 'Role sre or oncall required',
    });
  });

  it('lists the tool names the gateway returned, and closes the toolset', async () => {
    const close = vi.fn(async () => {});
    const d = deps({
      openMcpToolset: vi.fn(async () => ({
        tools: {},
        listed: [
          { name: 'restart_deployment', description: 'Restart a deployment' },
          { name: 'set_deployment_image', description: 'Set image', meta: { 'io.curity.demo/required-roles': ['sre'] } },
        ],
        close,
      })) as unknown as ToolsDeps['openMcpToolset'],
    });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'alice', acr: 'mfa', roles: ['sre', 'oncall'] }, deps: d });
    expect(out).toEqual({
      status: 'ok',
      tools: [
        { name: 'restart_deployment', description: 'Restart a deployment' },
        { name: 'set_deployment_image', description: 'Set image', requiredRoles: ['sre'], callable: true },
      ],
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(d.openMcpToolset).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://gw/ops/mcp', bearerToken: 'OPS_TOKEN' }),
    );
  });

  it('does NOT record the probe as the last ops exchange (keeps /last-token truthful about real flows)', async () => {
    const d = deps();
    await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'alice', acr: 'mfa' }, deps: d });
    expect(d.obtainOpsToken).toHaveBeenCalledWith(expect.objectContaining({ recordLastExchange: false }));
  });

  it('turns a toolset connection failure into an error status rather than throwing', async () => {
    const d = deps({
      openMcpToolset: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      }) as unknown as ToolsDeps['openMcpToolset'],
    });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'alice', acr: 'mfa' }, deps: d });
    expect(out).toEqual({
      status: 'error',
      error: 'mcp_unavailable',
      description: 'Error: connect ECONNREFUSED',
    });
  });

  it('marks a tool the gateway LISTS but mcp-ops will REFUSE for this caller (carol: oncall, set_deployment_image: sre)', async () => {
    // agentgateway couples tools/list visibility to its own MCP-layer authz, so
    // the sre split is deliberately enforced downstream and the tool stays
    // visible to carol. The card must say so, or "listed" reads as "allowed".
    const d = deps({
      openMcpToolset: vi.fn(async () => ({
        tools: {},
        listed: [
          { name: 'restart_deployment', description: 'Restart' },
          { name: 'set_deployment_image', description: 'Set image', meta: { 'io.curity.demo/required-roles': ['sre'] } },
        ],
        close: vi.fn(async () => {}),
      })) as unknown as ToolsDeps['openMcpToolset'],
    });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'carol', acr: 'mfa', roles: ['oncall'] }, deps: d });
    expect(out).toEqual({
      status: 'ok',
      tools: [
        { name: 'restart_deployment', description: 'Restart' },
        { name: 'set_deployment_image', description: 'Set image', requiredRoles: ['sre'], callable: false },
      ],
    });
  });
});

describe('toolInfos', () => {
  it('adds requiredRoles + callable only for tools that publish required roles', () => {
    const listed = [
      { name: 'restart_deployment' },
      { name: 'set_deployment_image', meta: { 'io.curity.demo/required-roles': ['sre'] } },
    ];
    expect(toolInfos(listed, ['oncall'])).toEqual([
      { name: 'restart_deployment' },
      { name: 'set_deployment_image', requiredRoles: ['sre'], callable: false },
    ]);
    expect(toolInfos(listed, [])).toEqual([
      { name: 'restart_deployment' },
      { name: 'set_deployment_image', requiredRoles: ['sre'], callable: false },
    ]);
  });

  it('is callable when the caller holds ANY of the required roles — the same rule as toolRoleDenial', () => {
    const listed = [{ name: 'set_deployment_image', meta: { 'io.curity.demo/required-roles': ['sre', 'oncall'] } }];
    expect(toolInfos(listed, ['oncall'])[0]).toMatchObject({ callable: true });
  });
});
