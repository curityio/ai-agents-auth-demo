import express from 'express';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { loadConfig } from './config.js';
import { authMiddleware } from './auth-middleware.js';
import { listPods, getPodLogs, getDeployment } from './k8s-ops.js';

/** Decode the inbound Bearer (already validated by auth-middleware) for logging. */
function bearerSummary(req: express.Request) {
  return summarizeJwt((req.header('authorization') ?? '').replace(/^[Bb]earer\s+/, ''));
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'obs-api' });
  });

  const router = express.Router();
  router.use(authMiddleware(cfg));

  // GET /pods?namespace=prod
  router.get('/pods', async (req, res) => {
    const namespace = (req.query.namespace as string | undefined) ?? cfg.targetNamespace;
    const tok = bearerSummary(req);
    oboLog({
      service: 'obs-api',
      kind: 'RECEIVE',
      headline: 'GET /pods',
      fields: { user: tok.sub, scope: tok.scope, act: tok.act, namespace },
    });
    try {
      const pods = await listPods(namespace);
      res.json(pods);
    } catch (e: unknown) {
      const err = e as { body?: { code?: number; message?: string }; message?: string };
      const code = err.body?.code;
      res.status(code === 403 ? 403 : 500).json({
        error: 'list_failed',
        k8s_code: code,
        message: err.body?.message ?? err.message ?? String(e),
      });
    }
  });

  // GET /pods/:name/logs?namespace=prod&tailLines=50
  router.get('/pods/:name/logs', async (req, res) => {
    const namespace = (req.query.namespace as string | undefined) ?? cfg.targetNamespace;
    const tail = Number(req.query.tailLines ?? 50);
    const tailLines = Number.isFinite(tail) ? Math.min(Math.max(1, tail), 1000) : 50;
    const tok = bearerSummary(req);
    oboLog({
      service: 'obs-api',
      kind: 'RECEIVE',
      headline: 'GET /pods/:name/logs',
      fields: { user: tok.sub, scope: tok.scope, act: tok.act, pod: req.params.name, namespace, tailLines },
    });
    try {
      const result = await getPodLogs(req.params.name, namespace, tailLines);
      res.json(result);
    } catch (e: unknown) {
      const err = e as { body?: { code?: number; message?: string }; message?: string };
      const code = err.body?.code;
      res.status(code === 403 ? 403 : code === 404 ? 404 : 500).json({
        error: 'logs_failed',
        k8s_code: code,
        message: err.body?.message ?? err.message ?? String(e),
      });
    }
  });

  // GET /deployments/:name?namespace=prod
  router.get('/deployments/:name', async (req, res) => {
    const namespace = (req.query.namespace as string | undefined) ?? cfg.targetNamespace;
    const tok = bearerSummary(req);
    oboLog({
      service: 'obs-api',
      kind: 'RECEIVE',
      headline: 'GET /deployments/:name',
      fields: { user: tok.sub, scope: tok.scope, act: tok.act, deployment: req.params.name, namespace },
    });
    try {
      res.json(await getDeployment(req.params.name, namespace));
    } catch (e: unknown) {
      const err = e as { body?: { code?: number; message?: string }; message?: string };
      const code = err.body?.code;
      res.status(code === 403 ? 403 : code === 404 ? 404 : 500).json({
        error: 'get_deployment_failed',
        k8s_code: code,
        message: err.body?.message ?? err.message ?? String(e),
      });
    }
  });

  app.use(router);

  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        msg: 'obs-api listening',
        port: cfg.port,
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        required_scopes: cfg.requiredScopes,
        target_namespace: cfg.targetNamespace,
        expected_actor_chains: cfg.expectedActorChains.map((c) => c.map((re) => re.source)),
      }),
    );
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
