export interface Config {
  port: number;
  curityIssuer: string;
  /**
   * MCP authorization discovery reuse window (ms). From MCP_DISCOVERY_TTL_SECONDS;
   * the code default is 10 min, the demo manifests set 0 so EVERY question runs
   * 401 → RFC 9728 → RFC 8414 and the trace/OBO log show it (fact #37).
   */
  mcpDiscoveryTtlMs: number;
  /**
   * Reuse window (ms) for this agent's RFC 8693 exchange caches (MCP, LLM, A2A
   * tokens). From TOKEN_EXCHANGE_CACHE_TTL_SECONDS; code default 60 s, the demo
   * manifests set 0 so EVERY question shows its exchanges in the trace and OBO
   * log — with 60 s a second question within a minute showed none (fact #37).
   */
  exchangeCacheTtlMs: number;
  curityJwksUri: string;
  expectedAudience: string;
  mcpInspectUrl: string;
  /** CIMD client_id — the HTTPS URL Curity dereferences to fetch this agent's metadata. */
  agentClientId: string;
  /** PKCS8 PEM private key used to sign the private_key_jwt client assertion. */
  agentPrivateKeyPem: string;
  /**
   * RFC 8693 `audience` for the MCP hop. The ONE per-server value that stays
   * configured: everything else about the hop (authorization server, token
   * endpoint, scope) is discovered from the server's 401 → RFC 9728 → RFC 8414
   * chain (packages/agent-runtime mcp-oauth-client.ts). It would be replaced by
   * the RFC 8707 `resource` parameter once Curity accepts it.
   */
  mcpInspectAudience: string;
  // A2A path to agent-specialist for privileged actions.
  // The intent router in server.ts decides when to use this.
  specialistA2aUrl: string;
  specialistAudience: string;
  specialistScope: string;
  /** Base URL of the agentgateway LLM route. */
  llmGatewayUrl: string;
  /** RFC 8693 exchange audience for the gateway LLM route. */
  llmGatewayAudience: string;
  /** RFC 8693 exchange scope for the gateway LLM route. */
  llmGatewayScope: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function discoveryTtlMs(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 10 * 60_000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`MCP_DISCOVERY_TTL_SECONDS must be a non-negative integer, got ${raw}`);
  return n * 1000;
}

function secondsEnvToMs(name: string, defaultSeconds: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultSeconds * 1000;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n * 1000;
}

export function loadConfig(): Config {
  const cfg: Config = {
    port: Number(process.env.PORT ?? 8081),
    curityIssuer: required('CURITY_ISSUER'),
    curityJwksUri: required('CURITY_JWKS_URI'),
    expectedAudience: process.env.EXPECTED_AUDIENCE ?? 'agent-copilot',
    mcpInspectUrl: required('MCP_INSPECT_URL'),
    mcpDiscoveryTtlMs: discoveryTtlMs(process.env.MCP_DISCOVERY_TTL_SECONDS),
    exchangeCacheTtlMs: secondsEnvToMs('TOKEN_EXCHANGE_CACHE_TTL_SECONDS', 60),
    agentClientId:
      process.env.CURITY_CLIENT_ID ?? 'https://copilot.localtest.me/.well-known/oauth-client',
    agentPrivateKeyPem: required('CURITY_AGENT_PRIVATE_KEY_PEM'),
    mcpInspectAudience: process.env.MCP_INSPECT_AUDIENCE ?? 'mcp-inspect',
    specialistA2aUrl:
      process.env.SPECIALIST_A2A_URL ??
      'http://agent-specialist.agents.svc.cluster.local:8082/a2a',
    specialistAudience: process.env.SPECIALIST_AUDIENCE ?? 'agent-specialist',
    // Ask for read + write + llm:invoke — copilot's policy in Curity allows them
    // under this audience. The specialist re-checks ops:write, and needs
    // llm:invoke in its delegated subject token to exchange to aud=llm-gateway
    // for its own reasoning hop (else its LLM egress fails mid-remediation).
    specialistScope: process.env.SPECIALIST_SCOPE ?? 'inspect:read ops:write llm:invoke',
    llmGatewayUrl:
      process.env.LLM_GATEWAY_URL ?? 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
    llmGatewayAudience: process.env.LLM_GATEWAY_AUDIENCE ?? 'llm-gateway',
    llmGatewayScope: process.env.LLM_GATEWAY_SCOPE ?? 'llm:invoke',
  };

  return cfg;
}
