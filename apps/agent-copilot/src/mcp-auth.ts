import { createMcpAuthProvider, type McpAuthProvider } from '@ai-agents-demo/agent-runtime';
import { obtainMcpToken } from './mcp-client.js';
import type { Config } from './config.js';

/**
 * The copilot's MCP client identity for the read tier: discovery decides WHERE
 * to exchange and for WHICH scope; `obtainMcpToken` (unchanged RFC 8693 path,
 * cached per subject) decides everything else. One provider per request.
 */
export function buildObservabilityAuthProvider(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  subjectAcr: string;
  recordLastExchange?: boolean;
}): McpAuthProvider {
  return createMcpAuthProvider({
    serverUrl: opts.cfg.mcpObservabilityUrl,
    service: 'agent-copilot',
    exchange: ({ tokenEndpoint, scope }) =>
      obtainMcpToken({
        cfg: opts.cfg,
        subjectToken: opts.subjectToken,
        subjectSub: opts.subjectSub,
        subjectAcr: opts.subjectAcr,
        tokenEndpoint,
        scope,
        ...(opts.recordLastExchange === undefined ? {} : { recordLastExchange: opts.recordLastExchange }),
      }),
  });
}
