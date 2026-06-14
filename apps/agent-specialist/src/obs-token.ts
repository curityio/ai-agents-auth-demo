import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

// Mirror mcp-ops-client's peekLastExchange: the most recent obs:read token this
// process minted, so /last-token can surface the specialist → mcp-observability
// hop (and, via it, mcp-observability → obs-api) in the demo's OBO-chain view.
let lastObsExchange: { accessToken: string; at: number } | undefined;
export function peekLastObsExchange(): { accessToken: string; at: number } | undefined {
  return lastObsExchange ? { ...lastObsExchange } : undefined;
}

/**
 * Exchange the inbound bearer for an mcp-observability-bound token (obs:read).
 * Mirrors obtainOpsToken but targets the READ tier — no MFA required, so this
 * never triggers step-up. The procedure nests our SPIFFE ID into act, yielding
 * act={specialist, copilot}; obs-api accepts that 3-deep chain.
 */
export async function obtainObsToken(opts: {
  cfg: Config;
  subjectToken: string;
}): Promise<string> {
  const { cfg, subjectToken } = opts;
  const svid = await svidSource.getSvid(SVID_AUDIENCE);
  if (!svid) {
    throw new CurityAuthError(`SPIFFE JWT-SVID not available at ${SVID_FILE}`, 'invalid_actor');
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
    audience: cfg.mcpObservabilityAudience,
    scope: cfg.mcpObservabilityScope,
  });
  lastObsExchange = { accessToken: result.accessToken, at: Date.now() };
  return result.accessToken;
}
