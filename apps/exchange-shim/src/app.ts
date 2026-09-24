import express from 'express';
import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import type { JwtSvid } from '@ai-agents-demo/spiffe';
import { handleExchange } from './exchange-handler.js';
import { ExchangeCache } from './exchange-cache.js';
import type { Config } from './config.js';

export interface AppDeps {
  cfg: Config;
  getSvid: (audience: string) => Promise<JwtSvid | null>;
  exchange: typeof exchangeToken;
}

/**
 * Build the shim's HTTP app.
 *
 * Express, not a bare `node:http` listener, and that is load-bearing for
 * telemetry: `@opentelemetry/instrumentation-http` patches the CJS `http`
 * module, which express reaches through a `require` that require-in-the-middle
 * hooks synchronously at SDK start. A bare ESM `import { createServer } from
 * 'node:http'` depends instead on the ESM hook registration winning a race
 * against the app's own import — it frequently lost, leaving the server
 * unpatched. The symptom is silent and easy to misread: no server span, so
 * nothing calls `propagation.extract`, so the `auth.token_exchange` span this
 * shim emits — the hop that inserts agentgateway into the downstream `act`
 * chain — starts its OWN trace instead of joining the caller's. Do not
 * "simplify" this back to createServer.
 */
export function createApp(deps: AppDeps): express.Express {
  const { cfg } = deps;
  const app = express();
  // One process-wide cache: extAuthz calls this shim once per gateway request, and
  // one MCP question is three requests (server/discover, tools/list, tools/call)
  // carrying the same caller token. See exchange-cache.ts for why reuse is safe.
  const cache =
    cfg.cacheTtlSeconds > 0
      ? new ExchangeCache({ ttlSeconds: cfg.cacheTtlSeconds, maxEntries: cfg.cacheMaxEntries })
      : undefined;

  // No body parser on purpose: the exchange reads headers only, and the
  // extAuthz callout may arrive as a GET with no body at all.

  app.get('/healthz', (_req, res) => {
    res.status(200).send('ok');
  });

  // Read-only workload-identity endpoint (mirrors apps/*/spiffe-route.ts). The shim
  // is co-located in the agentgateway pod and reads the SAME rotating SVID the gateway
  // presents as its actor_token, so this IS agentgateway's workload identity. Exposed
  // to the "Workload identities" panel via a no-auth gateway route (/spiffe-id →
  // localhost:8090); the token-exchange /exchange endpoint is never put on a Service.
  app.get('/spiffe-id', (_req, res) => {
    deps
      .getSvid(cfg.svidAudience)
      .then((svid) => {
        if (!svid) {
          res.status(503).json({ error: 'spiffe_svid_unavailable' });
          return;
        }
        const now = Math.floor(Date.now() / 1000);
        res.status(200).json({
          sub: svid.claims.sub,
          aud: svid.claims.aud,
          iss: svid.claims.iss,
          iat: svid.claims.iat,
          exp: svid.claims.exp,
          ttl_seconds: svid.claims.exp - now,
        });
      })
      .catch((e: unknown) => {
        res.status(500).json({ error: 'server_error', error_description: (e as Error).message });
      });
  });

  // agentgateway's extAuthz HTTP check MIRRORS the original request's method onto
  // the call to this shim. MCP tool-calls are POST, but the OBO-chain introspection
  // walk hits the gateway's /observability|/ops/last-token passthrough with a GET —
  // so the extAuthz check arrives here as `GET /exchange`. Rejecting non-POST made
  // that GET 404 at the shim, which agentgateway surfaced as a 404 DirectResponse on
  // the route (before the backend), silently dropping the mcp→api hops from the chain.
  // The exchange reads only headers (no body), so accept both GET and POST.
  const exchangeHandler: express.RequestHandler = (req, res) => {
    const callerAuth = req.headers['x-caller-authorization'];
    const targetAudience = req.headers['x-target-audience'];
    if (typeof callerAuth !== 'string' || typeof targetAudience !== 'string') {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }
    const callerToken = callerAuth.replace(/^Bearer\s+/i, '');
    handleExchange(
      { callerToken, targetAudience },
      {
        getSvidJwt: async () => {
          const svid = await deps.getSvid(cfg.svidAudience);
          if (!svid) {
            throw new CurityAuthError(`SVID not available at ${cfg.svidFile}`, 'invalid_actor');
          }
          return svid.jwt;
        },
        exchange: deps.exchange,
        tokenEndpoint: cfg.tokenEndpoint,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        audienceScopes: cfg.audienceScopes,
        cache,
      },
    )
      .then((body) => {
        res.status(200).json(body);
      })
      .catch((e: unknown) => {
        res
          .status(403)
          .json({ error: 'exchange_failed', error_description: (e as Error).message });
      });
  };

  app.get('/exchange', exchangeHandler);
  app.post('/exchange', exchangeHandler);

  return app;
}
