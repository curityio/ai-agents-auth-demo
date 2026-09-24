import { createMcpAuthProvider, type McpAuthProvider } from '@ai-agents-demo/agent-runtime';
import { obtainOpsToken } from './mcp-ops-client.js';
import { obtainObsToken } from './obs-token.js';
import type { Config } from './config.js';

/**
 * The specialist's two MCP client identities. Discovery decides WHERE to
 * exchange and for WHICH scope; the unchanged RFC 8693 helpers decide the rest.
 * The WRITE provider is also where the role gate and the ACR TIA fire (inside
 * `exchange`), so `acquire()` is the same gate `obtainOpsToken` used to be.
 */
export function buildOpsAuthProvider(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  recordLastExchange?: boolean;
}): McpAuthProvider {
  return createMcpAuthProvider({
    serverUrl: opts.cfg.mcpOpsUrl,
    service: 'agent-specialist',
    // Trust boundary: only the issuer this agent already trusts may receive the
    // user's delegated token, whatever the PRM says.
    allowedAuthorizationServers: [opts.cfg.curityIssuer],
    exchange: ({ tokenEndpoint, scope }) =>
      obtainOpsToken({
        cfg: opts.cfg,
        subjectToken: opts.subjectToken,
        subjectSub: opts.subjectSub,
        tokenEndpoint,
        scope,
        ...(opts.recordLastExchange === undefined ? {} : { recordLastExchange: opts.recordLastExchange }),
      }),
  });
}

export function buildObsAuthProvider(opts: { cfg: Config; subjectToken: string }): McpAuthProvider {
  return createMcpAuthProvider({
    serverUrl: opts.cfg.mcpObservabilityUrl,
    service: 'agent-specialist',
    allowedAuthorizationServers: [opts.cfg.curityIssuer],
    exchange: ({ tokenEndpoint, scope }) =>
      obtainObsToken({ cfg: opts.cfg, subjectToken: opts.subjectToken, tokenEndpoint, scope }),
  });
}
