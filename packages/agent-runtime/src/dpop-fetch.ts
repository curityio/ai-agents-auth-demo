import { createDpopKey, createDpopProof, tokenCnfJkt, type DpopKey } from '@ai-agents-demo/auth-curity';

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

function htuOf(url: string): string {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * Present DPoP-bound tokens with proof of possession (RFC 9449 §7).
 *
 * Wraps a fetch: when a request carries `Authorization: Bearer <token>` and that
 * token is bound (`cnf.jkt`), it is re-sent as `Authorization: DPoP <token>` with a
 * fresh `DPoP` proof for this method, URL and token. Every other request passes
 * through untouched, which is what lets one wrapper sit on a fetch that also
 * carries unbound tokens (the copilot's /last-token walk calls the gateway with a
 * bound token AND the specialist with an unbound A2A one).
 *
 * The MCP SDK sets the bearer itself from `authProvider.token()`; this is the seam
 * that changes how it is presented without touching the transport.
 */
export function withDpop(key: DpopKey, inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const token = /^Bearer\s+(\S+)$/i.exec(headers.get('authorization') ?? '')?.[1];
    if (!token || !tokenCnfJkt(token)) return inner(input, init);

    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    headers.set('authorization', `DPoP ${token}`);
    headers.set('dpop', await createDpopProof(key, { htm: method, htu: htuOf(urlOf(input)), accessToken: token }));
    return inner(input, { ...init, method, headers });
  };
}

let processKey: Promise<DpopKey> | undefined;

/**
 * The agent process's DPoP key: one ephemeral key, memory only. Every
 * `aud=mcp-gateway` exchange binds to it and every proof is signed with it, so the
 * two must come from here; a restart binds fresh tokens to a fresh key.
 */
export function processDpopKey(): Promise<DpopKey> {
  return (processKey ??= createDpopKey());
}

/** `withDpop` on the process key, for places that need a plain fetch synchronously. */
export function withProcessDpop(inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => withDpop(await processDpopKey(), inner)(input, init);
}
