import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { obtainOpsApiToken, callOpsApiRestart, callOpsApiSetImage, callOpsApiScale } from './ops-api-client.js';
import type { Config } from './config.js';

/**
 * SEP-2243: declaring `x-mcp-header` on a tool input property makes a conforming
 * 2026-07-28 client mirror that argument into an `Mcp-Param-Namespace` request
 * header. That lifts the namespace out of the JSON-RPC body and into a header
 * agentgateway can authorize on *before* forwarding — see the `authorization`
 * deny rule in k8s/workloads/agentgateway-config.yaml. The server still reads the
 * argument normally; the header is a mirror, not a replacement.
 */
const X_MCP_HEADER_NAMESPACE = { 'x-mcp-header': 'Namespace' } as const;

/** Per-request context: the inbound (validated) Bearer to use as subject_token. */
export interface ToolContext {
  subjectToken: string;
  subjectSub: string;
  /** Caller's `roles` claim (propagated onto every OBO hop by Curity). */
  subjectRoles: string[];
}

/**
 * Per-tool role gate for `set_deployment_image`. Returns null when the caller may
 * update images, or a human-readable denial reason otherwise.
 *
 * agentgateway now enforces the same split at the front door (an `authorization`
 * deny rule keyed on `Mcp-Name` — see agentgateway-config.yaml), so in practice a
 * non-sre caller is usually refused before reaching here. This check remains the
 * AUTHORITATIVE one: the gateway rule cannot evaluate true when the `roles` claim
 * is absent, so it fails open, and only this one makes the split unconditional.
 * The two must agree — change the required role in both places together.
 */
export function imageRoleDenial(callerRoles: string[], requiredRoles: string[]): string | null {
  if (requiredRoles.some((r) => callerRoles.includes(r))) return null;
  return (
    `updating a deployment image requires one of these roles: ` +
    `${requiredRoles.join(', ')}; you have: ${callerRoles.length ? callerRoles.join(', ') : '(none)'}`
  );
}

export function buildMcpServer(cfg: Config, ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'mcp-ops',
    version: '0.0.1',
  });

  server.registerTool(
    'restart_deployment',
    {
      description:
        `Trigger a rolling restart of a Deployment. The backend ops-api enforces ` +
        `that only the '${cfg.targetNamespace}' namespace is reachable; calls into ` +
        `other namespaces will fail with 403 regardless of OBO chain.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Deployment name (e.g., "order-service")'),
        namespace: z
          .string()
          .optional()
          .describe(
            `Namespace. Defaults to the demo's '${cfg.targetNamespace}' namespace; ` +
              `any other value will be rejected by RBAC.`,
          )
          .meta(X_MCP_HEADER_NAMESPACE),
        reason: z
          .string()
          .max(512)
          .optional()
          .describe('Human-readable reason recorded on the Deployment annotation.'),
      }),
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

  server.registerTool(
    'set_deployment_image',
    {
      description:
        `Update a Deployment's container image to a new version (rolling update). ` +
        `Only the '${cfg.targetNamespace}' namespace is reachable; the container is ` +
        `assumed to share the deployment's name.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Deployment name (e.g., "order-service")'),
        image: z.string().min(1).describe('Fully-qualified image ref incl. tag (e.g., "ghcr.io/demo/order-service:v1.2")'),
        namespace: z
          .string()
          .optional()
          .describe(`Namespace. Defaults to '${cfg.targetNamespace}'.`)
          .meta(X_MCP_HEADER_NAMESPACE),
        reason: z.string().max(512).optional().describe('Human-readable reason.'),
      }),
    },
    async ({ name, image, namespace, reason }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-ops', kind: 'RECEIVE', headline: 'MCP tool set_deployment_image',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, acr: summarizeJwt(ctx.subjectToken).acr, roles: ctx.subjectRoles.join(',') || '(none)', deployment: name, image, namespace: ns },
      });
      // Per-tool role gate: image updates are sre-only. Deny BEFORE the ops-api
      // hop and return a legible message the agent relays (not a silent no-op).
      const denial = imageRoleDenial(ctx.subjectRoles, cfg.setImageRequiredRoles);
      if (denial) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'forbidden', message: denial }, null, 2) }],
          isError: true,
        };
      }
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

  server.registerTool(
    'scale_deployment',
    {
      description: `Set the replica count of a Deployment. Only the '${cfg.targetNamespace}' namespace is reachable.`,
      inputSchema: z.object({
        name: z.string().min(1).describe('Deployment name'),
        replicas: z.number().int().min(0).max(20).describe('Desired replica count (0–20)'),
        namespace: z
          .string()
          .optional()
          .describe(`Namespace. Defaults to '${cfg.targetNamespace}'.`)
          .meta(X_MCP_HEADER_NAMESPACE),
        reason: z.string().max(512).optional().describe('Human-readable reason.'),
      }),
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
