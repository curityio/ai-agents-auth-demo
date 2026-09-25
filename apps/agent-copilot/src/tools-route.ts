import type { Request, Response } from 'express';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import { isDiscoveryFailure, requiredRolesOf, type ListedTool } from '@ai-agents-demo/agent-runtime';
import type { AuthedRequest } from './auth-middleware.js';
import { buildInspectAuthProvider } from './mcp-auth.js';
import { openMcpToolset } from './mcp-client.js';
import { obtainSpecialistToken } from './specialist-client.js';
import type { Config } from './config.js';

/**
 * GET /tools — "what can this identity see, per MCP tier?"
 *
 * Makes agentgateway's per-tier `tools/list` filtering visible in the web UI.
 * The copilot lists the READ tier itself (its Curity policy allows
 * inspect:read → mcp-gateway). It cannot list the WRITE tier — only the specialist
 * may exchange for ops:write — so it asks the specialist over the same
 * aud=agent-specialist delegation token a real remediation uses. The
 * specialist's gates (acr pre-check, role gate) then decide what comes back, so
 * the card is truthful for alice / carol / bob with no persona special-casing.
 *
 * Debug surface (mints tokens for display only) — gate behind a DEBUG flag
 * before production, alongside /last-token.
 */

export interface ToolInfo {
  name: string;
  description?: string;
  /** Roles a tool publishes as required to CALL it — see the specialist's ToolInfo. */
  requiredRoles?: string[];
  /** Whether THIS caller holds one of `requiredRoles`. Present iff `requiredRoles` is. */
  callable?: boolean;
}

export type TierStatus =
  | { status: 'ok'; tools: ToolInfo[] }
  | { status: 'step-up'; acrValues: string; scope: string }
  | { status: 'denied'; error: string; description: string }
  | { status: 'error'; error: string; description: string };

export type TierResult = { tier: 'inspect' | 'ops'; route: string } & TierStatus;

export interface ToolTiersResponse {
  tiers: TierResult[];
}

export interface ToolTiersDeps {
  buildInspectAuthProvider: typeof buildInspectAuthProvider;
  openMcpToolset: typeof openMcpToolset;
  obtainSpecialistToken: typeof obtainSpecialistToken;
  /** GET the specialist's /tools with the delegation token; returns its verdict. */
  fetchSpecialistTools: (o: { cfg: Config; bearer: string }) => Promise<TierStatus>;
}

export interface ToolsSubject {
  bearer: string;
  sub: string;
  acr: string;
  roles?: string[];
}

/** Same shape and rule as the specialist's `toolInfos`; the read tier publishes no roles today. */
export function toolInfos(listed: ListedTool[], callerRoles: string[]): ToolInfo[] {
  return listed.map((t) => {
    const requiredRoles = requiredRolesOf(t);
    return {
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(requiredRoles
        ? { requiredRoles, callable: requiredRoles.some((r) => callerRoles.includes(r)) }
        : {}),
    };
  });
}

function authFailure(e: unknown): TierStatus {
  // A failure to LEARN the authorization server is an error, not a denial.
  if (isDiscoveryFailure(e)) {
    return { status: 'error', error: (e as CurityAuthError).code, description: (e as Error).message };
  }
  if (e instanceof CurityAuthError) {
    return { status: 'denied', error: e.code, description: e.message };
  }
  return { status: 'error', error: 'exchange_failed', description: String(e) };
}

async function listReadTier(cfg: Config, subject: ToolsSubject, deps: ToolTiersDeps): Promise<TierStatus> {
  // PROBE, not a flow: recordLastExchange:false keeps the OBO-chain view truthful (fact #34).
  const auth = deps.buildInspectAuthProvider({
    cfg,
    subjectToken: subject.bearer,
    subjectSub: subject.sub,
    subjectAcr: subject.acr,
    recordLastExchange: false,
  });
  try {
    await auth.acquire();
  } catch (e) {
    return authFailure(e);
  }
  let toolset: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  try {
    toolset = await deps.openMcpToolset({
      url: cfg.mcpInspectUrl,
      authProvider: auth,
      clientName: 'agent-copilot',
      label: 'mcp-inspect (tools/list probe)',
    });
    return { status: 'ok', tools: toolInfos(toolset.listed, subject.roles ?? []) };
  } catch (e) {
    return { status: 'error', error: 'mcp_unavailable', description: String(e) };
  } finally {
    await toolset?.close();
  }
}

async function listWriteTier(cfg: Config, subject: ToolsSubject, deps: ToolTiersDeps): Promise<TierStatus> {
  let delegation: string;
  try {
    delegation = await deps.obtainSpecialistToken({
      cfg,
      subjectToken: subject.bearer,
      subjectSub: subject.sub,
      subjectAcr: subject.acr,
      recordLastExchange: false,
    });
  } catch (e) {
    return authFailure(e);
  }
  try {
    return await deps.fetchSpecialistTools({ cfg, bearer: delegation });
  } catch (e) {
    return { status: 'error', error: 'specialist_unavailable', description: String(e) };
  }
}

export async function collectToolTiers(args: {
  cfg: Config;
  subject: ToolsSubject;
  deps?: ToolTiersDeps;
}): Promise<ToolTiersResponse> {
  const { cfg, subject } = args;
  const deps = args.deps ?? defaultDeps;
  const [read, write] = await Promise.all([
    listReadTier(cfg, subject, deps),
    listWriteTier(cfg, subject, deps),
  ]);
  return {
    tiers: [
      { tier: 'inspect', route: '/inspect/mcp', ...read },
      { tier: 'ops', route: '/ops/mcp', ...write },
    ],
  };
}

/** The specialist serves /tools next to its /a2a endpoint. */
export function specialistToolsUrl(cfg: Config): string {
  return cfg.specialistA2aUrl.replace(/\/a2a\/?$/, '') + '/tools';
}

async function fetchSpecialistTools(o: { cfg: Config; bearer: string }): Promise<TierStatus> {
  const r = await fetch(specialistToolsUrl(o.cfg), {
    headers: { authorization: `Bearer ${o.bearer}` },
  });
  if (!r.ok) {
    return {
      status: 'error',
      error: 'specialist_unavailable',
      description: `specialist /tools answered ${r.status}`,
    };
  }
  return (await r.json()) as TierStatus;
}

const defaultDeps: ToolTiersDeps = {
  buildInspectAuthProvider,
  openMcpToolset,
  obtainSpecialistToken,
  fetchSpecialistTools,
};

export function buildToolsHandler(cfg: Config) {
  return async (req: Request, res: Response): Promise<void> => {
    const authed = req as AuthedRequest;
    const rawRoles = (authed.caller?.payload as { roles?: unknown } | undefined)?.roles;
    const subject: ToolsSubject = {
      bearer: authed.bearerToken!,
      sub: String(authed.caller?.payload.sub ?? 'unknown'),
      acr: String(authed.caller?.payload.acr ?? ''),
      roles: Array.isArray(rawRoles)
        ? rawRoles.map(String)
        : typeof rawRoles === 'string'
          ? rawRoles.split(/\s+/).filter(Boolean)
          : [],
    };
    try {
      res.json(await collectToolTiers({ cfg, subject }));
    } catch (e) {
      console.error('[agent-copilot] /tools failed', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}
