import type { exchangeToken } from '@ai-agents-demo/auth-curity';
import type { ExchangeCache } from './exchange-cache.js';

export interface ExchangeRequest {
  callerToken: string;
  targetAudience: string;
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
}

export async function handleExchange(
  req: ExchangeRequest,
  deps: HandlerDeps,
): Promise<ExchangeResponse> {
  const allowedScope = deps.audienceScopes[req.targetAudience];
  if (!allowedScope) {
    throw new Error(`audience not allowed: ${req.targetAudience}`);
  }
  const cached = deps.cache?.get(req.callerToken, req.targetAudience);
  if (cached) return cached;
  const actorToken = await deps.getSvidJwt();
  const result = await deps.exchange({
    tokenEndpoint: deps.tokenEndpoint,
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    // Authenticates as `mcp-gateway`, but the pod/container is `exchange-shim`.
    serviceLabel: 'exchange-shim',
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
