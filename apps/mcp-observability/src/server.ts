import express from 'express';
import { trace } from '@opentelemetry/api';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { authMiddleware, type AuthedRequest } from './auth-middleware.js';
import { buildMcpServer } from './mcp.js';
import { spiffeIdHandler } from './spiffe-route.js';
import { resourceMetadataHandler } from './protected-resource-metadata.js';
import { buildLastTokenHandlers } from './last-token-route.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mcp-observability' });
  });

  // RFC 9728 — must be unauthenticated; read path requires no step-up so
  // acr_values_supported is intentionally omitted from this document.
  app.get(
    '/.well-known/oauth-protected-resource',
    resourceMetadataHandler({
      resource: cfg.resourceMetadataUrl.replace('/.well-known/oauth-protected-resource', ''),
      authorizationServer: cfg.curityIssuer,
      scopesSupported: cfg.requiredScopes,
    }),
  );

  // Returns the MCP's SPIFFE identity (demo visibility).
  app.get('/spiffe-id', (req, res) => {
    void spiffeIdHandler(req, res);
  });

  // MCP Streamable HTTP endpoint, protected by Curity JWT validation.
  const mcpRouter = express.Router();
  mcpRouter.use(authMiddleware(cfg));

  // Stateless mode: a fresh transport per request. `sessionIdGenerator:
  // undefined` is the SDK's actual stateless switch — with a generator set,
  // the client's two-step handshake (initialize → notifications/initialized)
  // hits two different transports and the second fails with "not initialized".
  mcpRouter.post('/', async (req, res) => {
    try {
      const body = req.body as { method?: string; params?: { name?: string } };
      if (body?.method === 'tools/call' && typeof body.params?.name === 'string') {
        trace.getActiveSpan()?.setAttributes({
          'mcp.tool': body.params.name,
          'mcp.resource_metadata_url':
            'https://mcp-observability.localtest.me/.well-known/oauth-protected-resource',
        });
      }
      const authz = req.header('authorization') ?? '';
      const subjectToken = authz.toLowerCase().startsWith('bearer ')
        ? authz.slice('bearer '.length).trim()
        : '';
      const caller = (req as AuthedRequest).caller;
      const server = buildMcpServer(cfg, {
        subjectToken,
        subjectSub: String(caller?.payload.sub ?? 'unknown'),
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      res.on('close', () => {
        transport.close().catch(() => undefined);
      });
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp-observability] request handler error', e);
      if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    }
  });

  app.use('/mcp', mcpRouter);

  // Demo-only: expose the mcp-observability → obs-api hop for the OBO chain.
  const { authn: lastTokenAuth, handler: lastTokenHandler } = buildLastTokenHandlers(cfg);
  app.get('/last-token', lastTokenAuth, lastTokenHandler);

  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        msg: 'mcp-observability listening',
        port: cfg.port,
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        required_scopes: cfg.requiredScopes,
      }),
    );
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
