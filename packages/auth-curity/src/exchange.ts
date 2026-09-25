import { randomUUID } from 'node:crypto';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { importPKCS8, SignJWT } from 'jose';
import { CurityAuthError, type CurityAuthErrorCode } from './errors.js';
import { oboLog, summarizeJwt } from './obo-log.js';
import { buildExchangeAttributes } from './exchange-span.js';

/** Friendly caller label for OBO logs: CIMD URL → agent name; else the raw id. */
function callerLabel(clientId: string): string {
  const m = /^https:\/\/([^.]+)\./.exec(clientId);
  return m ? `agent-${m[1]}` : clientId;
}

const tracer = trace.getTracer('auth-curity');

/**
 * How the client authenticates to Curity's token endpoint.
 * - `basic`: HTTP Basic auth with `clientId:clientSecret` (confidential static clients).
 * - `private_key_jwt`: RFC 7523 signed client assertion (CIMD ephemeral clients) — no shared secret.
 */
export type ClientAuth =
  | { method: 'basic' }
  | {
      method: 'private_key_jwt';
      /** PKCS8 PEM private key used to sign the client assertion. */
      privateKeyPkcs8Pem: string;
      /** `kid` of the published public JWK; goes in the assertion header. */
      kid: string;
      /** Defaults to RS256. */
      signingAlg?: 'RS256';
      /** Assertion `aud` — must equal Curity's token endpoint URL. */
      assertionAudience: string;
    };

export interface ExchangeTokenParams {
  tokenEndpoint: string;
  clientId: string;
  /** Required for Basic auth (default); omit when using `clientAuth: { method: 'private_key_jwt' }`. */
  clientSecret?: string;
  /** Client authentication strategy. Defaults to Basic auth using clientId/clientSecret. */
  clientAuth?: ClientAuth;
  subjectToken: string;
  /** SPIFFE JWT-SVID in compact form. */
  actorToken: string;
  /** Target audience (single string; Curity will reject if not on this client's allow-list). */
  audience: string;
  /** Space-separated scope string. */
  scope: string;
  /** Defaults to RFC 8693 access_token. */
  subjectTokenType?: string;
  /** Defaults to RFC 8693 JWT. */
  actorTokenType?: string;
  /** Defaults to RFC 8693 access_token. */
  requestedTokenType?: string;
}

export interface ExchangeTokenResult {
  accessToken: string;
  tokenType: string;
  expiresInSec: number;
  scope: string;
  issuedTokenType: string;
}

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const TT_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';
const TT_JWT = 'urn:ietf:params:oauth:token-type:jwt';

interface OauthErrorBody {
  error?: string;
  error_description?: string;
}

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

const ERROR_MAP: Record<string, CurityAuthErrorCode> = {
  invalid_scope: 'invalid_scope',
  invalid_grant: 'invalid_grant',
  access_denied: 'access_denied',
  invalid_client: 'invalid_client',
};

