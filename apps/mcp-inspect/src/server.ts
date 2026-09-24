import express from 'express';
import { loadConfig } from './config.js';
import { authMiddleware } from './auth-middleware.js';
import { buildMcpRequestHandler } from './mcp-http.js';
import { spiffeIdHandler } from './spiffe-route.js';
import { resourceMetadataHandler } from './protected-resource-metadata.js';
import { buildLastTokenHandlers } from './last-token-route.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'mcp-inspect' });
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

  mcpRouter.post('/', buildMcpRequestHandler(cfg));

  app.use('/mcp', mcpRouter);

  // Demo-only: expose the mcp-inspect → inspect-api hop for the OBO chain.
  const { authn: lastTokenAuth, handler: lastTokenHandler } = buildLastTokenHandlers(cfg);
  app.get('/last-token', lastTokenAuth, lastTokenHandler);

  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        msg: 'mcp-inspect listening',
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
