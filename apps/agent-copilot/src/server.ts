import express from 'express';
import { generateText } from 'ai';
import { loadConfig } from './config.js';
import { authMiddleware, type AuthedRequest } from './auth-middleware.js';
import { buildLlm } from './llm.js';
import { obtainMcpToken, invalidateMcpTokenCache, openMcpToolset } from './mcp-client.js';
import {
  obtainSpecialistToken,
  invalidateSpecialistTokenCache,
  callSpecialist,
} from './specialist-client.js';
import { detectIntent } from './intent.js';
import { CurityAuthError, oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { getCimdIdentity } from './cimd-identity.js';
import { spiffeIdHandler } from './spiffe-route.js';
import { lastTokenHandler } from './last-token-route.js';

const SYSTEM_PROMPT = `You are an SRE/DevOps copilot. The user is asking questions about a running Kubernetes cluster.

Rules:
- Use the available tools to fetch concrete data before answering.
- Never invent pod names, log entries, or metrics — always cite tool output.
- If a tool refuses with an authorization error, explain the missing scope/permission to the user rather than retrying blindly.
- Keep answers concise and structured (bullet points or short paragraphs).
- The current user's identity is available in your context; you act on their behalf.`;

async function main(): Promise<void> {
  const cfg = loadConfig();
  const llm = buildLlm(cfg);
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.locals.cfg = cfg;

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, service: 'agent-copilot' });
  });

  // CIMD: publish this agent's Client ID Metadata Document and its JWKS so
  // Curity can dereference the agent's client_id URL at token-exchange time and
  // verify its private_key_jwt assertion. Unauthenticated by design.
  const cimd = await getCimdIdentity(cfg);
  app.get('/.well-known/oauth-client', (_req, res) => {
    res.type('application/json').json(cimd.metadataDocument());
  });
  app.get('/.well-known/jwks.json', (_req, res) => {
    res.type('application/json').json(cimd.jwks());
  });

  // Debug visibility: returns the agent's SPIFFE identity. Gate behind a DEBUG flag.
  app.get('/spiffe-id', (req, res) => {
    void spiffeIdHandler(req, res);
  });

  // Debug visibility: returns decoded inbound user JWT + most recently exchanged OBO JWT.
  app.get('/last-token', authMiddleware(cfg), (req, res) => {
    void lastTokenHandler(req, res);
  });

  app.post('/chat', authMiddleware(cfg), async (req, res) => {
    const authed = req as AuthedRequest;
    const userSub = authed.caller?.payload.sub ?? 'unknown';
    // The exchanged token inherits the user token's acr, so the token-exchange
    // cache must be keyed on it — otherwise a post-step-up (acr=mfa) request
    // reuses the stale pre-step-up token and the step-up loops.
    const userAcr = authed.caller?.payload.acr ?? '';
    const message = (req.body as { message?: unknown }).message;
    if (typeof message !== 'string' || message.trim() === '') {
      res.status(400).json({ error: 'bad_request', error_description: 'message: string required' });
      return;
    }

    // Deterministic intent gate. Privileged actions never reach
    // the LLM — they're explicitly routed to the specialist via A2A. Keeping
    // the gate in code (not in the prompt) means a prompt injection in the
    // user's message can't escalate the call into the privileged path.
    const intent = detectIntent(message);
    oboLog({
      service: 'agent-copilot',
      kind: 'RECEIVE',
      headline: `POST /chat (route: ${intent.kind === 'restart' ? 'privileged-a2a' : 'read-mcp'})`,
      fields: {
        user: userSub,
        scope: [...(authed.caller?.scopes ?? [])].join(' '),
        acr: userAcr,
        message,
        ...(intent.kind === 'restart'
          ? { deployment: intent.deployment, namespace: intent.namespace }
          : {}),
      },
    });
    if (intent.kind === 'restart') {
      try {
        const specialistToken = await obtainSpecialistToken({
          cfg,
          subjectToken: authed.bearerToken!,
          subjectSub: userSub,
          subjectAcr: userAcr,
        });
        const specialistTok = summarizeJwt(specialistToken);
        oboLog({
          service: 'agent-copilot',
          kind: 'CALL',
          headline: '→ A2A agent-specialist (restart_deployment)',
          fields: {
            user: userSub,
            deployment: intent.deployment,
            namespace: intent.namespace,
            reason: intent.reasonHint,
            'token aud': specialistTok.aud,
            'token scope': specialistTok.scope,
            'token act': specialistTok.act,
          },
        });
        let specialistResp;
        try {
          specialistResp = await callSpecialist({
            cfg,
            bearer: specialistToken,
            request: {
              goal: message,
              deployment: intent.deployment,
              namespace: intent.namespace,
              reason: intent.reasonHint,
            },
          });
        } catch (e) {
          invalidateSpecialistTokenCache({ cfg, subjectSub: userSub, subjectAcr: userAcr });
          throw e;
        }
        // Step-up required (e.g. alice without MFA) — RFC 9470 challenge
        if (specialistResp.status === 'step-up' && specialistResp.stepUp) {
          const su = specialistResp.stepUp;
          res
            .status(401)
            .set(
              'WWW-Authenticate',
              `Bearer realm="agent-copilot", error="insufficient_user_authentication", acr_values="${su.acrValues}", resource_metadata="${su.resourceMetadata}"`,
            )
            .json({
              kind: 'step-up',
              acrValues: su.acrValues,
              resourceMetadata: su.resourceMetadata,
              scope: su.scope,
            });
          return;
        }
        // The specialist is an LLM agent: its A2A success payload carries the
        // tool-calling steps (get_deployment → restart/set-image/scale → verify).
        // Surface them as `steps` in the same shape the observe path emits so the
        // web UI's Trace tab renders the privileged run's tool calls too.
        const specialistResult = specialistResp.result as { steps?: unknown } | undefined;
        const steps = Array.isArray(specialistResult?.steps) ? specialistResult.steps : undefined;
        res.json({
          answer: specialistResp.ok
            ? `Restart of '${intent.deployment}' completed.`
            : `Restart of '${intent.deployment}' failed: ${specialistResp.text ?? 'unknown error'}`,
          route: 'privileged-a2a',
          intent: { ...intent },
          ...(steps ? { steps } : {}),
          specialist: specialistResp,
          identity: { sub: userSub, scopes: [...authed.caller!.scopes] },
        });
        return;
      } catch (e) {
        console.error('[agent-copilot] specialist call failed', e);
        if (e instanceof CurityAuthError && e.code === 'access_denied') {
          // Caller lacks the sre role (e.g. bob) — Curity denied the token exchange
          res.status(403).json({ kind: 'access-denied', reason: (e as Error).message });
          return;
        }
        const code = e instanceof CurityAuthError ? e.code : 'specialist_failed';
        res.status(502).json({ error: code, error_description: (e as Error).message });
        return;
      }
    }

    let mcpToken: string;
    try {
      mcpToken = await obtainMcpToken({
        cfg,
        subjectToken: authed.bearerToken!,
        subjectSub: userSub,
        subjectAcr: userAcr,
      });
    } catch (e) {
      console.error('[agent-copilot] token-exchange failed', e);
      const code = e instanceof CurityAuthError ? e.code : 'exchange_failed';
      res.status(403).json({ error: code, error_description: (e as Error).message });
      return;
    }

    let toolset;
    try {
      toolset = await openMcpToolset({
        url: cfg.mcpObservabilityUrl,
        bearerToken: mcpToken,
        clientName: 'agent-copilot',
        label: 'mcp-observability',
      });
    } catch (e) {
      console.error('[agent-copilot] failed to open MCP toolset', e);
      // Invalidate the cached token so the next request forces a fresh exchange
      // (defence against a cached-token-vs-key-rotation race).
      invalidateMcpTokenCache({ cfg, subjectSub: userSub, subjectAcr: userAcr });
      res.status(502).json({ error: 'mcp_unavailable' });
      return;
    }

    try {
      const result = await generateText({
        model: llm,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `User: ${userSub}\n\nQuestion: ${message}` },
        ],
        tools: toolset.tools,
        maxSteps: 6,
      });

      res.json({
        answer: result.text,
        steps: result.steps.map((s) => {
          const calls = s.toolCalls as Array<{ toolName: string; args: unknown }> | undefined;
          const results = s.toolResults as
            | Array<{ toolName: string; result: unknown }>
            | undefined;
          return {
            toolCalls: calls?.map((tc) => ({ name: tc.toolName, args: tc.args })),
            toolResults: results?.map((tr) => ({ name: tr.toolName, result: tr.result })),
            finishReason: s.finishReason,
          };
        }),
        identity: {
          sub: userSub,
          scopes: [...authed.caller!.scopes],
        },
      });
    } catch (e) {
      console.error('[agent-copilot] generation error', e);
      res.status(500).json({ error: 'generation_error', detail: String(e) });
    } finally {
      await toolset.close();
    }
  });

  app.listen(cfg.port, () => {
    console.log(
      JSON.stringify({
        msg: 'agent-copilot listening',
        port: cfg.port,
        llm_provider: cfg.llmProvider,
        llm_model: cfg.llmModel,
        mcp_observability_url: cfg.mcpObservabilityUrl,
      }),
    );
  });
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
