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

/** Walk an `act` claim outer→inner; stops on the first node missing a string `sub`. */
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

/** True if `chain` matches one of the allowed chains exactly (length + per-position regex). */
export function chainMatchesAny(chain: string[], allowed: RegExp[][]): boolean {
  return allowed.some(
    (expected) =>
      expected.length === chain.length &&
      expected.every((re, i) => re.test(chain[i]!)),
  );
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

      // 3. Chain must match one of the allowed patterns. Unlike ops-api (single
      //    chain, fine-grained length/order/unknown codes), inspect-api accepts
      //    multiple chains, so per-position diagnostics are ambiguous (which
      //    chain was expected?) — we collapse to a single `act_chain` code.
      const chain = walkActChain(top);
      if (!chainMatchesAny(chain, cfg.expectedActorChains)) {
        res
          .status(403)
          .set('www-authenticate', `Bearer error="access_denied", error_description="act_chain"`)
          .json({ error: 'act_chain', error_description: 'actor chain not allowed', chain });
        return;
      }

      // No acr gate — the read path is unprivileged (matches mcp-inspect).
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
      console.error('[inspect-api/auth-middleware] unexpected error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}
