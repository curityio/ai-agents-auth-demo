import type { Request, Response, NextFunction } from 'express';
import { verifyJwt, CurityAuthError } from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';
import { peekLastExchange, type LastExchange } from './ops-api-client.js';

/** Decode a JWT segment (0 = header, 1 = payload) without verifying. */
function decodePart(token: string, idx: number): Record<string, unknown> | null {
  const part = token.split('.')[idx];
  if (!part) return null;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Demo-only OBO-chain endpoint. Returns the mcp-ops → ops-api hop (the 3rd
 * RFC 8693 exchange) so the chain visualization can show the final
 * MCP-to-resource-server leg. Mirrors agent-specialist's /last-token, but
 * returns a uniform `{ chain }` shape so callers can simply concatenate.
 *
 * Authenticated by the same mcp-ops-bound token the caller used for /mcp —
 * verifying issuer + aud is enough here (this is a read-only debug view).
 */
function lastTokenAuth(cfg: Config) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authz = req.header('authorization');
    if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
      res.status(401).json({ error: 'invalid_token' });
      return;
    }
    const token = authz.slice('bearer '.length).trim();
    try {
      await verifyJwt(token, {
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        jwksUri: cfg.curityJwksUri,
      });
      next();
    } catch (e) {
      if (e instanceof CurityAuthError) {
        res.status(401).json({ error: e.code, error_description: e.message });
        return;
      }
      console.error('[mcp-ops/last-token] verify error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}

export interface ChainHop {
  hop: string;
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  /** Raw JWT — only when the caller asked for `?raw=1` (debug inspect). */
  token?: string;
}

/**
 * The two rows this server contributes, BOTH taken from the last real tool
 * call: the inbound aud=mcp-ops token the agentgateway minted for it (via the
 * exchange-shim — the leg the agent can't see), then the ops-api token we
 * exchanged it for. Pure, so the rule "never the request's own bearer" is
 * testable: the /last-token request travels through the gateway too, and its
 * bearer is a token minted for the walk, not for the flow.
 */
export function buildChain(last: LastExchange | undefined, includeRaw: boolean): ChainHop[] {
  if (!last) return [];
  const hop = (name: string, token: string): ChainHop => ({
    hop: name,
    header: decodePart(token, 0),
    payload: decodePart(token, 1),
    ...(includeRaw ? { token } : {}),
  });
  return [
    hop('agentgateway → mcp-ops', last.subjectToken),
    hop('mcp-ops → ops-api', last.accessToken),
  ];
}

export function buildLastTokenHandlers(cfg: Config): {
  authn: ReturnType<typeof lastTokenAuth>;
  handler: (req: Request, res: Response) => void;
} {
  return {
    authn: lastTokenAuth(cfg),
    handler(req: Request, res: Response) {
      res.json({ chain: buildChain(peekLastExchange(), req.query.raw === '1') });
    },
  };
}
