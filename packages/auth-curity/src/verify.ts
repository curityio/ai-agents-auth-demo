import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { CurityAuthError } from './errors.js';

export interface VerifyJwtOptions {
  /** Issuer URL (typically Curity's base URL or token-issuer URL). */
  issuer: string;
  /** Expected `aud` claim. */
  audience: string;
  /** JWKS URI; if omitted, discovery is performed against `issuer`. */
  jwksUri?: string;
  /** Allowed signing algorithms. Defaults to ['RS256', 'ES256']. */
  algorithms?: string[];
  /** Clock skew tolerance in seconds. */
  clockToleranceSec?: number;
}

export interface VerifiedJwt {
  payload: JWTPayload & {
    scope?: string;
    scp?: string[];
    act?: { sub: string; act?: unknown };
    // Standard OIDC authentication-context-class claim (e.g. 'mfa'). Curity can't
    // declare `acr` as a custom claim definition (reserved name), so it's written
    // procedurally — by the authorization-code token procedure on login and by the
    // token-exchange procedure on each hop. See k8s/curity/procedures/.
    acr?: string;
    azp?: string;
    client_id?: string;
  };
  protectedHeader: { alg: string; kid?: string; typ?: string };
  /** Convenience: scope as a Set, parsed from `scope` (string) or `scp` (array). */
  scopes: Set<string>;
}

// Cache JWKS per URI to amortize key fetches.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(uri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, jwks);
  }
  return jwks;
}

export async function verifyJwt(token: string, opts: VerifyJwtOptions): Promise<VerifiedJwt> {
  if (!opts.jwksUri) {
    throw new CurityAuthError(
      'verifyJwt: jwksUri is required (call getOidcConfig first if you only have the issuer URL)',
      'jwks_failed',
    );
  }
  const jwks = getJwks(opts.jwksUri);
  try {
    const { payload, protectedHeader } = await jwtVerify(token, jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: opts.algorithms ?? ['RS256', 'ES256'],
      clockTolerance: opts.clockToleranceSec ?? 30,
    });
    return {
      payload: payload as VerifiedJwt['payload'],
      protectedHeader: protectedHeader as VerifiedJwt['protectedHeader'],
      scopes: parseScopes(payload as VerifiedJwt['payload']),
    };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('JWTExpired') || msg.includes('"exp"')) {
      throw new CurityAuthError('Token expired', 'expired_token', e);
    }
    if (msg.includes('issuer') || msg.includes('iss')) {
      throw new CurityAuthError(`Invalid issuer: ${msg}`, 'invalid_issuer', e);
    }
    if (msg.includes('audience') || msg.includes('aud')) {
      throw new CurityAuthError(`Invalid audience: ${msg}`, 'invalid_audience', e);
    }
    throw new CurityAuthError(`Token verification failed: ${msg}`, 'invalid_token', e);
  }
}

function parseScopes(payload: VerifiedJwt['payload']): Set<string> {
  if (Array.isArray(payload.scp)) return new Set(payload.scp);
  if (typeof payload.scope === 'string') {
    return new Set(payload.scope.split(' ').filter(Boolean));
  }
  return new Set();
}
