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
    // The MCP server names an AS; this agent only ever exchanges with the issuer it
    // already trusts for inbound tokens. Anything else fails closed at discovery.
    allowedAuthorizationServers: [opts.cfg.curityIssuer],
    exchange: ({ tokenEndpoint, scope, forced }) =>
      obtainMcpToken({
        cfg: opts.cfg,
        subjectToken: opts.subjectToken,
        subjectSub: opts.subjectSub,
        subjectAcr: opts.subjectAcr,
        tokenEndpoint,
        scope,
        // A 401 seen by the transport means the cached token is bad: re-mint.
        bypassCache: forced,
        ...(opts.recordLastExchange === undefined ? {} : { recordLastExchange: opts.recordLastExchange }),
      }),
  });
}
