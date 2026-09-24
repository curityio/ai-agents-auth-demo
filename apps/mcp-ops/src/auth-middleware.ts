import type { Request, Response, NextFunction } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import {
  CurityAuthError,
  verifyJwt,
  decorateSpanWithIdentity,
  type VerifiedJwt,
} from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';

export type AuthedRequest = Request & { caller?: VerifiedJwt; auth?: AuthInfo };

/**
 * Normalise Curity's `roles` claim, which arrives as an array on some hops and
 * a space-delimited string on others, into a plain list.
 */
export function readRoles(payload: unknown): string[] {
  const raw = (payload as { roles?: unknown } | undefined)?.roles;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/\s+/).filter(Boolean);
  return [];
}

interface ActNode {
  sub?: string;
  act?: ActNode | null;
  [k: string]: unknown;
}

/**
 * Walk an `act` claim outer→inner and return the list of `sub` values.
 *
 * Per RFC 8693 §4.1, the outermost `sub` is the MOST RECENT actor and each
 * nested `act` represents the next-oldest. Stops on the first node missing a
 * string `sub` so a malformed chain doesn't masquerade as a longer one.
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

/**
 * Build an RFC 6750 `Bearer` challenge. Values are quoted-strings, so an embedded
 * `"` is downgraded to `'` rather than ending the value early. Undefined values
 * are omitted.
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
        // MCP 2026-07-28 discovery: name the RFC 9728 document and the scope this
        // resource needs, so a client can start the chain from this 401 alone.
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

      decorateSpanWithIdentity(verified);

      // 1. Required scope check (ops:write).
      const missing = cfg.requiredScopes.filter((s) => !verified.scopes.has(s));
      if (missing.length > 0) {
        res
          .status(403)
          .set(
            'www-authenticate',
            // MCP 2026-07-28 §"Runtime Insufficient Scope Errors": the challenge
            // SHOULD carry resource_metadata as well, "for consistency with 401
            // responses". The step-up 401 below already does.
            `Bearer error="insufficient_scope", scope="${missing.join(' ')}", ` +
              `resource_metadata="${cfg.resourceMetadataUrl}"`,
          )
          .json({ error: 'insufficient_scope', missing_scopes: missing });
        return;
      }

      // 2. act claim is required for any mcp-ops call (no direct user invocation).
      const top = (verified.payload as { act?: unknown }).act;
      if (!top || typeof top !== 'object') {
        res
          .status(403)
          .set('www-authenticate', `Bearer error="access_denied", error_description="act_required"`)
          .json({ error: 'act_required', error_description: 'OBO actor chain missing' });
        return;
      }

      const chain = walkActChain(top);

      // 3. Length check — must match the expected ordering exactly.
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

      // 4. Per-position regex match. Catches both unknown actors and
      //    out-of-order chains (e.g. specialist on the inside).
      for (let i = 0; i < chain.length; i++) {
        const expected = cfg.expectedActorChain[i]!;
        if (!expected.test(chain[i]!)) {
          // Distinguish "wrong actor at this position" (chain_order) from
          // "actor we've never seen" (chain_unknown) by checking whether the
          // sub satisfies ANY position in the expected chain.
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

      // 5. RFC 9470 step-up: the leaf token must carry the required acr.
      // Standard OIDC `acr` claim (written procedurally by Curity — see
      // packages/auth-curity verify.ts and k8s/curity/procedures/).
      const acr = verified.payload.acr;
      // Exact match only — a more expressive acr (e.g. 'phishing-resistant') is NOT
      // accepted here; Curity is configured to emit exactly 'mfa' on step-up.
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
      // The MCP SDK never reads credentials from headers itself — it takes them
      // as pass-through `AuthInfo` on `req.auth`, which `toNodeHandler` hands to
      // the per-request server factory. `roles` rides along in `extra` because
      // the factory has no access to the express request, and the
      // `set_deployment_image` gate needs it before the ops-api hop.
      (req as AuthedRequest).auth = {
        token,
        clientId: String(verified.payload.client_id ?? chain[0] ?? 'unknown'),
        scopes: [...verified.scopes],
        extra: {
          sub: String(verified.payload.sub ?? 'unknown'),
          roles: readRoles(verified.payload),
        },
      };
      next();
    } catch (e: unknown) {
      if (e instanceof CurityAuthError) {
        res
          .status(401)
          // RFC 6750 §3.1: the header code is invalid_token; Curity's finer code
          // (expired_token, invalid_issuer, …) rides in error_description and
          // stays verbatim in the JSON body.
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
      console.error('[mcp-ops/auth-middleware] unexpected error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}
