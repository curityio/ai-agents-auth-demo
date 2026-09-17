import express from 'express';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import { verifyJwt, CurityAuthError, decorateSpanWithIdentity } from '@ai-agents-demo/auth-curity';
import { createBearerUserBuilder } from '@ai-agents-demo/a2a-helpers';
import { loadConfig } from './config.js';
import { buildAgentCard } from './agent-card.js';
import { buildExecutor } from './executor.js';
import { buildLastTokenHandlers } from './last-token-route.js';
import { getCimdIdentity } from './cimd-identity.js';
import { spiffeIdHandler } from './spiffe-route.js';
import { buildToolsHandler } from './tools-route.js';

async function main(): Promise<void> {
  const cfg = loadConfig();

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'agent-specialist' });
  });

  // Visibility: this agent's SPIFFE identity (its actor_token in the privileged
  // OBO chain). Surfaced by the web BFF's Workload Identities panel.
  app.get('/spiffe-id', (req, res) => {
    void spiffeIdHandler(req, res);
  });

  // CIMD: publish this agent's Client ID Metadata Document and JWKS so Curity
  // can dereference the agent's client_id URL and verify its private_key_jwt
  // assertion at token-exchange time. Registered before the /.well-known
  // agent-card mount; distinct paths, but explicit ordering avoids surprises.
  const cimd = await getCimdIdentity(cfg);
  app.get('/.well-known/oauth-client', (_req, res) => {
    res.type('application/json').json(cimd.metadataDocument());
  });
  app.get('/.well-known/jwks.json', (_req, res) => {
    res.type('application/json').json(cimd.jwks());
  });

  const agentCard = buildAgentCard(cfg);
  const taskStore = new InMemoryTaskStore();
  const executor = buildExecutor(cfg);
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  // The userBuilder verifies signature, iss, aud at the Express boundary —
  // before any request reaches the agent executor. Failing here surfaces as
  // a JSON-RPC error, which @a2a-js handles cleanly.
  const userBuilder = createBearerUserBuilder({
    verify: async (bearer) => {
      try {
        const v = await verifyJwt(bearer, {
          issuer: cfg.curityIssuer,
          audience: cfg.expectedAudience,
          jwksUri: cfg.curityJwksUri,
        });
        decorateSpanWithIdentity(v);
        return { sub: String(v.payload.sub ?? 'unknown') };
      } catch (e) {
        // Surface the OAuth error code to the JSON-RPC layer.
        if (e instanceof CurityAuthError) throw new Error(`${e.code}: ${e.message}`);
        throw e;
      }
    },
  });

  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: requestHandler }));
  app.use('/a2a', jsonRpcHandler({ requestHandler, userBuilder }));

  // Debug visibility: returns decoded inbound bearer + the most recent token
  // exchange this process performed (i.e. the mcp-ops-bound token whose `act`
  // should be { sub: specialist, act: { sub: copilot } }).
  // Debug-only; gate behind a DEBUG flag before production.
  const { authn: lastTokenAuth, handler: lastTokenHandler } = buildLastTokenHandlers(cfg);
  app.get('/last-token', lastTokenAuth, lastTokenHandler);

  // Debug visibility: what agentgateway's tools/list returns for THIS caller on
  // the write tier — after the same acr pre-check + ops:write exchange a real
  // remediation performs. Feeds the web UI's "MCP Tools Visibility" card.
  app.get('/tools', buildToolsHandler(cfg));

  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        msg: 'agent-specialist listening',
        port: cfg.port,
        audience: cfg.expectedAudience,
        mcp_ops_url: cfg.mcpOpsUrl,
        mcp_ops_audience: cfg.mcpOpsAudience,
        mcp_ops_scope: cfg.mcpOpsScope,
      }),
    );
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
