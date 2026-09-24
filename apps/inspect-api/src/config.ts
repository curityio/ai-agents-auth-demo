export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  requiredScopes: string[];
  /**
   * Allowed `act` chains — each entry is one accepted chain OUTER → INNER.
   *   Read path A: [mcp-inspect, agentgateway, agent-copilot]          (depth 3 — copilot reads directly)
   *   Read path B: [mcp-inspect, agentgateway, agent-specialist, agent-copilot] (depth 4 — specialist remediating)
   */
  expectedActorChains: RegExp[][];
  /** Default namespace for list/logs. RBAC further enforces this. */
  targetNamespace: string;
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
    port: Number(process.env.PORT ?? 8084),
    curityIssuer: required('CURITY_ISSUER'),
    curityJwksUri: required('CURITY_JWKS_URI'),
    expectedAudience: process.env.EXPECTED_AUDIENCE ?? 'inspect-api',
    requiredScopes: (process.env.REQUIRED_SCOPES ?? 'inspect:read').split(/\s+/).filter(Boolean),
    expectedActorChains: [
      // Read path A: [mcp-inspect, agentgateway, agent-copilot]
      [
        SPIFFE_ID('mcp', 'mcp-inspect'),
        SPIFFE_ID('mcp', 'agentgateway'),
        SPIFFE_ID('agents', 'agent-copilot'),
      ],
      // Read path B: [mcp-inspect, agentgateway, agent-specialist, agent-copilot]
      [
        SPIFFE_ID('mcp', 'mcp-inspect'),
        SPIFFE_ID('mcp', 'agentgateway'),
        SPIFFE_ID('agents', 'agent-specialist'),
        SPIFFE_ID('agents', 'agent-copilot'),
      ],
    ],
    targetNamespace: process.env.TARGET_NAMESPACE ?? 'prod',
  };
}
