import {
  DpopProofError,
  tokenCnfJkt,
  verifyDpopProof,
  type DpopReplayCache,
  type exchangeToken,
} from '@ai-agents-demo/auth-curity';
import type { ExchangeCache } from './exchange-cache.js';

export interface ExchangeRequest {
  callerToken: string;
  targetAudience: string;
  /**
   * What the gateway forwarded for an RFC 9449 check: the client's `DPoP` proof,
   * the request method, and the route's public URL (static per route, like the
   * audience — never derived from the request).
   */
  dpop?: { proof?: string; htm?: string; htu?: string };
}

export interface ExchangeResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface HandlerDeps {
  getSvidJwt: () => Promise<string>;
  exchange: typeof exchangeToken;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** Allow-list: audience -> the single scope the gateway may request for it. */
  audienceScopes: Record<string, string>;
  /**
   * Optional: reuse an exchanged token for the same (caller token, audience) within
   * a short window, so the three gateway requests one question costs (discover,
   * list, call) mint ONE downstream token instead of three. See exchange-cache.ts.
   */
  cache?: ExchangeCache;
  /** Proof jti memory; required to accept DPoP-bound caller tokens. */
  replay?: DpopReplayCache;
}

export async function handleExchange(
  req: ExchangeRequest,
  deps: HandlerDeps,
): Promise<ExchangeResponse> {
  const allowedScope = deps.audienceScopes[req.targetAudience];
  if (!allowedScope) {
    throw new Error(`audience not allowed: ${req.targetAudience}`);
  }
  // RFC 9449 at the gateway (agentgateway has no DPoP support). A bound caller
  // token is only good with a proof from its key, and the check runs BEFORE the
  // cache: the cache is keyed by the caller token alone, so checking after it would
  // hand a stolen bound token the exchange its owner just made. Unbound tokens pass
  // through as before. The caller token's signature was verified by the gateway's
  // JWT policy before this callout; its cnf is read, not re-verified.
  const jkt = tokenCnfJkt(req.callerToken);
  if (jkt) {
    const { proof, htm, htu } = req.dpop ?? {};
    if (!proof || !htm || !htu || !deps.replay) {
      throw new DpopProofError('DPoP proof required for a DPoP-bound token');
    }
    await verifyDpopProof(proof, { htm, htu, accessToken: req.callerToken, jkt, replay: deps.replay });
  }
  const cached = deps.cache?.get(req.callerToken, req.targetAudience);
  if (cached) return cached;
  const actorToken = await deps.getSvidJwt();
  const result = await deps.exchange({
    tokenEndpoint: deps.tokenEndpoint,
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    subjectToken: req.callerToken,
    actorToken,
    audience: req.targetAudience,
    scope: allowedScope,
  });
  const body: ExchangeResponse = {
    access_token: result.accessToken,
    token_type: result.tokenType,
    expires_in: result.expiresInSec,
  };
  // Only a GRANTED exchange is remembered; a refusal is re-asked every time so a
  // DENY keeps being logged at exchangeToken's single exit (fact #31).
  deps.cache?.set(req.callerToken, req.targetAudience, body);
  return body;
}
