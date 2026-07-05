import { createServer } from 'node:http';
import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { loadConfig } from './config.js';
import { handleExchange } from './exchange-handler.js';

const cfg = loadConfig();
const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: cfg.svidAudience, filePath: cfg.svidFile }],
});

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  // Read-only workload-identity endpoint (mirrors apps/*/spiffe-route.ts). The shim
  // is co-located in the agentgateway pod and reads the SAME rotating SVID the gateway
  // presents as its actor_token, so this IS agentgateway's workload identity. Exposed
  // to the "Workload identities" panel via a no-auth gateway route (/spiffe-id →
  // localhost:8090); the token-exchange /exchange endpoint is never put on a Service.
  if (req.method === 'GET' && req.url === '/spiffe-id') {
    svidSource
      .getSvid(cfg.svidAudience)
      .then((svid) => {
        if (!svid) {
          res.writeHead(503, { 'content-type': 'application/json' }).end(
            JSON.stringify({ error: 'spiffe_svid_unavailable' }),
          );
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            sub: svid.claims.sub,
            aud: svid.claims.aud,
            iss: svid.claims.iss,
            iat: svid.claims.iat,
            exp: svid.claims.exp,
            ttl_seconds: svid.claims.exp - now,
          }),
        );
      })
      .catch((e) => {
        res.writeHead(500, { 'content-type': 'application/json' }).end(
          JSON.stringify({ error: 'server_error', error_description: (e as Error).message }),
        );
      });
    return;
  }
  // agentgateway's extAuthz HTTP check MIRRORS the original request's method onto
  // the call to this shim. MCP tool-calls are POST, but the OBO-chain introspection
  // walk hits the gateway's /observability|/ops/last-token passthrough with a GET —
  // so the extAuthz check arrives here as `GET /exchange`. Rejecting non-POST made
  // that GET 404 at the shim, which agentgateway surfaced as a 404 DirectResponse on
  // the route (before the backend), silently dropping the mcp→api hops from the chain.
  // The exchange reads only headers (no body), so accept both GET and POST at /exchange.
  if (req.url !== '/exchange' || (req.method !== 'POST' && req.method !== 'GET')) {
    res.writeHead(404).end();
    return;
  }
  const callerAuth = req.headers['x-caller-authorization'];
  const targetAudience = req.headers['x-target-audience'];
  if (typeof callerAuth !== 'string' || typeof targetAudience !== 'string') {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid_request' }));
    return;
  }
  const callerToken = callerAuth.replace(/^Bearer\s+/i, '');
  handleExchange(
    { callerToken, targetAudience },
    {
      getSvidJwt: async () => {
        const svid = await svidSource.getSvid(cfg.svidAudience);
        if (!svid) throw new CurityAuthError(`SVID not available at ${cfg.svidFile}`, 'invalid_actor');
        return svid.jwt;
      },
      exchange: exchangeToken,
      tokenEndpoint: cfg.tokenEndpoint,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      audienceScopes: cfg.audienceScopes,
    },
  )
    .then((body) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    })
    .catch((e) => {
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'exchange_failed', error_description: (e as Error).message }),
      );
    });
});

server.listen(cfg.port, () => console.log(`exchange-shim on :${cfg.port}`));
