import express from 'express';
import { trace } from '@opentelemetry/api';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { authMiddleware, type AuthedRequest } from './auth-middleware.js';
import { buildMcpServer } from './mcp.js';
import { resourceMetadataHandler } from './protected-resource-metadata.js';
import { buildLastTokenHandlers } from './last-token-route.js';
import { spiffeIdHandler } from './spiffe-route.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mcp-ops' });
  });

  // Visibility: this MCP's SPIFFE identity (the actor_token it presents when
  // exchanging to ops-api). Surfaced by the web BFF's Workload Identities panel.
  app.get('/spiffe-id', (req, res) => {
    void spiffeIdHandler(req, res);
  });

  // RFC 9728 — must be unauthenticated so that clients that received a
  // step-up 401 can fetch this doc without a token.
  app.get(
    '/.well-known/oauth-protected-resource',
    resourceMetadataHandler({
      resource: cfg.resourceMetadataUrl.replace('/.well-known/oauth-protected-resource', ''),
      authorizationServer: cfg.curityIssuer,
      scopesSupported: ['ops:write'],
      acrValuesSupported: [cfg.requiredAcr],
    }),
  );

  // MCP Streamable HTTP endpoint, guarded by:
  //   1) Curity JWT validity + aud=mcp-ops + scope ops:write
  //   2) act-chain shape (outer=specialist, inner=copilot)
  // Anything that gets past auth-middleware is a real OBO call from the
  // privileged agent chain.
  const mcpRouter = express.Router();
  mcpRouter.use(authMiddleware(cfg));

  mcpRouter.post('/', async (req, res) => {
    try {
      const body = req.body as { method?: string; params?: { name?: string } };
      if (body?.method === 'tools/call' && typeof body.params?.name === 'string') {
        trace.getActiveSpan()?.setAttributes({
          'mcp.tool': body.params.name,
          'mcp.resource_metadata_url': cfg.resourceMetadataUrl,
        });
      }
      // auth-middleware already validated this token; reuse it as subject_token
      // for the ops-api exchange. A fresh server per request means no cross-
      // request token leakage.
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
      console.error('[mcp-ops] request handler error', e);
      if (!res.headersSent) res.status(500).json({ error: 'server_error' });
    }
  });

  app.use('/mcp', mcpRouter);

  // Demo-only: expose the mcp-ops → ops-api hop for the OBO-chain visualization.
  const { authn: lastTokenAuth, handler: lastTokenHandler } = buildLastTokenHandlers(cfg);
  app.get('/last-token', lastTokenAuth, lastTokenHandler);

  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        msg: 'mcp-ops listening',
        port: cfg.port,
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        required_scopes: cfg.requiredScopes,
        target_namespace: cfg.targetNamespace,
        expected_actor_chain: cfg.expectedActorChain.map((re) => re.source),
      }),
    );
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
