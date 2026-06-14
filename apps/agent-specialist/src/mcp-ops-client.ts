import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { StepUpRequiredError } from '@ai-agents-demo/a2a-helpers';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

// ---------------------------------------------------------------------------
// RFC 9728 — Protected Resource Metadata
// ---------------------------------------------------------------------------

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  acr_values_supported?: string[];
  bearer_methods_supported?: string[];
}

let metadataCache: { doc: ProtectedResourceMetadata; fetchedAt: number } | undefined;
const METADATA_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch and cache the RFC 9728 protected resource metadata document from
 * mcp-ops. The document advertises `scopes_supported` and
 * `acr_values_supported`, which the specialist uses to construct a step-up
 * challenge when the token exchange fails with `invalid_scope`.
 */
export async function fetchResourceMetadata(
  url: string,
): Promise<ProtectedResourceMetadata> {
  if (metadataCache && Date.now() - metadataCache.fetchedAt < METADATA_TTL_MS) {
    return metadataCache.doc;
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) {
    throw new Error(`RFC 9728 metadata fetch failed: ${res.status} ${res.statusText}`);
  }
  const doc = (await res.json()) as ProtectedResourceMetadata;
  metadataCache = { doc, fetchedAt: Date.now() };
  return doc;
}

/** Reset the metadata cache (for tests). */
export function _resetMetadataCache(): void {
  metadataCache = undefined;
}

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

let lastExchange: { sub: string; accessToken: string; at: number } | undefined;

/**
 * Peek the most recent exchange this process performed. Matches
 * agent-copilot's peekLastExchange — used by /last-token for the demo UI's
 * N-deep chain visualization.
 */
export function peekLastExchange(): { sub: string; accessToken: string; at: number } | undefined {
  return lastExchange ? { ...lastExchange } : undefined;
}

/**
 * Exchange the inbound bearer (carrying act=copilot) for an mcp-ops-bound
 * token. The procedure nests the inbound act under THIS agent's SPIFFE ID
 * automatically — so the issued token's `act` is
 *   { sub: specialist, act: { sub: copilot } }
 * which is exactly what mcp-ops's middleware checks.
 *
 * Intentionally NO local cache here: the inbound bearer is request-scoped
 * (user JWT after one upstream exchange), and caching across users would
 * leak privileged tokens between sessions. agent-copilot's cache is keyed
 * on user sub; here we let each call mint fresh.
 */
export async function obtainOpsToken(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
}): Promise<string> {
  const { cfg, subjectToken, subjectSub } = opts;
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
    audience: cfg.mcpOpsAudience,
    scope: cfg.mcpOpsScope,
  });
  lastExchange = { sub: subjectSub, accessToken: result.accessToken, at: Date.now() };
  return result.accessToken;
}

/**
 * Parse an RFC 9470 `insufficient_user_authentication` WWW-Authenticate header.
 * Returns the challenge fields, or null if this is any other 401 (not step-up).
 * Only fires for the specific `error="insufficient_user_authentication"` value,
 * leaving other 401s (expired token, invalid token, etc.) as plain errors.
 */
export function parseStepUpChallenge(
  wwwAuthenticate: string | undefined,
): { acrValues: string; resourceMetadata: string } | null {
  if (!wwwAuthenticate) return null;
  const get = (k: string) => wwwAuthenticate.match(new RegExp(`${k}="([^"]+)"`))?.[1];
  if (get('error') !== 'insufficient_user_authentication') return null;
  return {
    acrValues: get('acr_values') ?? 'mfa',
    resourceMetadata: get('resource_metadata') ?? '',
  };
}

/**
 * Build a fetch wrapper that converts an RFC 9470 step-up 401 into a typed
 * StepUpRequiredError before the MCP SDK swallows the headers. Used for the
 * WRITE toolset (mcp-ops). Reads are unprivileged and don't need this.
 */
export function buildStepUpInterceptingFetch(scope: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) {
      const challenge = parseStepUpChallenge(response.headers.get('www-authenticate') ?? undefined);
      if (challenge) {
        await response.body?.cancel().catch(() => undefined);
        throw new StepUpRequiredError({
          acrValues: challenge.acrValues,
          resourceMetadata: challenge.resourceMetadata,
          scope,
        });
      }
    }
    return response;
  };
}
