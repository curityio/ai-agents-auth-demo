import { CurityAuthError } from './errors.js';

export interface OidcConfig {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  userinfo_endpoint?: string;
  introspection_endpoint?: string;
  end_session_endpoint?: string;
  scopes_supported?: string[];
  response_types_supported?: string[];
  grant_types_supported?: string[];
}

// Trailing-slash-insensitive issuer match per OIDC discovery convention.
function normalizeIssuer(issuer: string): string {
  return issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
}

const cache = new Map<string, { value: OidcConfig; expiresAt: number }>();
const TTL_MS = 5 * 60_000;

export async function getOidcConfig(
  issuer: string,
  opts: { fetchImpl?: typeof fetch; cacheTtlMs?: number } = {},
): Promise<OidcConfig> {
  const normalized = normalizeIssuer(issuer);
  const ttl = opts.cacheTtlMs ?? TTL_MS;
  const cached = cache.get(normalized);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = `${normalized}/.well-known/openid-configuration`;
  const f = opts.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await f(url, { headers: { accept: 'application/json' } });
  } catch (e) {
    throw new CurityAuthError(`OIDC discovery network error: ${url}`, 'discovery_failed', e);
  }
  if (!res.ok) {
    throw new CurityAuthError(
      `OIDC discovery failed: ${res.status} ${res.statusText}`,
      'discovery_failed',
    );
  }
  const json = (await res.json()) as OidcConfig;
  if (normalizeIssuer(json.issuer) !== normalized) {
    throw new CurityAuthError(
      `Discovery issuer mismatch: expected ${normalized}, got ${json.issuer}`,
      'invalid_issuer',
    );
  }
  cache.set(normalized, { value: json, expiresAt: Date.now() + ttl });
  return json;
}

// Test-only.
export function _clearOidcCache(): void {
  cache.clear();
}
