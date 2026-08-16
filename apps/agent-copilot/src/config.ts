export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  mcpObservabilityUrl: string;
  curityTokenEndpoint: string;
  /** CIMD client_id — the HTTPS URL Curity dereferences to fetch this agent's metadata. */
  agentClientId: string;
  /** PKCS8 PEM private key used to sign the private_key_jwt client assertion. */
  agentPrivateKeyPem: string;
  mcpObservabilityAudience: string;
  mcpObservabilityScope: string;
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

export function loadConfig(): Config {
  const cfg: Config = {
    port: Number(process.env.PORT ?? 8081),
    curityIssuer: required('CURITY_ISSUER'),
    curityJwksUri: required('CURITY_JWKS_URI'),
    expectedAudience: process.env.AGENT_AUDIENCE ?? 'agent-copilot',
    mcpObservabilityUrl: required('MCP_OBSERVABILITY_URL'),
    curityTokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    agentClientId:
      process.env.AGENT_CLIENT_ID ?? 'https://copilot.localtest.me/.well-known/oauth-client',
    agentPrivateKeyPem: required('CURITY_AGENT_PRIVATE_KEY_PEM'),
    mcpObservabilityAudience: process.env.MCP_OBSERVABILITY_AUDIENCE ?? 'mcp-observability',
    mcpObservabilityScope: process.env.MCP_OBSERVABILITY_SCOPE ?? 'obs:read',
    specialistA2aUrl:
      process.env.SPECIALIST_A2A_URL ??
      'http://agent-specialist.agents.svc.cluster.local:8082/a2a',
    specialistAudience: process.env.SPECIALIST_AUDIENCE ?? 'agent-specialist',
    // Ask for read + write + llm:invoke — copilot's policy in Curity allows them
    // under this audience. The specialist re-checks ops:write, and needs
    // llm:invoke in its delegated subject token to exchange to aud=llm-gateway
    // for its own reasoning hop (else its LLM egress fails mid-remediation).
    specialistScope: process.env.SPECIALIST_SCOPE ?? 'obs:read ops:write llm:invoke',
    llmGatewayUrl:
      process.env.LLM_GATEWAY_URL ?? 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
    llmGatewayAudience: process.env.LLM_GATEWAY_AUDIENCE ?? 'llm-gateway',
    llmGatewayScope: process.env.LLM_GATEWAY_SCOPE ?? 'llm:invoke',
  };

  return cfg;
}
