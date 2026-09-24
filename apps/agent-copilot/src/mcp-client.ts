import { decodeJwt } from 'jose';
import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { openMcpToolset, type McpToolset } from '@ai-agents-demo/agent-runtime';
import { TokenExchangeCache } from './token-exchange-cache.js';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

export { openMcpToolset, type McpToolset };

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

const exchangeCache = new TokenExchangeCache({ ttlMs: 60_000 });

/** Best-effort `jti` extraction from an already-verified JWT (no throw). */
function jtiOf(token: string): string | undefined {
  try {
    const jti = decodeJwt(token).jti;
    return typeof jti === 'string' ? jti : undefined;
  } catch {
    return undefined;
  }
}

let lastExchange:
  | { sub: string; accessToken: string; at: number; subjectJti?: string }
  | undefined;

/**
 * Returns a snapshot of the MOST RECENT token exchange that happened in
 * this process — across ALL users. Single global slot, last writer wins.
 *
 * Consumers (e.g. /last-token debug route) MUST filter by `sub` before
 * surfacing — otherwise under concurrent demo use, user A's view of their
 * own exchange will go silent the moment user B exchanges. The filtering
 * lives in callers, not here.
 *
 * Could be promoted to a per-sub map if multi-user debug surfaces become
 * important. Debug-only; gate the consumer routes behind a DEBUG flag before
 * production.
 */
export function peekLastExchange():
  | { sub: string; accessToken: string; at: number; subjectJti?: string }
  | undefined {
  return lastExchange ? { ...lastExchange } : undefined;
}

/**
 * Perform RFC 8693 token exchange to obtain an MCP-bound token, with a 60 s
 * TTL cache keyed on (sub, scope, audience). A 401 from MCP is handled by the
 * auth provider's `onUnauthorized` (forced re-discovery + one more exchange),
 * see mcp-auth.ts.
 */
export async function obtainMcpToken(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  subjectAcr: string;
  /** Discovered from the MCP server's authorization-server metadata (never configured). */
  tokenEndpoint: string;
  /** Discovered: the 401 challenge's `scope`, else the PRM's `scopes_supported`. */
  scope: string;
  /**
   * Whether this call should be recorded as the process's "most recent
   * exchange" for the debug /last-token route. Defaults to true. The tools/list
   * PROBE passes false: it mints the same tokens a real flow would, but it is
   * not a flow, and recording it made the OBO-chain view flip to a branch the
   * user never exercised.
   */
  recordLastExchange?: boolean;
  /**
   * Drop the cached token for this key and exchange afresh. Set by the auth
   * provider when the transport reported a 401 (`McpExchangeInput.forced`): the
   * cached token is what just failed, so serving it again would make the SDK's
   * single retry fail identically.
   */
  bypassCache?: boolean;
}): Promise<string> {
  const { cfg, subjectToken, subjectSub, subjectAcr, tokenEndpoint, scope } = opts;
  const record = opts.recordLastExchange !== false;
  const key = { sub: subjectSub, scope, audience: cfg.mcpObservabilityAudience, acr: subjectAcr };
  if (opts.bypassCache) exchangeCache.invalidate(key);
  const cached = exchangeCache.get(key);
  if (cached) {
    // Refresh the "last used" marker even on a cache hit so the OBO-chain
    // assembler can tell which path was exercised most recently.
    if (record) lastExchange = {
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
  const result = await exchangeToken({
    tokenEndpoint,
    clientId: cfg.agentClientId,
    clientAuth: {
      method: 'private_key_jwt',
      privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
      kid: identity.kid,
      assertionAudience: tokenEndpoint,
    },
    subjectToken,
    actorToken: svid.jwt,
    audience: cfg.mcpObservabilityAudience,
    scope,
  });

  exchangeCache.set(key, {
    accessToken: result.accessToken,
    expiresInSec: result.expiresInSec,
    scope: result.scope,
  }, cfg.exchangeCacheTtlMs);
  if (record) lastExchange = {
    sub: subjectSub,
    accessToken: result.accessToken,
    at: Date.now(),
    subjectJti: jtiOf(subjectToken),
  };
  return result.accessToken;
}