export async function exchangeToken(params: ExchangeTokenParams): Promise<ExchangeTokenResult> {
  return tracer.startActiveSpan(
    'auth.token_exchange',
    { attributes: buildExchangeAttributes(params) },
    async (span) => {
      try {
        const result = await doExchange(params);
        span.setAttribute('auth.exchange.issued_scope', result.scope);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (e) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message });
        span.recordException(e as Error);
        // Log here rather than at each `throw` in doExchange: this is the one
        // point every failure path passes through (refusal, unreachable
        // endpoint, malformed body), and it is inside the active span, so the
        // DENY line carries the same trace/span ids as the attempt.
        logDenial(params, e);
        throw e;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Emit the DENY counterpart of the EXCHANGE block. Deliberately mirrors that
 * block's fields so the two read side by side in `kubectl logs`, with the
 * granted scope replaced by why nothing was granted.
 */
function logDenial(params: ExchangeTokenParams, e: unknown): void {
  const subj = summarizeJwt(params.subjectToken);
  const actor = summarizeJwt(params.actorToken);
  oboLog({
    service: callerLabel(params.clientId),
    kind: 'DENY',
    headline: `→ ${params.audience}`,
    fields: {
      client_id: params.clientId,
      'subject (sub)': subj.sub,
      'subject act': subj.act,
      'actor (spiffe)': actor.sub,
      'scope req': params.scope,
      error: e instanceof CurityAuthError ? e.code : 'exchange_failed',
      reason: (e as Error).message,
    },
  });
}

async function doExchange(params: ExchangeTokenParams): Promise<ExchangeTokenResult> {
  const body = new URLSearchParams({
    grant_type: GRANT_TYPE,
    subject_token: params.subjectToken,
    subject_token_type: params.subjectTokenType ?? TT_ACCESS_TOKEN,
    actor_token: params.actorToken,
    actor_token_type: params.actorTokenType ?? TT_JWT,
    requested_token_type: params.requestedTokenType ?? TT_ACCESS_TOKEN,
    audience: params.audience,
    scope: params.scope,
  });

  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };

  const clientAuth = params.clientAuth ?? { method: 'basic' };
  if (clientAuth.method === 'private_key_jwt') {
    // CIMD ephemeral client: prove control of the published key with a short-lived
    // signed assertion (RFC 7523). client_id travels in the body, not a Basic header.
    body.set('client_id', params.clientId);
    body.set('client_assertion_type', CLIENT_ASSERTION_TYPE);
    body.set('client_assertion', await buildClientAssertion(params.clientId, clientAuth));
  } else {
    headers.authorization =
      'Basic ' + Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');
  }

  let response: Response;
  try {
    response = await fetch(params.tokenEndpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
  } catch (e) {
    throw new CurityAuthError(
      `token-exchange fetch failed: ${(e as Error).message}`,
      'exchange_failed',
      e,
    );
  }

  if (response.ok) {
    let json: {
      access_token: string;
      token_type?: string;
      expires_in?: number;
      scope?: string;
      issued_token_type?: string;
    };
    try {
      json = (await response.json()) as typeof json;
    } catch (e) {
      throw new CurityAuthError(
        `token-exchange returned malformed JSON: ${(e as Error).message}`,
        'exchange_failed',
        e,
      );
    }
    const subj = summarizeJwt(params.subjectToken);
    const actor = summarizeJwt(params.actorToken);
    oboLog({
      service: callerLabel(params.clientId),
      kind: 'EXCHANGE',
      headline: `→ ${params.audience}`,
      fields: {
        client_id: params.clientId,
        'subject (sub)': subj.sub,
        'subject act': subj.act,
        'actor (spiffe)': actor.sub,
        'scope req': params.scope,
        'scope issued': json.scope ?? params.scope,
      },
    });
    return {
      accessToken: json.access_token,
      tokenType: json.token_type ?? 'Bearer',
      expiresInSec: json.expires_in ?? 0,
      scope: json.scope ?? params.scope,
      issuedTokenType: json.issued_token_type ?? TT_ACCESS_TOKEN,
    };
  }

  // Non-OK: try to parse an RFC 6749 error body.
  let parsed: OauthErrorBody = {};
  try {
    parsed = (await response.json()) as OauthErrorBody;
  } catch {
    // ignore; we'll fall through to a generic error
  }

  const oauthError = parsed.error;
  if (oauthError && oauthError in ERROR_MAP) {
    throw new CurityAuthError(
      parsed.error_description ?? oauthError,
      ERROR_MAP[oauthError]!,
    );
  }
  if (oauthError === 'invalid_request' && /actor/i.test(parsed.error_description ?? '')) {
    throw new CurityAuthError(parsed.error_description ?? 'invalid actor_token', 'invalid_actor');
  }
  // Curity sanitizes procedure-thrown NON-validation errors: a `fail('access_denied', msg)`
  // inside a token procedure surfaces over the wire as `error=invalid_request` with the
  // original code PREFIXED into the description (Curity server log: "Removing non-validation
  // error from JSON response."). Without this branch the role-gate denial would degrade to a
  // generic `exchange_failed` (HTTP 502) instead of the intended clean `access_denied` (403).
  // The smoke test tolerates the same sanitization shape.
  if (oauthError === 'invalid_request' && /access_denied/i.test(parsed.error_description ?? '')) {
    throw new CurityAuthError(parsed.error_description ?? 'access_denied', 'access_denied');
  }
  // Same sanitization as access_denied: procedure `fail('invalid_scope', msg)` surfaces as
  // `error=invalid_request` with `invalid_scope` prefixed into the description.
  if (oauthError === 'invalid_request' && /invalid_scope/i.test(parsed.error_description ?? '')) {
    throw new CurityAuthError(parsed.error_description ?? 'invalid_scope', 'invalid_scope');
  }
  throw new CurityAuthError(
    'token-exchange failed: HTTP ' +
      response.status +
      (parsed.error ? ' ' + parsed.error : '') +
      (parsed.error_description ? ': ' + parsed.error_description : ''),
    'exchange_failed',
  );
}

async function buildClientAssertion(
  clientId: string,
  auth: Extract<ClientAuth, { method: 'private_key_jwt' }>,
): Promise<string> {
  const alg = auth.signingAlg ?? 'RS256';
  let key;
  try {
    key = await importPKCS8(auth.privateKeyPkcs8Pem, alg);
  } catch (e) {
    throw new CurityAuthError(
      `failed to import client signing key: ${(e as Error).message}`,
      'invalid_client',
      e,
    );
  }
  // RFC 7523 §2.2 / OIDC private_key_jwt: iss=sub=client_id, aud=token endpoint, short-lived.
  return new SignJWT({})
    .setProtectedHeader({ alg, kid: auth.kid })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(auth.assertionAudience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime('60s')
    .sign(key);
}
