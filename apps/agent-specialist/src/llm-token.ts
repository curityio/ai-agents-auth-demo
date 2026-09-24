import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { resolveAuthorizationServer } from '@ai-agents-demo/agent-runtime';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { TokenExchangeCache } from './token-exchange-cache.js';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});
const llmCache = new TokenExchangeCache({ ttlMs: 60_000 });

// Mirror obs-token.ts's peekLastObsExchange: the most recent aud=llm-gateway
// token this process minted (or reused), so /last-token can surface the model
// call as a LEAF of the OBO chain. Stamped on cache hits too — the route
// orders it against the ops:write exchange of the same run by `at`.
let lastLlmExchange: { accessToken: string; at: number } | undefined;
export function peekLastLlmExchange(): { accessToken: string; at: number } | undefined {
  return lastLlmExchange ? { ...lastLlmExchange } : undefined;
}

/**
 * RFC 8693 exchange → aud=llm-gateway, scope=llm:invoke. Subject = the user
 * token (on-behalf-of), actor = this agent's SPIFFE JWT-SVID. 60 s TTL cache
 * keyed on (sub, scope, audience, acr). Mirrors obtainMcpToken in mcp-client.ts.
 */
export async function obtainLlmToken(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  subjectAcr: string;
}): Promise<string> {
  const { cfg, subjectToken, subjectSub, subjectAcr } = opts;
  const key = {
    sub: subjectSub,
    scope: cfg.llmGatewayScope,
    audience: cfg.llmGatewayAudience,
    acr: subjectAcr,
  };
  const cached = llmCache.get(key);
  if (cached) {
    lastLlmExchange = { accessToken: cached.accessToken, at: Date.now() };
    return cached.accessToken;
  }

  const svid = await svidSource.getSvid(SVID_AUDIENCE);
  if (!svid) {
    throw new CurityAuthError(
      `SPIFFE JWT-SVID not available at ${SVID_FILE} (spiffe-helper not ready?)`,
      'invalid_actor',
    );
  }

  const identity = await getCimdIdentity(cfg);
  // No MCP server to discover from on this hop, so the AS is the configured
  // issuer — but the token endpoint is still READ from its RFC 8414 metadata,
  // never configured.
  const as = await resolveAuthorizationServer(cfg.curityIssuer);
  const result = await exchangeToken({
    tokenEndpoint: as.tokenEndpoint,
    clientId: cfg.agentClientId,
    clientAuth: {
      method: 'private_key_jwt',
      privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
      kid: identity.kid,
      assertionAudience: as.tokenEndpoint,
    },
    subjectToken,
    actorToken: svid.jwt,
    audience: cfg.llmGatewayAudience,
    scope: cfg.llmGatewayScope,
  });

  llmCache.set(key, {
    accessToken: result.accessToken,
    expiresInSec: result.expiresInSec,
    scope: result.scope,
  });
  lastLlmExchange = { accessToken: result.accessToken, at: Date.now() };
  return result.accessToken;
}
