export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  requiredScopes: string[];
  /** Compiled regex matching allowed inbound actor SPIFFE IDs. */
  actorPattern: RegExp;
  // mcp-observability is also a confidential client (exchange to obs-api).
  curityTokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  obsApiBaseUrl: string;
  obsApiAudience: string;
  obsApiScope: string;
  targetNamespace: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8080),
    curityIssuer: required('CURITY_ISSUER'),
    curityJwksUri: required('CURITY_JWKS_URI'),
    expectedAudience: process.env.MCP_AUDIENCE ?? 'mcp-observability',
    requiredScopes: (process.env.REQUIRED_SCOPES ?? 'obs:read').split(/\s+/).filter(Boolean),
    actorPattern: new RegExp(
      process.env.ACTOR_PATTERN ?? '^spiffe://demo\\.curity\\.local/ns/agents/sa/[a-z0-9-]+$',
    ),
    curityTokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    clientId: process.env.MCP_CLIENT_ID ?? 'mcp-observability',
    clientSecret: required('CURITY_CLIENT_SECRET'),
    obsApiBaseUrl: required('OBS_API_URL'),
    obsApiAudience: process.env.OBS_API_AUDIENCE ?? 'obs-api',
    obsApiScope: process.env.OBS_API_SCOPE ?? 'obs:read',
    targetNamespace: process.env.TARGET_NAMESPACE ?? 'prod',
  };
}
