import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { obtainInspectApiToken, callListPods, callGetPodLogs, callGetDeployment } from './inspect-api-client.js';
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
}

export function buildMcpServer(cfg: Config, ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'mcp-inspect',
    version: '0.0.1',
  });

  server.registerTool(
    'list_pods',
    {
      description:
        'List pods in a namespace. Returns name, status, restart count, age, and image.',
      inputSchema: z.object({
        namespace: z
          .string()
          .optional()
          .describe('Kubernetes namespace. Defaults to the demo prod namespace.')
          .meta(X_MCP_HEADER_NAMESPACE),
      }),
    },
    async ({ namespace }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-inspect',
        kind: 'RECEIVE',
        headline: 'MCP tool list_pods',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, namespace: ns },
      });
      try {
        const bearer = await obtainInspectApiToken({ cfg, subjectToken: ctx.subjectToken });
        const pods = await callListPods({ cfg, bearer, namespace: ns });
        return { content: [{ type: 'text', text: JSON.stringify(pods, null, 2) }] };
      } catch (e: unknown) {
        const err = e as { message?: string };
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'list_failed', message: err.message ?? String(e) }, null, 2) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_pod_logs',
    {
      description: 'Fetch recent log entries for a pod by name.',
      inputSchema: z.object({
        pod_name: z.string().describe('Exact pod name (e.g., "order-service-7f6c9d8b6-x4n2p")'),
        namespace: z
          .string()
          .optional()
          .describe('Namespace. Defaults to the demo prod namespace.')
          .meta(X_MCP_HEADER_NAMESPACE),
        tail_lines: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe('Number of recent lines to return (default 50, max 1000)'),
      }),
    },
    async ({ pod_name, namespace, tail_lines }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-inspect',
        kind: 'RECEIVE',
        headline: 'MCP tool get_pod_logs',
        fields: {
          user: ctx.subjectSub,
          act: summarizeJwt(ctx.subjectToken).act,
          pod: pod_name,
          namespace: ns,
          tail_lines: tail_lines ?? 50,
        },
      });
      try {
        const bearer = await obtainInspectApiToken({ cfg, subjectToken: ctx.subjectToken });
        const logs = await callGetPodLogs({
          cfg,
          bearer,
          podName: pod_name,
          namespace: ns,
          tailLines: tail_lines ?? 50,
        });
        return { content: [{ type: 'text', text: JSON.stringify(logs, null, 2) }] };
      } catch (e: unknown) {
        const err = e as { message?: string };
        return {
          content: [
            { type: 'text', text: JSON.stringify({ error: 'logs_failed', message: err.message ?? String(e) }, null, 2) },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'get_deployment',
    {
      description:
        "Get a Deployment's current image, replica count, and ready/updated rollout status.",
      inputSchema: z.object({
        name: z.string().min(1).describe('Deployment name (e.g., "order-service")'),
        namespace: z
          .string()
          .optional()
          .describe('Namespace. Defaults to the demo prod namespace.')
          .meta(X_MCP_HEADER_NAMESPACE),
      }),
    },
    async ({ name, namespace }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-inspect',
        kind: 'RECEIVE',
        headline: 'MCP tool get_deployment',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, deployment: name, namespace: ns },
      });
      try {
        const bearer = await obtainInspectApiToken({ cfg, subjectToken: ctx.subjectToken });
        const dep = await callGetDeployment({ cfg, bearer, name, namespace: ns });
        return { content: [{ type: 'text', text: JSON.stringify(dep, null, 2) }] };
      } catch (e: unknown) {
        const err = e as { message?: string };
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'get_deployment_failed', message: err.message ?? String(e) }, null, 2) }], isError: true };
      }
    },
  );

  return server;
}
