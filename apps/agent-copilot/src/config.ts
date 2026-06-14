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
  llmProvider: 'anthropic' | 'azure' | 'ollama';
  llmModel: string;
  /** Only set when llmProvider === 'azure'. Used as baseURL prefix. */
  azureEndpoint?: string;
  /** Only set when llmProvider === 'azure'. */
  azureApiVersion?: string;
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
    // Ask for BOTH scopes — copilot's policy in Curity allows them under this
    // audience, and the specialist re-checks that ops:write is present.
    specialistScope: process.env.SPECIALIST_SCOPE ?? 'obs:read ops:write',
    llmProvider: provider,
    llmModel:
      process.env.LLM_MODEL ??
      (provider === 'anthropic'
        ? 'claude-sonnet-4-6'
        : provider === 'azure'
          ? 'gpt-4.1'
          : 'qwen2.5-coder:7b'),
  };

  if (provider === 'azure') {
    cfg.azureEndpoint = required('AZURE_OPENAI_ENDPOINT');
    cfg.azureApiVersion = process.env.AZURE_OPENAI_API_VERSION ?? '2024-04-01-preview';
  }

  return cfg;
}
