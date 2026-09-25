export interface Config {
  port: number;
  curityIssuer: string;
  curityJwksUri: string;
  expectedAudience: string;
  requiredScopes: string[];
  /** RFC 9728 document URL, advertised in `WWW-Authenticate` on scope challenges. */
  resourceMetadataUrl: string;
  /** Compiled regex matching allowed inbound actor SPIFFE IDs. */
  actorPattern: RegExp;
  // mcp-inspect is also a confidential client (exchange to inspect-api).
  curityTokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  inspectApiBaseUrl: string;
  inspectApiAudience: string;
  inspectApiScope: string;
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
    expectedAudience: process.env.EXPECTED_AUDIENCE ?? 'mcp-inspect',
    requiredScopes: (process.env.REQUIRED_SCOPES ?? 'inspect:read').split(/\s+/).filter(Boolean),
    resourceMetadataUrl:
      process.env.RESOURCE_METADATA_URL ??
      'https://mcp-inspect.localtest.me/.well-known/oauth-protected-resource',
    // The immediate (outermost) actor calling mcp-inspect is now the
    // agentgateway (mcp ns) — all agent traffic is fronted by it. The deeper
    // chain (copilot / specialist) is validated downstream by inspect-api's full
    // expectedActorChains. See k8s/workloads/agentgateway*.yaml.
    actorPattern: new RegExp(
      process.env.ACTOR_PATTERN ?? '^spiffe://demo\\.curity\\.local/ns/mcp/sa/agentgateway$',
    ),
    curityTokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    clientId: process.env.CURITY_CLIENT_ID ?? 'mcp-inspect',
    clientSecret: required('CURITY_CLIENT_SECRET'),
    inspectApiBaseUrl: required('INSPECT_API_URL'),
    inspectApiAudience: process.env.INSPECT_API_AUDIENCE ?? 'inspect-api',
    inspectApiScope: process.env.INSPECT_API_SCOPE ?? 'inspect:read',
    targetNamespace: process.env.TARGET_NAMESPACE ?? 'prod',
  };
}
