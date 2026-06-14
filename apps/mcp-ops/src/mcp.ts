import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { obtainOpsApiToken, callOpsApiRestart, callOpsApiSetImage, callOpsApiScale } from './ops-api-client.js';
import type { Config } from './config.js';

/** Per-request context: the inbound (validated) Bearer to use as subject_token. */
export interface ToolContext {
  subjectToken: string;
  subjectSub: string;
}

export function buildMcpServer(cfg: Config, ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'mcp-ops',
    version: '0.0.1',
  });

  server.tool(
    'restart_deployment',
    `Trigger a rolling restart of a Deployment. The backend ops-api enforces ` +
      `that only the '${cfg.targetNamespace}' namespace is reachable; calls into ` +
      `other namespaces will fail with 403 regardless of OBO chain.`,
    {
      name: z.string().min(1).describe('Deployment name (e.g., "order-service")'),
      namespace: z
        .string()
        .optional()
        .describe(
          `Namespace. Defaults to the demo's '${cfg.targetNamespace}' namespace; ` +
            `any other value will be rejected by RBAC.`,
        ),
      reason: z
        .string()
        .max(512)
        .optional()
        .describe('Human-readable reason recorded on the Deployment annotation.'),
    },
    async ({ name, namespace, reason }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-ops',
        kind: 'RECEIVE',
        headline: 'MCP tool restart_deployment',
        fields: {
          user: ctx.subjectSub,
          act: summarizeJwt(ctx.subjectToken).act,
          acr: summarizeJwt(ctx.subjectToken).acr,
          deployment: name,
          namespace: ns,
          reason,
        },
      });
      try {
        // 3rd OBO hop: exchange inbound token → ops-api-bound token, then call ops-api.
        const bearer = await obtainOpsApiToken({ cfg, subjectToken: ctx.subjectToken });
        const result = await callOpsApiRestart({ cfg, bearer, args: { name, namespace: ns, reason } });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (e: unknown) {
        const err = e as { message?: string };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { error: 'restart_failed', message: err.message ?? String(e) },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'set_deployment_image',
    `Update a Deployment's container image to a new version (rolling update). ` +
      `Only the '${cfg.targetNamespace}' namespace is reachable; the container is ` +
      `assumed to share the deployment's name.`,
    {
      name: z.string().min(1).describe('Deployment name (e.g., "order-service")'),
      image: z.string().min(1).describe('Fully-qualified image ref incl. tag (e.g., "ghcr.io/demo/order-service:v1.2")'),
      namespace: z.string().optional().describe(`Namespace. Defaults to '${cfg.targetNamespace}'.`),
      reason: z.string().max(512).optional().describe('Human-readable reason.'),
    },
    async ({ name, image, namespace, reason }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-ops', kind: 'RECEIVE', headline: 'MCP tool set_deployment_image',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, acr: summarizeJwt(ctx.subjectToken).acr, deployment: name, image, namespace: ns },
      });
      try {
        const bearer = await obtainOpsApiToken({ cfg, subjectToken: ctx.subjectToken });
        const result = await callOpsApiSetImage({ cfg, bearer, args: { name, image, namespace: ns, reason } });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const err = e as { message?: string };
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'set_image_failed', message: err.message ?? String(e) }, null, 2) }], isError: true };
      }
    },
  );

  server.tool(
    'scale_deployment',
    `Set the replica count of a Deployment. Only the '${cfg.targetNamespace}' namespace is reachable.`,
    {
      name: z.string().min(1).describe('Deployment name'),
      replicas: z.number().int().min(0).max(20).describe('Desired replica count (0–20)'),
      namespace: z.string().optional().describe(`Namespace. Defaults to '${cfg.targetNamespace}'.`),
      reason: z.string().max(512).optional().describe('Human-readable reason.'),
    },
    async ({ name, replicas, namespace, reason }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-ops', kind: 'RECEIVE', headline: 'MCP tool scale_deployment',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, acr: summarizeJwt(ctx.subjectToken).acr, deployment: name, replicas, namespace: ns },
      });
      try {
        const bearer = await obtainOpsApiToken({ cfg, subjectToken: ctx.subjectToken });
        const result = await callOpsApiScale({ cfg, bearer, args: { name, replicas, namespace: ns, reason } });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e: unknown) {
        const err = e as { message?: string };
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'scale_failed', message: err.message ?? String(e) }, null, 2) }], isError: true };
      }
    },
  );

  return server;
}
