export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  curityTokenEndpoint: string;
  /** CIMD client_id — the HTTPS URL Curity dereferences to fetch this agent's metadata. */
  agentClientId: string;
  /** PKCS8 PEM private key used to sign the private_key_jwt client assertion. */
  agentPrivateKeyPem: string;
  mcpOpsUrl: string;
  mcpOpsAudience: string;
  mcpOpsScope: string;
  /** RFC 9728 resource metadata URL for mcp-ops (used in step-up challenges). */
  mcpOpsResourceMetadataUrl: string;
  /**
   * In-cluster URL the specialist actually FETCHES the RFC 9728 document from.
   * Distinct from `mcpOpsResourceMetadataUrl` (the public identifier handed to
   * the browser) and from `mcpOpsUrl` — the latter is the agentgateway, which
   * fronts MCP traffic but serves no /.well-known. Only mcp-ops does.
   */
  mcpOpsMetadataUrl: string;
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
  mcpObservabilityAudience: string;
  mcpObservabilityScope: string;
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
    curityTokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    agentClientId:
      process.env.AGENT_CLIENT_ID ?? 'https://specialist.localtest.me/.well-known/oauth-client',
    agentPrivateKeyPem: required('CURITY_AGENT_PRIVATE_KEY_PEM'),
    mcpOpsUrl: required('MCP_OPS_URL'),
    mcpOpsAudience: process.env.MCP_OPS_AUDIENCE ?? 'mcp-ops',
    mcpOpsScope: process.env.MCP_OPS_SCOPE ?? 'ops:write',
    mcpOpsResourceMetadataUrl:
      process.env.MCP_OPS_RESOURCE_METADATA_URL ??
      'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
    mcpOpsMetadataUrl:
      process.env.MCP_OPS_METADATA_URL ??
      'http://mcp-ops.mcp.svc.cluster.local:8080/.well-known/oauth-protected-resource',
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://specialist.localtest.me',
    llmGatewayUrl:
      process.env.LLM_GATEWAY_URL ?? 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
    llmGatewayAudience: process.env.LLM_GATEWAY_AUDIENCE ?? 'llm-gateway',
    llmGatewayScope: process.env.LLM_GATEWAY_SCOPE ?? 'llm:invoke',
    mcpObservabilityUrl: required('MCP_OBSERVABILITY_URL'),
    mcpObservabilityAudience: process.env.MCP_OBSERVABILITY_AUDIENCE ?? 'mcp-observability',
    mcpObservabilityScope: process.env.MCP_OBSERVABILITY_SCOPE ?? 'obs:read',
    requiredAcr: process.env.REQUIRED_ACR ?? 'mfa',
  };

  return cfg;
}
