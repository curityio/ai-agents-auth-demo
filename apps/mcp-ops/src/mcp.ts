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

/**
 * `_meta` key under which a tool publishes the roles a caller needs to CALL it.
 * agentgateway couples `tools/list` visibility to its own MCP-layer authz, so the
 * per-tool role split is enforced downstream (here, `toolRoleDenial`) and every
 * tool stays visible to every ops:write caller. Publishing the rule next to the
 * tool lets the UI say "listed, but not callable for you" from the SAME config
 * value the call-time gate enforces — not from a second copy that could drift.
 * EVERY ops tool carries it (`Config.toolRequiredRoles`), so the card shows the
 * whole matrix — restart/scale: any write role; set image: sre — instead of one
 * badge that reads as an exception. Read by `requiredRolesOf` in
 * packages/agent-runtime (same literal, pinned by tests on both sides).
 * Reverse-DNS prefixed per the MCP `_meta` convention.
 */
export const REQUIRED_ROLES_META = 'io.curity.demo/required-roles';

/** Per-request context: the inbound (validated) Bearer to use as subject_token. */
export interface ToolContext {
  subjectToken: string;
  subjectSub: string;
  /** Caller's `roles` claim (propagated onto every OBO hop by Curity). */
  subjectRoles: string[];
}

/**
 * Per-tool role gate. Returns null when the caller may call `tool` (they hold at
 * least one of `requiredRoles`, or the tool has no requirement), or a
 * human-readable denial reason otherwise.
 *
 * For `set_deployment_image` agentgateway enforces the same split at the front
 * door (an `authorization` deny rule keyed on `Mcp-Name` — see
 * agentgateway-config.yaml), so in practice a non-sre caller is usually refused
 * before reaching here. This check remains the AUTHORITATIVE one: the gateway
 * rule cannot evaluate true when the `roles` claim is absent, so it fails open,
 * and only this one makes the split unconditional. The two must agree — change
 * the required role in both places together. For restart/scale the requirement
 * mirrors Curity's write-tier gate and is normally unreachable (Curity refuses
 * `ops:write` to such a caller at the exchange); it exists so the published
 * `_meta` describes a rule this server really enforces.
 */
export function toolRoleDenial(tool: string, callerRoles: string[], requiredRoles: string[]): string | null {
  if (requiredRoles.length === 0) return null;
  if (requiredRoles.some((r) => callerRoles.includes(r))) return null;
  return (
    `calling ${tool} requires one of these roles: ` +
    `${requiredRoles.join(', ')}; you have: ${callerRoles.length ? callerRoles.join(', ') : '(none)'}`
  );
}

/** The `_meta` block a tool registration publishes, or none when the tool is ungated. */
function requiredRolesMeta(cfg: Config, tool: string): { _meta?: Record<string, unknown> } {
  const roles = cfg.toolRequiredRoles[tool];
  return roles && roles.length > 0 ? { _meta: { [REQUIRED_ROLES_META]: roles } } : {};
}

/**
 * Apply the role gate for `tool` BEFORE the ops-api hop. Returns the isError tool
 * result the agent relays (legible, names the tool — not a silent no-op), or null
 * when the call may proceed.
 */
function roleGate(cfg: Config, ctx: ToolContext, tool: string) {
  const denial = toolRoleDenial(tool, ctx.subjectRoles, cfg.toolRequiredRoles[tool] ?? []);
  if (!denial) return null;
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: 'forbidden', message: denial }, null, 2) }],
    isError: true,
  };
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
      ...requiredRolesMeta(cfg, 'restart_deployment'),
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
          roles: ctx.subjectRoles.join(',') || '(none)',
          deployment: name,
          namespace: ns,
          reason,
        },
      });
      const denied = roleGate(cfg, ctx, 'restart_deployment');
      if (denied) return denied;
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
      ...requiredRolesMeta(cfg, 'set_deployment_image'),
    },
    async ({ name, image, namespace, reason }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-ops', kind: 'RECEIVE', headline: 'MCP tool set_deployment_image',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, acr: summarizeJwt(ctx.subjectToken).acr, roles: ctx.subjectRoles.join(',') || '(none)', deployment: name, image, namespace: ns },
      });
      // Per-tool role gate: image updates are sre-only (default matrix).
      const denied = roleGate(cfg, ctx, 'set_deployment_image');
      if (denied) return denied;
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
      ...requiredRolesMeta(cfg, 'scale_deployment'),
    },
    async ({ name, replicas, namespace, reason }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-ops', kind: 'RECEIVE', headline: 'MCP tool scale_deployment',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, acr: summarizeJwt(ctx.subjectToken).acr, roles: ctx.subjectRoles.join(',') || '(none)', deployment: name, replicas, namespace: ns },
      });
      const denied = roleGate(cfg, ctx, 'scale_deployment');
      if (denied) return denied;
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
