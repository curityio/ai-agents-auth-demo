import type { Request, Response } from 'express';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import type { AuthedRequest } from './auth-middleware.js';
import { peekLastExchange } from './mcp-client.js';
import { peekLastSpecialistExchange } from './specialist-client.js';
import type { Config } from './config.js';

interface ChainHop {
  hop: string;
  header: ReturnType<typeof decodeProtectedHeader>;
  payload: ReturnType<typeof decodeJwt>;
  /** Raw JWT — included only when the caller requests `?raw=1` (debug inspect). */
  token?: string;
}

function decode(hop: string, token: string, includeRaw: boolean): ChainHop {
  return {
    hop,
    header: decodeProtectedHeader(token),
    payload: decodeJwt(token),
    ...(includeRaw ? { token } : {}),
  };
}

interface ExchangeSlot {
  sub: string;
  /** `jti` of the subject token this exchange was minted from (session marker). */
  subjectJti?: string;
  at: number;
}

/**
 * Decide which downstream branch (if any) to render, given the CURRENT inbound
 * token and the process-global exchange slots.
 *
 * An exchange slot is only "ours" if it was minted from the current inbound
 * token — matched on (sub, subjectJti). The `jti` gate is what stops a prior
 * session's exchange for the SAME user from leaking in after a fresh login when
 * no flow has run yet. A single /chat takes exactly ONE path (observe XOR
 * privileged), so when both slots match we show only the most recent.
 */
export function selectDownstreamBranch(
  inbound: { sub: unknown; jti: unknown },
  obs: ExchangeSlot | undefined,
  spec: ExchangeSlot | undefined,
): { showObs: boolean; showSpec: boolean } {
  const belongs = (e: ExchangeSlot | undefined): boolean =>
    !!e &&
    e.sub === inbound.sub &&
    typeof inbound.jti === 'string' &&
    e.subjectJti === inbound.jti;

  const obsOk = belongs(obs);
  const specOk = belongs(spec);

  if (obsOk && specOk) {
    return obs!.at >= spec!.at
      ? { showObs: true, showSpec: false }
      : { showObs: false, showSpec: true };
  }
  return { showObs: obsOk, showSpec: specOk };
}

/**
 * Fetch a downstream service's `/last-token` (uniform `{ chain }` shape) using
 * the bearer this hop minted for it, and return its hops to be concatenated.
 * Best-effort: any failure (expired token, service down) yields an empty list
 * so the chain still renders up to the last reachable hop.
 */
async function fetchDownstreamChain(
  url: string,
  bearer: string,
  includeRaw: boolean,
): Promise<ChainHop[]> {
  try {
    // Propagate `?raw=1` so the whole chain carries raw tokens, not just our hop.
    const fetchUrl = includeRaw ? `${url}?raw=1` : url;
    const r = await fetch(fetchUrl, { headers: { authorization: `Bearer ${bearer}` } });
    if (!r.ok) return [];
    const body = (await r.json()) as { chain?: ChainHop[] };
    return body.chain ?? [];
  } catch (e) {
    console.error('[last-token] downstream fetch failed', url, e);
    return [];
  }
}

/**
 * Returns the full OBO chain for the calling user, ordered from the USER end
 * (index 0) to the deepest resource server. Both branches may appear if the
 * user exercised each recently:
 *
 *   observe:     user → copilot → mcp-observability → obs-api
 *   privileged:  user → copilot → agent-specialist → mcp-ops → ops-api
 *
 * Each MCP server and agent exposes its own `/last-token` that returns its
 * downstream hop(s); we concatenate them so the final mcp→api leg is included.
 */
export async function lastTokenHandler(req: Request, res: Response): Promise<void> {
  const authed = req as AuthedRequest;
  if (!authed.caller || !authed.bearerToken) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  const cfg = (req.app.locals as { cfg?: Config }).cfg;
  const subjectSub = authed.caller.payload.sub;
  const subjectJti = authed.caller.payload.jti;
  // Raw tokens are opt-in per request (`?raw=1`). The only caller that asks is
  // the web BFF's /api/inspect route, which is itself gated on AUTH_DEBUG.
  const includeRaw = req.query.raw === '1';
  const chain: ChainHop[] = [];

  chain.push(decode('user → agent-copilot (inbound)', authed.bearerToken, includeRaw));

  // The per-user exchange slots are process-global and persist across requests
  // AND across logins. Surface a downstream branch only if its slot was minted
  // from THIS inbound token (matched on sub + subjectJti) — otherwise a prior
  // session's exchange for the same user leaks in after a fresh login when no
  // flow has run yet. selectDownstreamBranch also collapses to the single
  // most-recently-exercised path (a /chat is observe XOR privileged).
  const obsExch = peekLastExchange();
  const specExch = peekLastSpecialistExchange();
  const { showObs, showSpec } = selectDownstreamBranch(
    { sub: subjectSub, jti: subjectJti },
    obsExch,
    specExch,
  );

  if (showObs && obsExch) {
    // This token is aud=mcp-gateway — the agent now reaches mcp-observability
    // THROUGH the agentgateway, which re-exchanges (via the shim) to
    // aud=mcp-observability. The gateway → mcp-observability + mcp-observability →
    // obs-api legs come from the downstream /last-token walk below.
    chain.push(decode('agent-copilot → agentgateway', obsExch.accessToken, includeRaw));
    if (cfg) {
      const url = cfg.mcpObservabilityUrl.replace(/\/mcp\/?$/, '') + '/last-token';
      chain.push(...(await fetchDownstreamChain(url, obsExch.accessToken, includeRaw)));
    }
  }

  if (showSpec && specExch) {
    chain.push(decode('agent-copilot → agent-specialist', specExch.accessToken, includeRaw));
    if (cfg) {
      const url = cfg.specialistA2aUrl.replace(/\/a2a\/?$/, '') + '/last-token';
      chain.push(...(await fetchDownstreamChain(url, specExch.accessToken, includeRaw)));
    }
  }

  res.json({ chain });
}
