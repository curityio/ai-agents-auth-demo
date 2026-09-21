import type { Request, Response, NextFunction } from 'express';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { verifyJwt, CurityAuthError } from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';
import { peekLastExchange } from './mcp-ops-client.js';
import { peekLastObsExchange } from './obs-token.js';
import { peekLastLlmExchange } from './llm-token.js';

interface ChainHop {
  hop: string;
  header: ReturnType<typeof decodeProtectedHeader>;
  payload: ReturnType<typeof decodeJwt>;
  /** Raw JWT — included only when the caller requests `?raw=1` (debug inspect). */
  token?: string;
  /** Presenter-facing caveat the UI shows on the row (today: the LLM leaf). */
  note?: string;
}

/** Same wording as agent-copilot's LLM_LEAF_NOTE — one row style for both agents. */
export const LLM_LEAF_NOTE =
  'Model call — a leaf, not a hop toward the cluster. The LLM provider sits outside the trust domain, so nothing exchanges this token onward.';

function decode(hop: string, token: string, includeRaw: boolean, note?: string): ChainHop {
  return {
    hop,
    header: decodeProtectedHeader(token),
    payload: decodeJwt(token),
    ...(includeRaw ? { token } : {}),
    ...(note ? { note } : {}),
  };
}

/**
 * Whether the aud=llm-gateway slot belongs to the run the ops:write slot came
 * from. One remediation exchanges in a fixed order — ops:write → obs:read →
 * llm:invoke (executor.ts) — so a leaf stamped BEFORE the current ops slot was minted by an
 * earlier run, and this one was refused before it reached the model (step-up,
 * wrong role). Without an ops slot the model was never reached at all.
 */
export function selectLlmLeaf(
  ops: { at: number } | undefined,
  llm: { at: number } | undefined,
): boolean {
  return !!ops && !!llm && llm.at >= ops.at;
}

/**
 * Demo-only auth middleware for /last-token. Mirrors what userBuilder does
 * inside the A2A pipeline but exposes the bearer through Express's standard
 * model so this debug route can inspect it.
 */
function specialistAuth(cfg: Config) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authz = req.header('authorization');
    if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const token = authz.slice('bearer '.length).trim();
    try {
      await verifyJwt(token, {
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        jwksUri: cfg.curityJwksUri,
      });
      next();
    } catch (e) {
      if (e instanceof CurityAuthError) {
        res.status(401).json({ error: e.code, error_description: e.message });
        return;
      }
      console.error('[specialist/last-token] verify error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}

/** Fetch a downstream MCP server's chain (mcp → api) with that server's bound token. */
async function fetchDownstreamChain(
  label: string,
  url: string,
  bearer: string,
  includeRaw: boolean,
): Promise<ChainHop[]> {
  try {
    const fetchUrl = includeRaw ? `${url}?raw=1` : url;
    const r = await fetch(fetchUrl, { headers: { authorization: `Bearer ${bearer}` } });
    if (!r.ok) return [];
    const body = (await r.json()) as { chain?: ChainHop[] };
    return body.chain ?? [];
  } catch (e) {
    console.error(`[specialist/last-token] ${label} fetch failed`, e);
    return [];
  }
}

export function buildLastTokenHandlers(cfg: Config): {
  authn: ReturnType<typeof specialistAuth>;
  handler: (req: Request, res: Response) => Promise<void>;
} {
  return {
    authn: specialistAuth(cfg),
    async handler(req: Request, res: Response) {
      try {
        const includeRaw = req.query.raw === '1';
        const chain: ChainHop[] = [];

        // The LLM LEAF first: minted from the same inbound delegation token as
        // the two MCP branches, so it sits directly under the copilot →
        // specialist row. The ledger parents by act-chain prefix, so the
        // branches that follow still diff against that row, not the leaf.
        const ops = peekLastExchange();
        const llm = peekLastLlmExchange();
        if (selectLlmLeaf(ops, llm) && llm) {
          chain.push(decode('agent-specialist → agentgateway (/llm)', llm.accessToken, includeRaw, LLM_LEAF_NOTE));
        }

        // READ branch first (the specialist inspects before it acts): the
        // agent-specialist → mcp-observability hop, then mcp-observability →
        // obs-api fetched with the obs:read-bound token.
        const obs = peekLastObsExchange();
        if (obs) {
          // aud=mcp-gateway now (reached via the gateway); the gateway → mcp-obs +
          // mcp-obs → obs-api legs come from the downstream passthrough walk.
          chain.push(decode('agent-specialist → agentgateway (/observability/mcp)', obs.accessToken, includeRaw));
          const obsUrl = cfg.mcpObservabilityUrl.replace(/\/mcp\/?$/, '') + '/last-token';
          chain.push(
            ...(await fetchDownstreamChain('mcp-observability', obsUrl, obs.accessToken, includeRaw)),
          );
        }

        // WRITE branch: the agent-specialist → mcp-ops hop, then the final
        // mcp-ops → ops-api hop fetched with the ops:write-bound token.
        if (ops) {
          chain.push(decode('agent-specialist → agentgateway (/ops/mcp)', ops.accessToken, includeRaw));
          const opsUrl = cfg.mcpOpsUrl.replace(/\/mcp\/?$/, '') + '/last-token';
          chain.push(...(await fetchDownstreamChain('mcp-ops', opsUrl, ops.accessToken, includeRaw)));
        }

        res.json({ chain });
      } catch (e) {
        console.error('[specialist/last-token] handler error', e);
        if (!res.headersSent) res.status(500).json({ error: 'server_error' });
      }
    },
  };
}
