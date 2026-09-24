import {
  extractWWWAuthenticateParams,
  type AuthorizationServerMetadata,
  type AuthProvider,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { CurityAuthError, oboLog } from '@ai-agents-demo/auth-curity';
import { resolveAuthorizationServer } from './authorization-server.js';

/**
 * Spec-shaped MCP client authorization (MCP 2026-07-28, "Authorization").
 *
 * What is DISCOVERED here, in the spec's order:
 *   1. an unauthenticated request → 401 with WWW-Authenticate
 *   2. `resource_metadata` from that header, else the well-known URLs (path form,
 *      then root) → the RFC 9728 Protected Resource Metadata document
 *   3. `authorization_servers[0]` → RFC 8414 / OIDC metadata (issuer-echo checked
 *      by the SDK), CIMD support required, HTTPS token endpoint required
 *   4. scope: the challenge's `scope`, else `scopes_supported`, else refuse
 *
 * What is NOT discovered: the RFC 8693 `audience` (a logical name, configured
 * per server until Curity accepts RFC 8707 `resource`), and the grant itself —
 * the agents hold a delegated user token and exchange it (packages/auth-curity
 * `exchangeToken`, unchanged); the spec's authorization-code flow needs a browser
 * these workloads do not have. Every failure is a typed CurityAuthError and the
 * agent answers with it; nothing degrades to a configured default.
 */

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  /** Demo-local extension (RFC 9470 step-up), see docs/design.md. */
  acr_values_supported?: string[];
  [k: string]: unknown;
}

export interface McpAuthDiscovery {
  /** The configured server URL, trailing slashes stripped. */
  serverUrl: string;
  /** Where the PRM was actually fetched from. */
  resourceMetadataUrl: string;
  resourceMetadata: ProtectedResourceMetadata;
  /** `authorization_servers[0]`. */
  authorizationServer: string;
  authorizationServerMetadata: AuthorizationServerMetadata;
  tokenEndpoint: string;
  /** Space-joined scope to request. */
  scope: string;
  scopeSource: 'challenge' | 'scopes_supported';
  discoveredAt: number;
}

export const DISCOVERY_TTL_MS = 10 * 60_000;
export const MCP_PROTOCOL_VERSION = '2026-07-28';
const WELL_KNOWN_PRM = '/.well-known/oauth-protected-resource';

const DISCOVERY_CODES = new Set(['discovery_failed', 'resource_mismatch', 'cimd_unsupported', 'scope_unavailable']);

/** True for a failure to LEARN the authorization server; false for a refusal by it. */
export function isDiscoveryFailure(e: unknown): boolean {
  return e instanceof CurityAuthError && DISCOVERY_CODES.has(e.code);
}

const discoveryCache = new Map<string, McpAuthDiscovery>();

/** Test-only. */
export function _resetDiscoveryCache(): void {
  discoveryCache.clear();
}

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** The spec's step 1: an MCP request without a token. Only a 401 is acceptable. */
async function probeUnauthenticated(serverUrl: string, fetchFn: FetchLike): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });
  } catch (e) {
    throw new CurityAuthError(`unauthenticated probe of ${serverUrl} failed: ${describe(e)}`, 'discovery_failed', e);
  }
  if (res.status !== 401) {
    await res.body?.cancel().catch(() => undefined);
    throw new CurityAuthError(
      `unauthenticated probe of ${serverUrl} answered ${res.status}, expected 401 with a WWW-Authenticate challenge`,
      'discovery_failed',
    );
  }
  return res;
}

