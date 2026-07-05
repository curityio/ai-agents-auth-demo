import type { Request, Response, NextFunction } from 'express';
import { verifyJwt, CurityAuthError } from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';
import { peekLastExchange } from './obs-api-client.js';

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
 * Demo-only OBO-chain endpoint. Returns the mcp-observability → obs-api hop
 * (the 3rd RFC 8693 exchange on the read path) so the chain visualization can
 * show the final MCP-to-resource-server leg. Returns a uniform `{ chain }`
 * shape so the copilot aggregator can simply concatenate.
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
      console.error('[mcp-observability/last-token] verify error', e);
      res.status(500).json({ error: 'server_error' });
    }
  };
}

export function buildLastTokenHandlers(cfg: Config): {
  authn: ReturnType<typeof lastTokenAuth>;
  handler: (req: Request, res: Response) => void;
} {
  return {
    authn: lastTokenAuth(cfg),
    handler(req: Request, res: Response) {
      const includeRaw = req.query.raw === '1';
      const chain: Array<{
        hop: string;
        header: Record<string, unknown> | null;
        payload: Record<string, unknown> | null;
        token?: string;
      }> = [];
      // Inbound hop: the aud=mcp-observability token the agentgateway minted for
      // us (via the exchange-shim). Reveals the gateway → mcp leg the caller can't
      // see (that token is minted inside the gateway pod, not by the agent).
      const authz = req.header('authorization') ?? '';
      const inbound = authz.toLowerCase().startsWith('bearer ')
        ? authz.slice('bearer '.length).trim()
        : '';
      if (inbound) {
        chain.push({
          hop: 'agentgateway → mcp-observability',
          header: decodePart(inbound, 0),
          payload: decodePart(inbound, 1),
          ...(includeRaw ? { token: inbound } : {}),
        });
      }
      const last = peekLastExchange();
      if (last) {
        chain.push({
          hop: 'mcp-observability → obs-api',
          header: decodePart(last.accessToken, 0),
          payload: decodePart(last.accessToken, 1),
          // Raw JWT only when explicitly requested (debug inspect).
          ...(includeRaw ? { token: last.accessToken } : {}),
        });
      }
      res.json({ chain });
    },
  };
}
