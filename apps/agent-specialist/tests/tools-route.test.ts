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
import { listOpsTools, type ToolsDeps } from '../src/tools-route.js';
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
      tools: {
        restart_deployment: { description: 'Restart a deployment' },
        scale_deployment: { description: 'Scale a deployment' },
      },
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
        tools: {
          restart_deployment: { description: 'Restart a deployment' },
          set_deployment_image: { description: 'Set image' },
        },
        close,
      })) as unknown as ToolsDeps['openMcpToolset'],
    });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'alice', acr: 'mfa' }, deps: d });
    expect(out).toEqual({
      status: 'ok',
      tools: [
        { name: 'restart_deployment', description: 'Restart a deployment' },
        { name: 'set_deployment_image', description: 'Set image' },
      ],
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(d.openMcpToolset).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'http://gw/ops/mcp', bearerToken: 'OPS_TOKEN' }),
    );
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
});