/** GET one RFC 9728 candidate. 404 → undefined (try the next); anything else non-2xx → throw. */
async function fetchPrm(url: string, fetchFn: FetchLike): Promise<ProtectedResourceMetadata | undefined> {
  const res = await fetchFn(url, {
    headers: { accept: 'application/json', 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const doc = (await res.json()) as unknown;
  if (!doc || typeof doc !== 'object' || typeof (doc as { resource?: unknown }).resource !== 'string') {
    throw new Error(`${url} is not a protected resource metadata document (no string "resource")`);
  }
  return doc as ProtectedResourceMetadata;
}

/**
 * RFC 9728 §3 well-known candidates for a server URL, in the MCP spec's order:
 * path-based first, root second.
 */
export function wellKnownPrmUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const root = `${u.origin}${WELL_KNOWN_PRM}`;
  return path ? [`${u.origin}${WELL_KNOWN_PRM}${path}`, root] : [root];
}

export async function discoverMcpAuthorization(
  serverUrl: string,
  opts: { fetchImpl?: FetchLike; challenge?: Response; force?: boolean; service?: string } = {},
): Promise<McpAuthDiscovery> {
  const key = normalizeUrl(serverUrl);
  const hit = discoveryCache.get(key);
  if (hit && !opts.force && Date.now() - hit.discoveredAt < DISCOVERY_TTL_MS) return hit;

  const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
  const service = opts.service ?? 'mcp-client';

  // 1 + 2a. The challenge, and the metadata URL it names (if any).
  const challenge = opts.challenge ?? (await probeUnauthenticated(key, fetchFn));
  const { resourceMetadataUrl: fromHeader, scope: challengeScope } = extractWWWAuthenticateParams(challenge);
  await challenge.body?.cancel().catch(() => undefined);

  // 2b. The PRM: header URL, else well-known candidates in order.
  const candidates = fromHeader ? [fromHeader.href] : wellKnownPrmUrls(key);
  let prm: ProtectedResourceMetadata | undefined;
  let prmUrl = '';
  for (const url of candidates) {
    try {
      prm = await fetchPrm(url, fetchFn);
    } catch (e) {
      throw new CurityAuthError(`protected resource metadata: ${describe(e)}`, 'discovery_failed', e);
    }
    if (prm) {
      prmUrl = url;
      break;
    }
  }
  if (!prm) {
    throw new CurityAuthError(
      `no protected resource metadata for ${key} (tried ${candidates.join(', ')})`,
      'discovery_failed',
    );
  }

  // 2c. RFC 9728 §3.3: the document must describe THIS server.
  if (normalizeUrl(prm.resource) !== key) {
    throw new CurityAuthError(
      `protected resource metadata at ${prmUrl} describes ${prm.resource}, not ${key}`,
      'resource_mismatch',
    );
  }
  const authorizationServer = prm.authorization_servers?.[0];
  if (!authorizationServer) {
    throw new CurityAuthError(`protected resource metadata at ${prmUrl} lists no authorization_servers`, 'discovery_failed');
  }

  // 3. AS metadata (issuer echo, CIMD flag, HTTPS token endpoint).
  const as = await resolveAuthorizationServer(authorizationServer, { fetchImpl: fetchFn, force: opts.force });

  // 4. Scope selection: challenge first, then scopes_supported, never a default.
  let scope: string | undefined;
  let scopeSource: McpAuthDiscovery['scopeSource'] = 'challenge';
  if (challengeScope && challengeScope.trim() !== '') {
    scope = challengeScope.trim();
  } else if (prm.scopes_supported && prm.scopes_supported.length > 0) {
    scope = prm.scopes_supported.join(' ');
    scopeSource = 'scopes_supported';
  }
  if (!scope) {
    throw new CurityAuthError(
      `neither the 401 challenge nor scopes_supported at ${prmUrl} says which scope to request for ${key}`,
      'scope_unavailable',
    );
  }

  const discovery: McpAuthDiscovery = {
    serverUrl: key,
    resourceMetadataUrl: prmUrl,
    resourceMetadata: prm,
    authorizationServer,
    authorizationServerMetadata: as.metadata,
    tokenEndpoint: as.tokenEndpoint,
    scope,
    scopeSource,
    discoveredAt: Date.now(),
  };
  discoveryCache.set(key, discovery);

  oboLog({
    service,
    kind: 'DISCOVER',
    headline: `→ ${key}`,
    fields: {
      resource_metadata: prmUrl,
      resource: prm.resource,
      'authorization srv': authorizationServer,
      'token endpoint': as.tokenEndpoint,
      'scope selected': `${scope} (from ${scopeSource})`,
      'cimd supported': String(as.metadata.client_id_metadata_document_supported === true),
      'grant types': as.metadata.grant_types_supported?.join(' '),
    },
  });
  return discovery;
}

/**
 * The SDK declares `UnauthorizedContext` ({ response, serverUrl, fetchFn }) but
 * does not export it from the package index (2.0.0), so derive it from the
 * method that receives it.
 */
export type UnauthorizedContext = Parameters<NonNullable<AuthProvider['onUnauthorized']>>[0];

export interface McpExchangeInput {
  tokenEndpoint: string;
  scope: string;
  discovery: McpAuthDiscovery;
}

/**
 * The SDK's minimal auth seam plus two explicit entry points the agents call at
 * the SAME places they used to call `obtainXToken`, so the specialist's gate
 * order (ops exchange → acr pre-check → open toolsets) is unchanged:
 *  - `discover()`  learns the AS without minting (the /tools probe's acr pre-check
 *                  needs the discovered scope + acr_values before any exchange);
 *  - `acquire()`   discover + exchange, stores the token;
 *  - `token()`     what the transport attaches to every request;
 *  - `onUnauthorized()` the transport's 401 hook: forced re-discovery from the
 *                  received challenge, one more exchange, then the SDK retries once.
 * One provider per toolset open: tokens are per subject and must never be shared
 * across users. The discovery cache underneath is process-global.
 */
export interface McpAuthProvider extends AuthProvider {
  discover(): Promise<McpAuthDiscovery>;
  acquire(): Promise<string>;
  current(): { token?: string; discovery?: McpAuthDiscovery };
  token(): Promise<string | undefined>;
  onUnauthorized(ctx: UnauthorizedContext): Promise<void>;
}

export function createMcpAuthProvider(opts: {
  serverUrl: string;
  service: string;
  exchange: (input: McpExchangeInput) => Promise<string>;
  fetchImpl?: FetchLike;
}): McpAuthProvider {
  let token: string | undefined;
  let discovery: McpAuthDiscovery | undefined;

  const discover = async (o: { force?: boolean; challenge?: Response } = {}): Promise<McpAuthDiscovery> => {
    try {
      discovery = await discoverMcpAuthorization(opts.serverUrl, {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        service: opts.service,
        ...o,
      });
      return discovery;
    } catch (e) {
      // The ONE exit every discovery failure crosses (fact #31). Exchange refusals
      // are deliberately not logged here — exchangeToken's own catch already does.
      oboLog({
        service: opts.service,
        kind: 'DENY',
        headline: `→ ${opts.serverUrl} (discovery failed)`,
        fields: {
          error: e instanceof CurityAuthError ? e.code : 'discovery_failed',
          description: e instanceof Error ? e.message : String(e),
        },
      });
      throw e;
    }
  };

  const acquire = async (o: { force?: boolean; challenge?: Response } = {}): Promise<string> => {
    const d = await discover(o);
    token = await opts.exchange({ tokenEndpoint: d.tokenEndpoint, scope: d.scope, discovery: d });
    return token;
  };

  return {
    discover: () => discover(),
    acquire: () => acquire(),
    current: () => ({ token, discovery }),
    token: async () => token,
    onUnauthorized: async ({ response }) => {
      const { error } = extractWWWAuthenticateParams(response);
      if (error === 'insufficient_user_authentication') {
        // RFC 9470: more authentication from the USER, not a fresh token for the
        // agent. Never exchanged, never retried. The specialist's intercepting fetch
        // normally converts this before the transport sees it; this is defence in depth.
        throw new CurityAuthError(
          `step-up required: ${response.headers.get('www-authenticate') ?? ''}`,
          'step_up_required',
        );
      }
      await acquire({ force: true, challenge: response });
    },
  };
}

export type { AuthProvider };
