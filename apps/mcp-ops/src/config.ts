export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  requiredScopes: string[];
  /**
   * Required ordering of the inbound `act` chain, OUTER → INNER.
   *   outer = agentgateway, middle = agent-specialist, inner = agent-copilot
   */
  expectedActorChain: RegExp[];
  /** Target namespace for restart actions; forwarded to ops-api. */
  targetNamespace: string;
  /**
   * Roles allowed to call `set_deployment_image` (the privileged image-update
   * tool). The caller needs AT LEAST ONE. The agentgateway can't express this
   * per-tool split without hiding the tool (see agentgateway-config.yaml), so
   * mcp-ops enforces it here and returns a legible denial. `roles` is propagated
   * onto every OBO hop by the Curity exchange procedure.
   */
  setImageRequiredRoles: string[];
  requiredAcr: string;
  resourceMetadataUrl: string;
  // mcp-ops is also a confidential client that exchanges to ops-api.
  curityTokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  opsApiUrl: string;
  opsApiAudience: string;
  opsApiScope: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SPIFFE_AGENT = (name: string): RegExp =>
  new RegExp(`^spiffe://demo\\.curity\\.local/ns/agents/sa/${name}$`);

const SPIFFE_ID = (ns: string, sa: string): RegExp =>
  new RegExp(`^spiffe://demo\\.curity\\.local/ns/${ns}/sa/${sa}$`);

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    curityIssuer: required('CURITY_ISSUER'),
    curityJwksUri: required('CURITY_JWKS_URI'),
    expectedAudience: process.env.MCP_AUDIENCE ?? 'mcp-ops',
    requiredScopes: (process.env.REQUIRED_SCOPES ?? 'ops:write').split(/\s+/).filter(Boolean),
    expectedActorChain: [
      SPIFFE_ID('mcp', 'agentgateway'),
      SPIFFE_AGENT('agent-specialist'),
      SPIFFE_AGENT('agent-copilot'),
    ],
    targetNamespace: process.env.TARGET_NAMESPACE ?? 'prod',
    setImageRequiredRoles: (process.env.SET_IMAGE_REQUIRED_ROLES ?? 'sre')
      .split(/\s+/)
      .filter(Boolean),
    requiredAcr: process.env.REQUIRED_ACR ?? 'mfa',
    resourceMetadataUrl:
      process.env.RESOURCE_METADATA_URL ??
      'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
    curityTokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    clientId: process.env.MCP_CLIENT_ID ?? 'mcp-ops',
    clientSecret: required('CURITY_CLIENT_SECRET'),
    opsApiUrl: required('OPS_API_URL'),
    opsApiAudience: process.env.OPS_API_AUDIENCE ?? 'ops-api',
    opsApiScope: process.env.OPS_API_SCOPE ?? 'ops:write',
  };
}
