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
   * Per-tool role matrix: tool name → roles of which the caller needs AT LEAST
   * ONE to call it. Every ops tool is listed so the rule is published on every
   * tool's `tools/list` `_meta` (the web UI's card renders the whole matrix from
   * it) and enforced by the same gate before the ops-api hop. The agentgateway
   * can't express a per-tool split without hiding the tool (see
   * agentgateway-config.yaml), so mcp-ops enforces it and returns a legible
   * denial. `roles` is propagated onto every OBO hop by the Curity exchange
   * procedure. For restart/scale the requirement duplicates Curity's write-tier
   * gate (`sre` OR `oncall` for `ops:write`) — deliberately, as defence in depth
   * and so the badge on those tools describes a rule this server actually
   * enforces. Env `TOOL_REQUIRED_ROLES`, see `parseToolRequiredRoles`.
   */
  toolRequiredRoles: Record<string, string[]>;
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

/**
 * The default role matrix. Keep the `set_deployment_image` entry in step with the
 * gateway's `authorization` deny rule in k8s/workloads/agentgateway-config.yaml
 * (keyed on `Mcp-Name`, checks `"sre" in jwt.roles`); the restart/scale entries
 * mirror the write-tier gate in k8s/curity/procedures/token-exchange.js.
 */
export const DEFAULT_TOOL_REQUIRED_ROLES: Readonly<Record<string, readonly string[]>> = {
  restart_deployment: ['sre', 'oncall'],
  scale_deployment: ['sre', 'oncall'],
  set_deployment_image: ['sre'],
};

/**
 * Parse `TOOL_REQUIRED_ROLES`: comma-separated `tool=role role` entries, roles
 * separated by whitespace or `|`. An explicit value REPLACES the default map
 * (so a tool can be un-gated from the environment); a malformed entry throws
 * rather than silently dropping a gate.
 */
export function parseToolRequiredRoles(raw: string | undefined): Record<string, string[]> {
  if (raw === undefined || raw.trim() === '') {
    return Object.fromEntries(Object.entries(DEFAULT_TOOL_REQUIRED_ROLES).map(([k, v]) => [k, [...v]]));
  }
  const out: Record<string, string[]> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    const tool = eq === -1 ? '' : trimmed.slice(0, eq).trim();
    const roles = eq === -1 ? [] : trimmed.slice(eq + 1).split(/[\s|]+/).filter(Boolean);
    if (!tool || roles.length === 0) {
      throw new Error(
        `TOOL_REQUIRED_ROLES: malformed entry "${trimmed}" — expected "tool=role role" (roles separated by whitespace or |)`,
      );
    }
    out[tool] = roles;
  }
  return out;
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
    toolRequiredRoles: parseToolRequiredRoles(process.env.TOOL_REQUIRED_ROLES),
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
