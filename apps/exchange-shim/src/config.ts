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
  /**
   * Reuse window for an exchanged token per (caller token, audience), in seconds.
   * 60 mirrors the copilot's own exchange cache: one Curity exchange per question
   * (the three extAuthz callouts of discover/list/call share it) while the exchange
   * still shows up in every question's trace. 0 disables the cache.
   */
  cacheTtlSeconds: number;
  /** LRU bound on distinct (caller token, audience) entries. */
  cacheMaxEntries: number;
}

function nonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return n;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8090),
    tokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    clientId: process.env.GATEWAY_CLIENT_ID ?? 'agentgateway',
    clientSecret: required('CURITY_CLIENT_SECRET'),
    svidFile: process.env.SPIFFE_SVID_PATH ?? '/run/spiffe/curity-actor.jwt',
    svidAudience: process.env.SVID_AUDIENCE ?? 'https://curity.localtest.me/oauth/v2/oauth-token',
    audienceScopes: { 'mcp-inspect': 'inspect:read', 'mcp-ops': 'ops:write' },
    cacheTtlSeconds: nonNegativeInt('EXCHANGE_CACHE_TTL_SECONDS', 60),
    cacheMaxEntries: Math.max(1, nonNegativeInt('EXCHANGE_CACHE_MAX_ENTRIES', 1000)),
  };
}
