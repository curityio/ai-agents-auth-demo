import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { obtainObsApiToken, callListPods, callGetPodLogs, callGetDeployment } from './obs-api-client.js';
import type { Config } from './config.js';

/** Per-request context: the inbound (validated) Bearer to use as subject_token. */
export interface ToolContext {
  subjectToken: string;
  subjectSub: string;
}

export function buildMcpServer(cfg: Config, ctx: ToolContext): McpServer {
  const server = new McpServer({
    name: 'mcp-observability',
    version: '0.0.1',
  });

  server.tool(
    'list_pods',
    'List pods in a namespace. Returns name, status, restart count, age, and image.',
    {
      namespace: z
        .string()
        .optional()
        .describe('Kubernetes namespace. Defaults to the demo prod namespace.'),
    },
    async ({ namespace }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-observability',
        kind: 'RECEIVE',
        headline: 'MCP tool list_pods',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, namespace: ns },
      });
      try {
        const bearer = await obtainObsApiToken({ cfg, subjectToken: ctx.subjectToken });
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

  server.tool(
    'get_pod_logs',
    'Fetch recent log entries for a pod by name.',
    {
      pod_name: z.string().describe('Exact pod name (e.g., "order-service-7f6c9d8b6-x4n2p")'),
      namespace: z.string().optional().describe('Namespace. Defaults to the demo prod namespace.'),
      tail_lines: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe('Number of recent lines to return (default 50, max 1000)'),
    },
    async ({ pod_name, namespace, tail_lines }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-observability',
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
        const bearer = await obtainObsApiToken({ cfg, subjectToken: ctx.subjectToken });
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

  server.tool(
    'get_deployment',
    'Get a Deployment\'s current image, replica count, and ready/updated rollout status.',
    {
      name: z.string().min(1).describe('Deployment name (e.g., "order-service")'),
      namespace: z.string().optional().describe('Namespace. Defaults to the demo prod namespace.'),
    },
    async ({ name, namespace }) => {
      const ns = namespace ?? cfg.targetNamespace;
      oboLog({
        service: 'mcp-observability',
        kind: 'RECEIVE',
        headline: 'MCP tool get_deployment',
        fields: { user: ctx.subjectSub, act: summarizeJwt(ctx.subjectToken).act, deployment: name, namespace: ns },
      });
      try {
        const bearer = await obtainObsApiToken({ cfg, subjectToken: ctx.subjectToken });
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
