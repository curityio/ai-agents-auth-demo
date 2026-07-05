function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export interface Config {
  port: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  svidFile: string;
  svidAudience: string;
  audienceScopes: Record<string, string>;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8090),
    tokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    clientId: process.env.GATEWAY_CLIENT_ID ?? 'mcp-gateway',
    clientSecret: required('CURITY_CLIENT_SECRET'),
    svidFile: process.env.SPIFFE_SVID_PATH ?? '/run/spiffe/curity-actor.jwt',
    svidAudience: process.env.SVID_AUDIENCE ?? 'https://curity.localtest.me/oauth/v2/oauth-token',
    audienceScopes: { 'mcp-observability': 'obs:read', 'mcp-ops': 'ops:write' },
  };
}
