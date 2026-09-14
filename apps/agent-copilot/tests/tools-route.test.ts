/**
 * Unit tests for collectToolTiers — the copilot side of GET /tools.
 *
 * The copilot can only list the READ tier itself (its Curity policy allows
 * obs:read → mcp-gateway). The WRITE tier is listed by asking the specialist
 * over the same aud=agent-specialist delegation token a real remediation uses,
 * so the specialist's own gates (acr, role) decide what the card shows.
 */
import { describe, it, expect, vi } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import { collectToolTiers, type ToolTiersDeps } from '../src/tools-route.js';
import type { Config } from '../src/config.js';

const cfg = {
  mcpObservabilityUrl: 'http://gw/observability/mcp',
  specialistA2aUrl: 'http://agent-specialist.agents.svc.cluster.local:8082/a2a',
} as unknown as Config;

const subject = { bearer: 'USER_TOKEN', sub: 'alice', acr: 'mfa' };

function deps(overrides: Partial<ToolTiersDeps> = {}): ToolTiersDeps {
  return {
    obtainMcpToken: vi.fn(async () => 'OBS_TOKEN'),
    openMcpToolset: vi.fn(async () => ({
      tools: {
        list_pods: { description: 'List pods' },
        get_pod_logs: { description: 'Get logs' },
      },
      close: vi.fn(async () => {}),
    })) as unknown as ToolTiersDeps['openMcpToolset'],
    obtainSpecialistToken: vi.fn(async () => 'SPEC_TOKEN'),
    fetchSpecialistTools: vi.fn(async () => ({
      status: 'ok' as const,
      tools: [{ name: 'restart_deployment', description: 'Restart' }],
    })),
    ...overrides,
  };
}

describe('collectToolTiers', () => {
  it('returns both tiers when the user may reach both', async () => {
    const d = deps();
    const out = await collectToolTiers({ cfg, subject, deps: d });
    expect(out.tiers).toEqual([
      {
        tier: 'observability',
        route: '/observability/mcp',
        status: 'ok',
        tools: [
          { name: 'list_pods', description: 'List pods' },
          { name: 'get_pod_logs', description: 'Get logs' },
        ],
      },
      {
        tier: 'ops',
        route: '/ops/mcp',
        status: 'ok',
        tools: [{ name: 'restart_deployment', description: 'Restart' }],
      },
    ]);
    // The write tier is probed with the specialist delegation token, not the
    // user's token — the same hop a real remediation takes.
    expect(d.fetchSpecialistTools).toHaveBeenCalledWith(
      expect.objectContaining({ bearer: 'SPEC_TOKEN' }),
    );
  });

  it('reports the ops tier as denied when Curity refuses the specialist delegation, and still lists the read tier', async () => {
    const d = deps({
      obtainSpecialistToken: vi.fn(async () => {
        throw new CurityAuthError('Role sre or oncall required', 'access_denied');
      }),
    });
    const out = await collectToolTiers({ cfg, subject: { ...subject, sub: 'bob' }, deps: d });
    expect(out.tiers[0]!.status).toBe('ok');
    expect(out.tiers[1]).toEqual({
      tier: 'ops',
      route: '/ops/mcp',
      status: 'denied',
      error: 'access_denied',
      description: 'Role sre or oncall required',
    });
    expect(d.fetchSpecialistTools).not.toHaveBeenCalled();
  });

  it('relays a step-up verdict from the specialist verbatim', async () => {
    const d = deps({
      fetchSpecialistTools: vi.fn(async () => ({
        status: 'step-up' as const,
        acrValues: 'mfa',
        scope: 'ops:write',
      })),
    });
    const out = await collectToolTiers({ cfg, subject: { ...subject, acr: 'html-form' }, deps: d });
    expect(out.tiers[1]).toEqual({
      tier: 'ops',
      route: '/ops/mcp',
      status: 'step-up',
      acrValues: 'mfa',
      scope: 'ops:write',
    });
  });

  it('reports the read tier as an error (not a throw) when its exchange fails', async () => {
    const d = deps({
      obtainMcpToken: vi.fn(async () => {
        throw new CurityAuthError('no scope intersects', 'invalid_scope');
      }),
    });
    const out = await collectToolTiers({ cfg, subject, deps: d });
    expect(out.tiers[0]).toEqual({
      tier: 'observability',
      route: '/observability/mcp',
      status: 'denied',
      error: 'invalid_scope',
      description: 'no scope intersects',
    });
  });

  it('closes the read toolset after listing', async () => {
    const close = vi.fn(async () => {});
    const d = deps({
      openMcpToolset: vi.fn(async () => ({
        tools: {},
        close,
      })) as unknown as ToolTiersDeps['openMcpToolset'],
    });
    await collectToolTiers({ cfg, subject, deps: d });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
