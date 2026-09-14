import type { Request, Response } from 'express';
import type { ToolSet } from 'ai';
import { verifyJwt, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { openMcpToolset } from '@ai-agents-demo/agent-runtime';
import { obtainOpsToken } from './mcp-ops-client.js';
import type { Config } from './config.js';

/**
 * GET /tools — "what can this identity see on the WRITE tier?"
 *
 * Demo visibility for agentgateway's per-tier `tools/list` filtering. The probe
 * deliberately walks the SAME gates, in the SAME order, that a real remediation
 * walks in executor.ts, so the answer is truthful for every persona without
 * special-casing any of them:
 *
 *   1. deterministic acr pre-check  → `step-up`  (no privileged token is minted)
 *   2. ops:write exchange            → `denied`   (Curity's role gate / TIA)
 *   3. tools/list via the gateway    → `ok`       (what the gateway lets this tier see)
 *
 * Like /last-token, this is a debug surface: listing the write tier mints a real
 * `ops:write` token for display only. Gate behind a DEBUG flag before production.
 */

export interface ToolInfo {
  name: string;
  description?: string;
}

export type OpsToolsResult =
  | { status: 'ok'; tools: ToolInfo[] }
  | { status: 'step-up'; acrValues: string; scope: string }
  | { status: 'denied'; error: string; description: string }
  | { status: 'error'; error: string; description: string };

export interface ToolsDeps {
  obtainOpsToken: typeof obtainOpsToken;
  openMcpToolset: typeof openMcpToolset;
}

const defaultDeps: ToolsDeps = { obtainOpsToken, openMcpToolset };

export async function listOpsTools(args: {
  cfg: Config;
  bearer: string;
  claims: { sub: string; acr?: string };
  deps?: ToolsDeps;
}): Promise<OpsToolsResult> {
  const { cfg, bearer, claims } = args;
  const deps = args.deps ?? defaultDeps;

  // 1. Same deterministic pre-check as remediate(): challenge before any exchange.
  if ((claims.acr ?? '') !== cfg.requiredAcr) {
    return { status: 'step-up', acrValues: cfg.requiredAcr, scope: cfg.mcpOpsScope };
  }

  // 2. The privileged exchange — Curity's role gate and the ACR TIA fire here.
  let opsToken: string;
  try {
    opsToken = await deps.obtainOpsToken({ cfg, subjectToken: bearer, subjectSub: claims.sub });
  } catch (e) {
    if (e instanceof CurityAuthError) {
      return { status: 'denied', error: e.code, description: e.message };
    }
    return { status: 'error', error: 'exchange_failed', description: String(e) };
  }

  // 3. What the gateway lets an ops:write caller list.
  let toolset: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  try {
    toolset = await deps.openMcpToolset({
      url: cfg.mcpOpsUrl,
      bearerToken: opsToken,
      clientName: 'agent-specialist',
      label: 'mcp-ops (tools/list probe)',
    });
    return { status: 'ok', tools: toolInfos(toolset.tools) };
  } catch (e) {
    return { status: 'error', error: 'mcp_unavailable', description: String(e) };
  } finally {
    await toolset?.close();
  }
}

export function toolInfos(tools: ToolSet): ToolInfo[] {
  return Object.entries(tools).map(([name, t]) => {
    const description = (t as { description?: unknown }).description;
    return { name, ...(typeof description === 'string' ? { description } : {}) };
  });
}

/** Express handler: verifies the inbound aud=agent-specialist bearer, then probes. */
export function buildToolsHandler(cfg: Config) {
  return async (req: Request, res: Response): Promise<void> => {
    const authz = req.header('authorization');
    if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const bearer = authz.slice('bearer '.length).trim();
    let claims: { sub: string; acr?: string };
    try {
      const v = await verifyJwt(bearer, {
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        jwksUri: cfg.curityJwksUri,
      });
      claims = {
        sub: String(v.payload.sub ?? 'unknown'),
        acr: v.payload.acr != null ? String(v.payload.acr) : undefined,
      };
    } catch (e) {
      if (e instanceof CurityAuthError) {
        res.status(401).json({ error: e.code, error_description: e.message });
        return;
      }
      console.error('[specialist/tools] verify error', e);
      res.status(500).json({ error: 'server_error' });
      return;
    }
    res.json(await listOpsTools({ cfg, bearer, claims }));
  };
}
