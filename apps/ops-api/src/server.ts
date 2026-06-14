import express from 'express';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { loadConfig } from './config.js';
import { authMiddleware } from './auth-middleware.js';
import { restartDeployment, setDeploymentImage, scaleDeployment } from './ops.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'ops-api' });
  });

  // POST /restart { name, namespace?, reason? } — guarded by full re-validation.
  app.post('/restart', authMiddleware(cfg), async (req, res) => {
    const body = req.body as { name?: string; namespace?: string; reason?: string };
    if (!body?.name || typeof body.name !== 'string') {
      res.status(400).json({ error: 'bad_request', error_description: 'name is required' });
      return;
    }
    const ns = body.namespace ?? cfg.targetNamespace;
    const tok = summarizeJwt((req.header('authorization') ?? '').replace(/^[Bb]earer\s+/, ''));
    oboLog({
      service: 'ops-api',
      kind: 'RECEIVE',
      headline: 'POST /restart',
      fields: { user: tok.sub, scope: tok.scope, acr: tok.acr, act: tok.act, deployment: body.name, namespace: ns },
    });
    try {
      const result = await restartDeployment(body.name, ns, body.reason);
      res.json(result);
    } catch (e: unknown) {
      // K8s client errors carry a `body` with statusCode + message.
      const err = e as { body?: { code?: number; message?: string }; message?: string };
      const code = err.body?.code;
      res.status(code === 403 ? 403 : code === 404 ? 404 : 500).json({
        error: 'restart_failed',
        k8s_code: code,
        message: err.body?.message ?? err.message ?? String(e),
      });
    }
  });

  // POST /set-image { name, image, namespace?, reason? }
  app.post('/set-image', authMiddleware(cfg), async (req, res) => {
    const body = req.body as { name?: string; image?: string; namespace?: string; reason?: string };
    if (!body?.name || typeof body.name !== 'string' || !body?.image || typeof body.image !== 'string') {
      res.status(400).json({ error: 'bad_request', error_description: 'name and image are required' });
      return;
    }
    const ns = body.namespace ?? cfg.targetNamespace;
    const tok = summarizeJwt((req.header('authorization') ?? '').replace(/^[Bb]earer\s+/, ''));
    oboLog({
      service: 'ops-api', kind: 'RECEIVE', headline: 'POST /set-image',
      fields: { user: tok.sub, scope: tok.scope, acr: tok.acr, act: tok.act, deployment: body.name, namespace: ns, image: body.image },
    });
    try {
      res.json(await setDeploymentImage(body.name, ns, body.image, body.reason));
    } catch (e: unknown) {
      const err = e as { body?: { code?: number; message?: string }; message?: string };
      const code = err.body?.code;
      res.status(code === 403 ? 403 : code === 404 ? 404 : 500).json({
        error: 'set_image_failed', k8s_code: code,
        message: err.body?.message ?? err.message ?? String(e),
      });
    }
  });

  // POST /scale { name, replicas, namespace?, reason? }
  app.post('/scale', authMiddleware(cfg), async (req, res) => {
    const body = req.body as { name?: string; replicas?: number; namespace?: string; reason?: string };
    if (!body?.name || typeof body.replicas !== 'number' || body.replicas < 0) {
      res.status(400).json({ error: 'bad_request', error_description: 'name and non-negative replicas are required' });
      return;
    }
    const ns = body.namespace ?? cfg.targetNamespace;
    const tok = summarizeJwt((req.header('authorization') ?? '').replace(/^[Bb]earer\s+/, ''));
    oboLog({
      service: 'ops-api', kind: 'RECEIVE', headline: 'POST /scale',
      fields: { user: tok.sub, scope: tok.scope, acr: tok.acr, act: tok.act, deployment: body.name, namespace: ns, replicas: body.replicas },
    });
    try {
      res.json(await scaleDeployment(body.name, ns, body.replicas, body.reason));
    } catch (e: unknown) {
      const err = e as { body?: { code?: number; message?: string }; message?: string };
      const code = err.body?.code;
      res.status(code === 403 ? 403 : code === 404 ? 404 : 500).json({
        error: 'scale_failed', k8s_code: code,
        message: err.body?.message ?? err.message ?? String(e),
      });
    }
  });

  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        msg: 'ops-api listening',
        port: cfg.port,
        issuer: cfg.curityIssuer,
        audience: cfg.expectedAudience,
        required_scopes: cfg.requiredScopes,
        required_acr: cfg.requiredAcr,
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
