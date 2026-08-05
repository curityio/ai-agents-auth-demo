import type { Request, Response, NextFunction } from 'express';
import { CurityAuthError, verifyJwt, decorateSpanWithIdentity, type VerifiedJwt } from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';

export type AuthedRequest = Request & { caller?: VerifiedJwt };

export function authMiddleware(cfg: Config) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authz = req.header('authorization');
    if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
      res
        .status(401)
        .set('www-authenticate', `Bearer realm="${cfg.expectedAudience}"`)
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
          .set('www-authenticate', `Bearer error="invalid_token", error_description="missing act.sub (OBO required)"`)
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
      decorateSpanWithIdentity(verified);
      next();
    } catch (e: unknown) {
      if (e instanceof CurityAuthError) {
        res
          .status(401)
          .set('www-authenticate', `Bearer error="${e.code}", error_description="${e.message}"`)
          .json({ error: e.code, error_description: e.message });
        return;
      }
      console.error('[auth-middleware] unexpected error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}
