import type { Request, Response, NextFunction } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { CurityAuthError, verifyJwt, decorateSpanWithIdentity, type VerifiedJwt } from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';

export type AuthedRequest = Request & { caller?: VerifiedJwt; auth?: AuthInfo };

/**
 * Build an RFC 6750 `Bearer` challenge. Values are quoted-strings, so an embedded
 * `"` (Curity error text can contain them) is downgraded to `'` rather than
 * terminating the value early and making the header unparseable. Undefined
 * values are omitted so callers can pass optional parts unconditionally.
 */
export function bearerChallenge(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
    .map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`);
  return `Bearer ${parts.join(', ')}`;
}

export function authMiddleware(cfg: Config) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authz = req.header('authorization');
    if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
      res
        .status(401)
        // MCP 2026-07-28 "Authorization Server Discovery": a 401 SHOULD name the
        // RFC 9728 document (`resource_metadata`) and SHOULD say which scopes the
        // resource needs (`scope`), so a client with no prior knowledge can start
        // the discovery chain from this response alone.
        .set(
          'www-authenticate',
          bearerChallenge({
            realm: cfg.expectedAudience,
            scope: cfg.requiredScopes.join(' '),
            resource_metadata: cfg.resourceMetadataUrl,
          }),
        )
        .json({ error: 'invalid_token', error_description: 'missing Bearer token' });
      return;
    }
    const token = authz.slice('bearer '.length).trim();
    try {
      const verified = await verifyJwt(token, {
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        jwksUri: cfg.curityJwksUri,
      });

      // Require an OBO `act` claim; the actor must be a known agent SPIFFE ID.
      const actSub = verified.payload.act?.sub;
      if (!actSub) {
        res
          .status(401)
          .set(
            'www-authenticate',
            bearerChallenge({
              realm: cfg.expectedAudience,
              error: 'invalid_token',
              error_description: 'missing act.sub (OBO required)',
              resource_metadata: cfg.resourceMetadataUrl,
            }),
          )
          .json({ error: 'invalid_token', error_description: 'missing act.sub (OBO required)' });
        return;
      }
      if (!cfg.actorPattern.test(actSub)) {
        res
          .status(403)
          .set('www-authenticate', `Bearer error="access_denied", error_description="actor not allowed"`)
          .json({ error: 'access_denied', error_description: `actor ${actSub} not allowed` });
        return;
      }

      const missing = cfg.requiredScopes.filter((s) => !verified.scopes.has(s));
      if (missing.length > 0) {
        res
          .status(403)
          .set(
            'www-authenticate',
            // MCP 2026-07-28 §"Runtime Insufficient Scope Errors": the challenge
            // SHOULD carry resource_metadata as well, "for consistency with 401
            // responses", so a client can discover the AS from the 403 alone.
            `Bearer error="insufficient_scope", scope="${missing.join(' ')}", ` +
              `resource_metadata="${cfg.resourceMetadataUrl}"`,
          )
          .json({ error: 'insufficient_scope', missing_scopes: missing });
        return;
      }
      (req as AuthedRequest).caller = verified;
      // The MCP SDK never reads credentials from headers itself — it takes them
      // as pass-through `AuthInfo` on `req.auth`, which `toNodeHandler` hands to
      // the per-request server factory. This is the seam that carries the
      // validated bearer forward as the next hop's `subject_token`.
      (req as AuthedRequest).auth = {
        token,
        clientId: String(verified.payload.client_id ?? verified.payload.act?.sub ?? 'unknown'),
        scopes: [...verified.scopes],
        extra: { sub: String(verified.payload.sub ?? 'unknown') },
      };
      decorateSpanWithIdentity(verified);
      next();
    } catch (e: unknown) {
      if (e instanceof CurityAuthError) {
        res
          .status(401)
          // RFC 6750 §3.1 defines only invalid_request / invalid_token /
          // insufficient_scope. Curity's finer code (expired_token, invalid_issuer,
          // …) rides in error_description and stays verbatim in the JSON body.
          .set(
            'www-authenticate',
            bearerChallenge({
              realm: cfg.expectedAudience,
              error: 'invalid_token',
              error_description: `${e.code}: ${e.message}`,
              resource_metadata: cfg.resourceMetadataUrl,
            }),
          )
          .json({ error: e.code, error_description: e.message });
        return;
      }
      console.error('[auth-middleware] unexpected error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}
