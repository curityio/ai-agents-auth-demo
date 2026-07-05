import type { exchangeToken } from '@ai-agents-demo/auth-curity';

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
}

export async function handleExchange(
  req: ExchangeRequest,
  deps: HandlerDeps,
): Promise<ExchangeResponse> {
  const allowedScope = deps.audienceScopes[req.targetAudience];
  if (!allowedScope) {
    throw new Error(`audience not allowed: ${req.targetAudience}`);
  }
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
  return {
    access_token: result.accessToken,
    token_type: result.tokenType,
    expires_in: result.expiresInSec,
  };
}
