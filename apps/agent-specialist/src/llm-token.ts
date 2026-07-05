import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { TokenExchangeCache } from './token-exchange-cache.js';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});
const llmCache = new TokenExchangeCache({ ttlMs: 60_000 });

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
  if (cached) return cached.accessToken;

  const svid = await svidSource.getSvid(SVID_AUDIENCE);
  if (!svid) {
    throw new CurityAuthError(
      `SPIFFE JWT-SVID not available at ${SVID_FILE} (spiffe-helper not ready?)`,
      'invalid_actor',
    );
  }

  const identity = await getCimdIdentity(cfg);
  const result = await exchangeToken({
    tokenEndpoint: cfg.curityTokenEndpoint,
    clientId: cfg.agentClientId,
    clientAuth: {
      method: 'private_key_jwt',
      privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
      kid: identity.kid,
      assertionAudience: cfg.curityTokenEndpoint,
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
  return result.accessToken;
}
