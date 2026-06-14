import type { Request, Response, NextFunction } from 'express';
import { CurityAuthError, verifyJwt, decorateSpanWithIdentity, type VerifiedJwt } from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';

export type AuthedRequest = Request & {
  caller?: VerifiedJwt;
  bearerToken?: string;
};

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
      const authed = req as AuthedRequest;
      authed.caller = verified;
      decorateSpanWithIdentity(verified);
      authed.bearerToken = token;
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
