import type { Request, Response, NextFunction } from 'express';
import {
  CurityAuthError,
  verifyJwt,
  decorateSpanWithIdentity,
  type VerifiedJwt,
} from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';

export type AuthedRequest = Request & { caller?: VerifiedJwt };

interface ActNode {
  sub?: string;
  act?: ActNode | null;
  [k: string]: unknown;
}

/**
 * Walk an `act` claim outer→inner and return the list of `sub` values.
 * Per RFC 8693 §4.1 the outermost `sub` is the MOST RECENT actor. Stops on the
 * first node missing a string `sub` so a malformed chain can't masquerade.
 */
export function walkActChain(top: unknown): string[] {
  const chain: string[] = [];
  let cur = top as ActNode | null | undefined;
  while (cur && typeof cur === 'object') {
    if (typeof cur.sub !== 'string') return chain;
    chain.push(cur.sub);
    const next = cur.act;
    if (!next || typeof next !== 'object') return chain;
    cur = next;
  }
  return chain;
}

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
      decorateSpanWithIdentity(verified);

      // 1. Required scope.
      const missing = cfg.requiredScopes.filter((s) => !verified.scopes.has(s));
      if (missing.length > 0) {
        res
          .status(403)
          .set('www-authenticate', `Bearer error="insufficient_scope", scope="${missing.join(' ')}"`)
          .json({ error: 'insufficient_scope', missing_scopes: missing });
        return;
      }

      // 2. act required.
      const top = (verified.payload as { act?: unknown }).act;
      if (!top || typeof top !== 'object') {
        res
          .status(403)
          .set('www-authenticate', `Bearer error="access_denied", error_description="act_required"`)
          .json({ error: 'act_required', error_description: 'OBO actor chain missing' });
        return;
      }

      const chain = walkActChain(top);

      // 3. Exact length.
      if (chain.length !== cfg.expectedActorChain.length) {
        res
          .status(403)
          .set(
            'www-authenticate',
            `Bearer error="access_denied", error_description="act_chain_length"`,
          )
          .json({
            error: 'act_chain_length',
            error_description: `expected ${cfg.expectedActorChain.length} actors, got ${chain.length}`,
            chain,
          });
        return;
      }

      // 4. Per-position regex.
      for (let i = 0; i < chain.length; i++) {
        const expected = cfg.expectedActorChain[i]!;
        if (!expected.test(chain[i]!)) {
          const knownInChain = cfg.expectedActorChain.some((re) => re.test(chain[i]!));
          const errCode = knownInChain ? 'act_chain_order' : 'act_chain_unknown';
          res
            .status(403)
            .set(
              'www-authenticate',
              `Bearer error="access_denied", error_description="${errCode}"`,
            )
            .json({ error: errCode, position: i, sub: chain[i]!, chain });
          return;
        }
      }

      // 5. RFC 9470 step-up — leaf token must carry acr=mfa.
      const acr = verified.payload.acr;
      if (acr !== cfg.requiredAcr) {
        const challenge =
          `Bearer realm="${cfg.expectedAudience}", error="insufficient_user_authentication", ` +
          `acr_values="${cfg.requiredAcr}", resource_metadata="${cfg.resourceMetadataUrl}"`;
        res
          .status(401)
          .set('WWW-Authenticate', challenge)
          .json({ error: 'insufficient_user_authentication', required_acr: cfg.requiredAcr });
        return;
      }

      (req as AuthedRequest).caller = verified;
      next();
    } catch (e: unknown) {
      if (e instanceof CurityAuthError) {
        res
          .status(401)
          .set('www-authenticate', `Bearer error="${e.code}", error_description="${e.message}"`)
          .json({ error: e.code, error_description: e.message });
        return;
      }
      console.error('[ops-api/auth-middleware] unexpected error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}
