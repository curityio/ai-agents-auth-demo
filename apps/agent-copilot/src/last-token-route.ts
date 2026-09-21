import type { Request, Response } from 'express';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import type { AuthedRequest } from './auth-middleware.js';
import { peekLastExchange } from './mcp-client.js';
import { peekLastSpecialistExchange } from './specialist-client.js';
import { peekLastLlmExchange } from './llm-token.js';
import type { Config } from './config.js';

interface ChainHop {
  hop: string;
  header: ReturnType<typeof decodeProtectedHeader>;
  payload: ReturnType<typeof decodeJwt>;
  /** Raw JWT — included only when the caller requests `?raw=1` (debug inspect). */
  token?: string;
  /**
   * Presenter-facing caveat the UI shows on the row. Set on hops whose place in
   * the chain is not what the shape alone suggests — today the LLM leaf.
   */
  note?: string;
}

/**
 * Shown on the aud=llm-gateway row. The token is a real RFC 8693 narrowing of
 * the user's delegation (scope down to llm:invoke, the agent nested into
 * `act`), but the model provider sits outside the trust domain, so this token
 * is never exchanged onward and is not a step toward the cluster.
 */
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
 *
 * The LLM slot is a LEAF, not a third branch. The copilot exchanges to
 * aud=llm-gateway only on the observe path, and only AFTER that request's
 * mcp-gateway exchange — so the leaf is shown iff the observe branch is shown
 * and the leaf was stamped after it. A leaf stamped earlier belongs to a
 * previous read flow (this one failed before reaching the model), and under
 * the privileged branch the copilot's leaf is never shown at all: on that path
 * the model is called by the specialist, whose own /last-token reports it.
 */
export function selectDownstreamBranch(
  inbound: { sub: unknown; jti: unknown },
  obs: ExchangeSlot | undefined,
  spec: ExchangeSlot | undefined,
  llm?: ExchangeSlot | undefined,
): { showObs: boolean; showSpec: boolean; showLlm: boolean } {
  const belongs = (e: ExchangeSlot | undefined): boolean =>
    !!e && e.sub === inbound.sub && typeof inbound.jti === 'string' && e.subjectJti === inbound.jti;

  const obsOk = belongs(obs);
  const specOk = belongs(spec);

  let showObs = obsOk;
  let showSpec = specOk;
  if (obsOk && specOk) {
    showObs = obs!.at >= spec!.at;
    showSpec = !showObs;
  }
  const showLlm = showObs && belongs(llm) && llm!.at >= obs!.at;
  return { showObs, showSpec, showLlm };
}

/**
 * Fetch a downstream service's `/last-token` (uniform `{ chain }` shape) using
 * the bearer this hop minted for it, and return its hops to be concatenated.
 *
 * Best-effort with a memory: the walk authenticates to the next service with
 * the exchanged token, so once that token EXPIRES the next hop answers 401 and
 * the chain would silently truncate to this process's own hops — the demo's
 * "tokens are short-lived" beat then looks like a bug. So the last successful
 * result is kept per exact bearer, and served when the same bearer is later
 * refused or the service is unreachable. Keyed on the token string itself, a
 * snapshot can only ever describe the delegation it was fetched with; a fresh
 * exchange is a new key. Nothing about auth on any /last-token route changes.
 * Bounded to the last few bearers — this is a debug surface, not a cache.
 */
export function createDownstreamChainFetcher(
  fetchImpl: typeof fetch = fetch,
  maxSnapshots = 8,
): (url: string, bearer: string, includeRaw: boolean) => Promise<ChainHop[]> {
  const snapshots = new Map<string, ChainHop[]>();
  const remember = (key: string, hops: ChainHop[]) => {
    snapshots.delete(key);
    snapshots.set(key, hops);
    while (snapshots.size > maxSnapshots) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
  };
  return async (url, bearer, includeRaw) => {
    const key = `${url}|${includeRaw ? 'raw' : 'decoded'}|${bearer}`;
    try {
      // Propagate `?raw=1` so the whole chain carries raw tokens, not just our hop.
      const fetchUrl = includeRaw ? `${url}?raw=1` : url;
      const r = await fetchImpl(fetchUrl, { headers: { authorization: `Bearer ${bearer}` } });
      if (!r.ok) return snapshots.get(key) ?? [];
      const body = (await r.json()) as { chain?: ChainHop[] };
      const hops = body.chain ?? [];
      remember(key, hops);
      return hops;
    } catch (e) {
      console.error('[last-token] downstream fetch failed', url, e);
      return snapshots.get(key) ?? [];
    }
  };
}

const fetchDownstreamChain = createDownstreamChainFetcher();

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
  const llmExch = peekLastLlmExchange();
  const { showObs, showSpec, showLlm } = selectDownstreamBranch(
    { sub: subjectSub, jti: subjectJti },
    obsExch,
    specExch,
    llmExch,
  );

  // The LLM leaf goes directly under the token it was minted from (hop 0) and
  // BEFORE the MCP branch: the ledger finds each row's parent by act-chain
  // prefix, so the mcp-gateway row still diffs against hop 0, not the leaf.
  if (showLlm && llmExch) {
    chain.push(
      decode('agent-copilot → agentgateway (/llm)', llmExch.accessToken, includeRaw, LLM_LEAF_NOTE),
    );
  }

  if (showObs && obsExch) {
    // This token is aud=mcp-gateway — the agent now reaches mcp-observability
    // THROUGH the agentgateway, which re-exchanges (via the shim) to
    // aud=mcp-observability. The gateway → mcp-observability + mcp-observability →
    // obs-api legs come from the downstream /last-token walk below.
    chain.push(
      decode('agent-copilot → agentgateway (/observability/mcp)', obsExch.accessToken, includeRaw),
    );
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
