/**
 * The claims a request will carry, decoded server-side from the user's access
 * token so the Ask card can state them BEFORE Send. Narrative only: the token
 * is verified downstream (agent, gateway, MCP servers), never by the browser,
 * and the raw token never leaves the server.
 */
export interface Asking {
  sub?: string;
  roles: string[];
  acr?: string;
}

const NONE: Asking = { sub: undefined, roles: [], acr: undefined };

export function identityFromAccessToken(jwt: string | undefined | null): Asking {
  if (!jwt) return { ...NONE };
  const part = jwt.split('.')[1];
  if (!part) return { ...NONE };
  try {
    const p = JSON.parse(Buffer.from(part, 'base64url').toString()) as Record<string, unknown>;
    const roles = Array.isArray(p.roles)
      ? p.roles.map(String)
      : p.roles != null
        ? [String(p.roles)]
        : [];
    return {
      sub: p.sub != null ? String(p.sub) : undefined,
      roles,
      acr: p.acr != null ? String(p.acr) : undefined,
    };
  } catch {
    return { ...NONE };
  }
}
