export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  /** CIMD client_id — the HTTPS URL Curity dereferences to fetch this agent's metadata. */
  agentClientId: string;
  /** PKCS8 PEM private key used to sign the private_key_jwt client assertion. */
  agentPrivateKeyPem: string;
  mcpOpsUrl: string;
  /**
   * RFC 8693 `audience` for the MCP hop. The ONE per-server value that stays
   * configured: everything else about the hop (authorization server, token
   * endpoint, scope) is discovered from the server's 401 → RFC 9728 → RFC 8414
   * chain (packages/agent-runtime mcp-oauth-client.ts). It would be replaced by
   * the RFC 8707 `resource` parameter once Curity accepts it.
   */
  mcpOpsAudience: string;
  /** Public URL where this agent's AgentCard is served. */
  publicBaseUrl: string;
  // LLM
  /** Base URL of the agentgateway LLM route. */
  llmGatewayUrl: string;
  /** RFC 8693 exchange audience for the gateway LLM route. */
  llmGatewayAudience: string;
  /** RFC 8693 exchange scope for the gateway LLM route. */
  llmGatewayScope: string;
  // Read tier (observability) — the specialist also reads to plan/verify.
  mcpObservabilityUrl: string;
  /**
   * RFC 8693 `audience` for the read-tier MCP hop. The ONE per-server value that stays
   * configured: everything else about the hop (authorization server, token
   * endpoint, scope) is discovered from the server's 401 → RFC 9728 → RFC 8414
   * chain (packages/agent-runtime mcp-oauth-client.ts). It would be replaced by
   * the RFC 8707 `resource` parameter once Curity accepts it.
   */
  mcpObservabilityAudience: string;
  // Step-up: the acr the inbound token must carry before any write is attempted.
  requiredAcr: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  const cfg: Config = {
    port: Number(process.env.PORT ?? 8082),
    curityIssuer: required('CURITY_ISSUER'),
    curityJwksUri: required('CURITY_JWKS_URI'),
    expectedAudience: process.env.AGENT_AUDIENCE ?? 'agent-specialist',
    agentClientId:
      process.env.AGENT_CLIENT_ID ?? 'https://specialist.localtest.me/.well-known/oauth-client',
    agentPrivateKeyPem: required('CURITY_AGENT_PRIVATE_KEY_PEM'),
    mcpOpsUrl: required('MCP_OPS_URL'),
    mcpOpsAudience: process.env.MCP_OPS_AUDIENCE ?? 'mcp-ops',
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://specialist.localtest.me',
    llmGatewayUrl:
      process.env.LLM_GATEWAY_URL ?? 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
    llmGatewayAudience: process.env.LLM_GATEWAY_AUDIENCE ?? 'llm-gateway',
    llmGatewayScope: process.env.LLM_GATEWAY_SCOPE ?? 'llm:invoke',
    mcpObservabilityUrl: required('MCP_OBSERVABILITY_URL'),
    mcpObservabilityAudience: process.env.MCP_OBSERVABILITY_AUDIENCE ?? 'mcp-observability',
    requiredAcr: process.env.REQUIRED_ACR ?? 'mfa',
  };

  return cfg;
}
