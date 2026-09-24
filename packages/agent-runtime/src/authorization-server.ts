import {
  assertSecureTokenEndpoint,
  discoverAuthorizationServerMetadata,
  type AuthorizationServerMetadata,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';

/**
 * Authorization-server metadata discovery (RFC 8414 / OIDC Discovery), shared by
 * every exchange the agents perform. For MCP hops the issuer comes from the RFC
 * 9728 document (see mcp-oauth-client.ts); for the LLM and A2A hops, which have
 * no MCP server to discover from, it is the configured `CURITY_ISSUER`. Either
 * way the token endpoint is READ from metadata, never configured — one source of
 * truth for where tokens come from.
 *
 * The SDK helper tries the MCP-mandated URL order (RFC 8414 path-insertion, then
 * OIDC path-insertion, then OIDC path-appending) and rejects a document whose
 * `issuer` does not echo the URL it was fetched from.
 */
export interface ResolvedAuthorizationServer {
  issuer: string;
  tokenEndpoint: string;
  metadata: AuthorizationServerMetadata;
}

export const AS_METADATA_TTL_MS = 10 * 60_000;

const cache = new Map<string, { value: ResolvedAuthorizationServer; expiresAt: number }>();

/** Test-only. */
export function _resetAuthorizationServerCache(): void {
  cache.clear();
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * The checks every consumer needs before trusting a metadata document:
 *  - CIMD support advertised (MCP client-registration priority: pre-registered →
 *    CIMD → DCR → prompt; the agents are CIMD ephemeral clients and nothing else,
 *    so an AS without it cannot issue them anything);
 *  - a token endpoint that exists and is HTTPS (SEP-2207 / OAuth 2.1 §1.5).
 */
export function validateAuthorizationServerMetadata(
  metadata: AuthorizationServerMetadata,
): ResolvedAuthorizationServer {
  if (metadata.client_id_metadata_document_supported !== true) {
    throw new CurityAuthError(
      `${metadata.issuer} does not advertise client_id_metadata_document_supported=true; ` +
        'this client can only register via Client ID Metadata Documents',
      'cimd_unsupported',
    );
  }
  if (typeof metadata.token_endpoint !== 'string' || metadata.token_endpoint === '') {
    throw new CurityAuthError(`${metadata.issuer} metadata has no token_endpoint`, 'discovery_failed');
  }
  let tokenUrl: URL;
  try {
    tokenUrl = assertSecureTokenEndpoint(metadata.token_endpoint);
  } catch (e) {
    throw new CurityAuthError(`token_endpoint rejected: ${describe(e)}`, 'discovery_failed', e);
  }
  return { issuer: metadata.issuer, tokenEndpoint: tokenUrl.href, metadata };
}

export async function resolveAuthorizationServer(
  issuer: string,
  opts: { fetchImpl?: FetchLike; force?: boolean } = {},
): Promise<ResolvedAuthorizationServer> {
  const key = issuer.replace(/\/+$/, '');
  if (!key.startsWith('https://')) {
    // RFC 8414 §3 / OAuth 2.1: metadata is fetched over TLS or not at all.
    throw new CurityAuthError(`authorization server ${key} is not https`, 'discovery_failed');
  }
  const hit = cache.get(key);
  if (hit && !opts.force && hit.expiresAt > Date.now()) return hit.value;

  let metadata: AuthorizationServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(key, {
      ...(opts.fetchImpl ? { fetchFn: opts.fetchImpl } : {}),
    });
  } catch (e) {
    // Includes the SDK's IssuerMismatchError: a document that names another issuer
    // is an attack or a misconfiguration, never something to use.
    throw new CurityAuthError(`authorization server metadata for ${key}: ${describe(e)}`, 'discovery_failed', e);
  }
  if (!metadata) {
    throw new CurityAuthError(
      `no authorization server metadata found for ${key} (tried RFC 8414 and OIDC well-known URLs)`,
      'discovery_failed',
    );
  }
  const value = validateAuthorizationServerMetadata(metadata);
  cache.set(key, { value, expiresAt: Date.now() + AS_METADATA_TTL_MS });
  return value;
}
