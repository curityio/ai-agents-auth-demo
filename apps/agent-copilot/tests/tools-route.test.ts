/**
 * Unit tests for collectToolTiers — the copilot side of GET /tools.
 *
 * The copilot can only list the READ tier itself (its Curity policy allows
 * inspect:read → mcp-gateway). The WRITE tier is listed by asking the specialist
 * over the same aud=agent-specialist delegation token a real remediation uses,
 * so the specialist's own gates (acr, role) decide what the card shows.
 */
import { describe, it, expect, vi } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import { collectToolTiers, type ToolTiersDeps } from '../src/tools-route.js';
import type { Config } from '../src/config.js';

const cfg = {
  mcpInspectUrl: 'http://gw/inspect/mcp',
  specialistA2aUrl: 'http://agent-specialist.agents.svc.cluster.local:8082/a2a',
} as unknown as Config;

const subject = { bearer: 'USER_TOKEN', sub: 'alice', acr: 'mfa' };

/** A provider whose acquire() resolves (or rejects) like the real one would. */
function fakeProvider(token: string, acquireError?: Error) {
  return {
    discover: vi.fn(async () => ({ scope: 'inspect:read' })),
    acquire: vi.fn(async () => { if (acquireError) throw acquireError; return token; }),
    current: () => ({ token }),
    token: async () => token,
    onUnauthorized: async () => {},
  } as unknown as ReturnType<ToolTiersDeps['buildInspectAuthProvider']>;
}

function deps(overrides: Partial<ToolTiersDeps> = {}): ToolTiersDeps {
  return {
    buildInspectAuthProvider: vi.fn(() => fakeProvider('INSPECT_TOKEN')),
    openMcpToolset: vi.fn(async () => ({
      tools: {},
      listed: [
        { name: 'list_pods', description: 'List pods' },
        { name: 'get_pod_logs', description: 'Get logs' },
      ],
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
        tier: 'inspect',
        route: '/inspect/mcp',
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

  it('relays the specialist\'s per-tool callable verdicts untouched (the copilot has no view of the write tier\'s rules)', async () => {
    const d = deps({
      fetchSpecialistTools: vi.fn(async () => ({
        status: 'ok' as const,
        tools: [
          { name: 'restart_deployment' },
          { name: 'set_deployment_image', requiredRoles: ['sre'], callable: false },
        ],
      })),
    });
    const out = await collectToolTiers({ cfg, subject: { ...subject, sub: 'carol' }, deps: d });
    expect(out.tiers[1]).toMatchObject({
      status: 'ok',
      tools: [
        { name: 'restart_deployment' },
        { name: 'set_deployment_image', requiredRoles: ['sre'], callable: false },
      ],
    });
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
      buildInspectAuthProvider: vi.fn(() =>
        fakeProvider('', new CurityAuthError('no scope intersects', 'invalid_scope')),
      ),
    });
    const out = await collectToolTiers({ cfg, subject, deps: d });
    expect(out.tiers[0]).toEqual({
      tier: 'inspect',
      route: '/inspect/mcp',
      status: 'denied',
      error: 'invalid_scope',
      description: 'no scope intersects',
    });
  });

  it('does NOT record itself as the session\'s last flow (the OBO-chain view must not flip to a branch the probe touched)', async () => {
    // Regression: after "list the pods" (read branch), pressing "Check tools"
    // made the On-behalf-of chain show the specialist branch, because the probe's
    // obtainSpecialistToken stamped the process-global last-exchange slot newer
    // than the real read flow's. The probe must opt out of that recording.
    const d = deps();
    await collectToolTiers({ cfg, subject, deps: d });
    expect(d.buildInspectAuthProvider).toHaveBeenCalledWith(expect.objectContaining({ recordLastExchange: false }));
    expect(d.obtainSpecialistToken).toHaveBeenCalledWith(
      expect.objectContaining({ recordLastExchange: false }),
    );
  });

  it('closes the read toolset after listing', async () => {
    const close = vi.fn(async () => {});
    const d = deps({
      openMcpToolset: vi.fn(async () => ({
        tools: {},
        listed: [],
        close,
      })) as unknown as ToolTiersDeps['openMcpToolset'],
    });
    await collectToolTiers({ cfg, subject, deps: d });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('acquires the read-tier token through the provider with recordLastExchange:false and opens the toolset with it', async () => {
    const d = deps();
    await collectToolTiers({ cfg, subject, deps: d });
    expect(d.buildInspectAuthProvider).toHaveBeenCalledWith(expect.objectContaining({ recordLastExchange: false }));
    expect(d.openMcpToolset).toHaveBeenCalledWith(
      expect.objectContaining({ url: cfg.mcpInspectUrl, authProvider: expect.objectContaining({ acquire: expect.any(Function) }) }),
    );
  });
});
