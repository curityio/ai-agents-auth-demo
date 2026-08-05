import type { Request, RequestHandler, Response } from 'express';
import { trace } from '@opentelemetry/api';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { buildMcpServer } from './mcp.js';
import type { Config } from './config.js';

/**
 * The MCP Streamable HTTP route, minus authentication — mount it behind
 * `authMiddleware`, which publishes the validated bearer (plus the caller's
 * `roles`) as `req.auth`.
 *
 * Kept separate from `server.ts` so tests can drive the real request path with
 * a stub authenticator instead of a live Curity.
 */
export function buildMcpRequestHandler(cfg: Config): RequestHandler {
  // One factory, called once per HTTP request. A fresh server per request is
  // what keeps the caller's token from outliving its own exchange.
  //
  // `legacy: 'reject'` — 2026-07-28 only. 2025-era callers are refused with an
  // unsupported-protocol-version error rather than served by a fallback. That is
  // a deliberate narrowing: it guarantees every tools/call carries `Mcp-Name`,
  // which the gateway's per-tool authz rules depend on. A fallback would let a
  // caller silently drop to a revision where that header does not exist.
  const handler = createMcpHandler(
    (ctx) => {
      // auth-middleware already validated this token and published it as
      // AuthInfo; reuse it as subject_token for the ops-api exchange.
      const extra = ctx.authInfo?.extra ?? {};
      return buildMcpServer(cfg, {
        subjectToken: ctx.authInfo?.token ?? '',
        subjectSub: String(extra.sub ?? 'unknown'),
        subjectRoles: Array.isArray(extra.roles) ? extra.roles.map(String) : [],
      });
    },
    {
      legacy: 'reject',
      onerror: (e) => console.error('[mcp-ops] handler error', e),
    },
  );
  const nodeHandler = toNodeHandler(handler, {
    onerror: (e) => console.error('[mcp-ops] adapter error', e),
  });

  return (req: Request, res: Response) => {
    // `Mcp-Name` is guaranteed on a 2026-07-28 tools/call, and 2025-era callers
    // never get this far (`legacy: 'reject'`), so no body fallback is needed.
    const body = req.body as { method?: string; params?: { name?: string } } | undefined;
    const toolName = req.header('mcp-name');
    if (body?.method === 'tools/call' && typeof toolName === 'string') {
      trace.getActiveSpan()?.setAttributes({
        'mcp.tool': toolName,
        'mcp.resource_metadata_url': cfg.resourceMetadataUrl,
      });
    }
    // express.json() has already drained the stream, so the parsed body MUST be
    // handed over explicitly — mounting `nodeHandler` directly would pass it
    // express's `next`, which the adapter ignores, leaving it to read nothing.
    void nodeHandler(req, res, req.body);
  };
}
