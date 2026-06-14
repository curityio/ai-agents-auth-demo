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
  /** Public URL where this agent's AgentCard is served. */
  publicBaseUrl: string;
  // LLM
  llmProvider: 'anthropic' | 'azure' | 'ollama';
  llmModel: string;
  /** Only set when llmProvider === 'azure'. Used as baseURL prefix. */
  azureEndpoint?: string;
  /** Only set when llmProvider === 'azure'. */
  azureApiVersion?: string;
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
  const provider = (process.env.LLM_PROVIDER ?? 'azure').toLowerCase();
  if (provider !== 'anthropic' && provider !== 'azure' && provider !== 'ollama') {
    throw new Error(`LLM_PROVIDER must be 'anthropic' | 'azure' | 'ollama' (got '${provider}')`);
  }

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
    publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'https://specialist.localtest.me',
    llmProvider: provider,
    llmModel:
      process.env.LLM_MODEL ??
      (provider === 'anthropic'
        ? 'claude-sonnet-4-6'
        : provider === 'azure'
          ? 'gpt-4.1'
          : 'qwen2.5-coder:7b'),
    mcpObservabilityUrl: required('MCP_OBSERVABILITY_URL'),
    mcpObservabilityAudience: process.env.MCP_OBSERVABILITY_AUDIENCE ?? 'mcp-observability',
    mcpObservabilityScope: process.env.MCP_OBSERVABILITY_SCOPE ?? 'obs:read',
    requiredAcr: process.env.REQUIRED_ACR ?? 'mfa',
  };

  if (provider === 'azure') {
    cfg.azureEndpoint = required('AZURE_OPENAI_ENDPOINT');
    cfg.azureApiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-04-01-preview';
  }

  return cfg;
}
