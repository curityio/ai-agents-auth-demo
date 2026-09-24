import { decodeJwt } from 'jose';
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

/** Best-effort `jti` extraction from an already-verified JWT (no throw). */
function jtiOf(token: string): string | undefined {
  try {
    const jti = decodeJwt(token).jti;
    return typeof jti === 'string' ? jti : undefined;
  } catch {
    return undefined;
  }
}

let lastLlmExchange:
  | { sub: string; accessToken: string; at: number; subjectJti?: string }
  | undefined;

/**
 * The most recent aud=llm-gateway exchange this process performed, across ALL
 * users — same single-slot, last-writer-wins shape as `peekLastExchange` in
 * mcp-client.ts, and the same rule for consumers: filter by (sub, subjectJti)
 * before surfacing. /last-token renders it as a LEAF of the OBO chain (the
 * model call is a sibling of the MCP branch, not a step toward the cluster).
 */
export function peekLastLlmExchange():
  | { sub: string; accessToken: string; at: number; subjectJti?: string }
  | undefined {
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
    // Stamp the slot on a cache hit too: /last-token orders the leaf against the
    // MCP exchange of the same request by `at`, so a hit must still read as
    // "used now", exactly as obtainMcpToken does.
    lastLlmExchange = {
      sub: subjectSub,
      accessToken: cached.accessToken,
      at: Date.now(),
      subjectJti: jtiOf(subjectToken),
    };
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
  }, cfg.exchangeCacheTtlMs);
  lastLlmExchange = {
    sub: subjectSub,
    accessToken: result.accessToken,
    at: Date.now(),
    subjectJti: jtiOf(subjectToken),
  };
  return result.accessToken;
}
