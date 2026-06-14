export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  requiredScopes: string[];
  /**
   * Required ordering of the `act` chain, OUTER → INNER (most recent first):
   *   outer  = mcp-ops          (exchanged the token last)
   *   middle = agent-specialist
   *   inner  = agent-copilot    (oldest)
   * Each entry is a RegExp tested against that hop's `act.sub`.
   */
  expectedActorChain: RegExp[];
  /** Target namespace for restart actions. RBAC further enforces this. */
  targetNamespace: string;
  /** RFC 9470: minimum `acr` the leaf token must carry (defense in depth — mcp-ops checks first). */
  requiredAcr: string;
  /** RFC 9728 doc URL echoed in a step-up challenge. */
  resourceMetadataUrl: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const SPIFFE_ID = (ns: string, sa: string): RegExp =>
  new RegExp(`^spiffe://demo\\.curity\\.local/ns/${ns}/sa/${sa}$`);

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8083),
    curityIssuer: required('CURITY_ISSUER'),
    curityJwksUri: required('CURITY_JWKS_URI'),
    expectedAudience: process.env.API_AUDIENCE ?? 'ops-api',
    requiredScopes: (process.env.REQUIRED_SCOPES ?? 'ops:write').split(/\s+/).filter(Boolean),
    expectedActorChain: [
      SPIFFE_ID('mcp', 'mcp-ops'),
      SPIFFE_ID('agents', 'agent-specialist'),
      SPIFFE_ID('agents', 'agent-copilot'),
    ],
    targetNamespace: process.env.TARGET_NAMESPACE ?? 'prod',
    requiredAcr: process.env.REQUIRED_ACR ?? 'mfa',
    resourceMetadataUrl:
      process.env.RESOURCE_METADATA_URL ??
      'https://ops-api.localtest.me/.well-known/oauth-protected-resource',
  };
}
