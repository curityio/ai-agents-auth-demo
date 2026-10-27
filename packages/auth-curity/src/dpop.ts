import { createHash, randomUUID } from 'node:crypto';
import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  EmbeddedJWK,
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type JWK,
  type KeyLike,
} from 'jose';

/**
 * RFC 9449 DPoP: sender-constrained access tokens.
 *
 * A client proves possession of a private key on every request with a short-lived
 * signed "proof" naming the method, the URL and (to a resource server) a hash of
 * the access token. Curity binds an exchanged token to that key when the exchange
 * request itself carries a proof — it stamps `cnf.jkt` from the default token data,
 * so the token procedure needs no change. A token that leaks is then useless
 * without the key.
 *
 * In this demo the agents bind their `aud=mcp-gateway` tokens, and the gateway's
 * exchange-shim verifies the proofs (agentgateway has no DPoP support of its own).
 */

const ALG = 'ES256';
const PROOF_TYP = 'dpop+jwt';
/** Asymmetric algorithms a proof may use (RFC 9449 §4.3 rule 6: never `none`/HMAC). */
const ACCEPTED_ALGS = ['ES256', 'ES384', 'RS256', 'PS256', 'EdDSA'];

export interface DpopKey {
  readonly privateKey: KeyLike;
  /** Public JWK embedded in every proof header. */
  readonly publicJwk: JWK;
  /** RFC 7638 thumbprint; what Curity writes into the bound token's `cnf.jkt`. */
  readonly jkt: string;
  /**
   * The last `DPoP-Nonce` the authorization server handed out (RFC 9449 §8).
   * Curity requires one, so remembering it saves a `use_dpop_nonce` round trip
   * on every exchange after the first.
   */
  nonce?: string;
}

/** An ephemeral key pair, held in memory only: a restart simply binds new tokens to a new key. */
export async function createDpopKey(): Promise<DpopKey> {
  const { privateKey, publicKey } = await generateKeyPair(ALG);
  const publicJwk = await exportJWK(publicKey);
  return { privateKey, publicJwk, jkt: await calculateJwkThumbprint(publicJwk) };
}

/** `ath`: base64url(SHA-256(access token)). */
export function accessTokenHash(accessToken: string): string {
  return createHash('sha256').update(accessToken).digest('base64url');
}

/** The `cnf.jkt` a DPoP-bound token carries, or undefined for a plain bearer token. */
export function cnfJkt(payload: unknown): string | undefined {
  const cnf = (payload as { cnf?: { jkt?: unknown } } | null | undefined)?.cnf;
  return typeof cnf?.jkt === 'string' ? cnf.jkt : undefined;
}

/**
 * `cnf.jkt` of a compact JWT, read WITHOUT verifying it. Only for deciding how to
 * PRESENT a token the caller already holds; never an authorization decision.
 */
export function tokenCnfJkt(token: string): string | undefined {
  try {
    return cnfJkt(decodeJwt(token));
  } catch {
    return undefined;
  }
}

export interface DpopProofInput {
  htm: string;
  htu: string;
  /** Present when calling a resource server; absent at the token endpoint. */
  accessToken?: string;
  nonce?: string;
}

export async function createDpopProof(key: DpopKey, input: DpopProofInput): Promise<string> {
  return new SignJWT({
    htm: input.htm,
    htu: input.htu,
    jti: randomUUID(),
    ...(input.accessToken ? { ath: accessTokenHash(input.accessToken) } : {}),
    ...(input.nonce ? { nonce: input.nonce } : {}),
  })
    .setProtectedHeader({ typ: PROOF_TYP, alg: ALG, jwk: key.publicJwk })
    .setIssuedAt()
    .sign(key.privateKey);
}

export class DpopProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DpopProofError';
  }
}

/**
 * Remembers proof `jti`s until their acceptance window closes, so a captured proof
 * cannot be replayed (RFC 9449 §11.1).
 */
export class DpopReplayCache {
  private readonly seen = new Map<string, number>();

  // ponytail: per-process; one shim replica today. A shared store is needed if it ever scales out.
  constructor(private readonly maxEntries = 10_000) {}

  get size(): number {
    return this.seen.size;
  }

  /** True if `jti` is new (and now remembered until `expiresAtMs`); false if it is a replay. */
  remember(jti: string, expiresAtMs: number, nowMs: number): boolean {
    const until = this.seen.get(jti);
    if (until !== undefined && until > nowMs) return false;
    for (const [k, exp] of this.seen) {
      if (exp <= nowMs) this.seen.delete(k);
    }
    while (this.seen.size >= this.maxEntries) {
      this.seen.delete(this.seen.keys().next().value as string);
    }
    this.seen.set(jti, expiresAtMs);
    return true;
  }
}

export interface VerifyDpopProofOptions {
  htm: string;
  /** The URL the client called, as the server knows it (query/fragment ignored). */
  htu: string;
  /** The access token presented alongside the proof. */
  accessToken: string;
  /** The token's `cnf.jkt`: the key the proof must be signed with. */
  jkt: string;
  replay: DpopReplayCache;
  /** How far `iat` may be from now, either way. */
  maxAgeSec?: number;
  now?: () => number;
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

/** Verify a proof against RFC 9449 §4.3 (resource-server checks; no server nonce). Throws DpopProofError. */
export async function verifyDpopProof(proof: string, opts: VerifyDpopProofOptions): Promise<void> {
  const now = (opts.now ?? Date.now)();
  const maxAgeMs = (opts.maxAgeSec ?? 60) * 1000;

  let header;
  try {
    header = decodeProtectedHeader(proof);
  } catch {
    throw new DpopProofError('malformed proof');
  }
  const jwk = header.jwk as JWK | undefined;
  if (jwk && 'd' in jwk) throw new DpopProofError('proof JWK contains private key material');

  let claims;
  try {
    ({ payload: claims } = await jwtVerify(proof, EmbeddedJWK, {
      typ: PROOF_TYP,
      algorithms: ACCEPTED_ALGS,
    }));
  } catch (e) {
    throw new DpopProofError(`invalid proof signature or header: ${(e as Error).message}`);
  }

  if (!jwk || (await calculateJwkThumbprint(jwk)) !== opts.jkt) {
    throw new DpopProofError('proof key does not match the token cnf.jkt');
  }
  if (claims.htm !== opts.htm) throw new DpopProofError(`htm mismatch: ${String(claims.htm)}`);
  if (typeof claims.htu !== 'string' || stripQuery(claims.htu) !== stripQuery(opts.htu)) {
    throw new DpopProofError(`htu mismatch: ${String(claims.htu)}`);
  }
  if (claims.ath !== accessTokenHash(opts.accessToken)) {
    throw new DpopProofError('ath does not match the presented access token');
  }
  if (typeof claims.iat !== 'number' || Math.abs(now - claims.iat * 1000) > maxAgeMs) {
    throw new DpopProofError('iat outside the acceptance window');
  }
  if (typeof claims.jti !== 'string' || !opts.replay.remember(claims.jti, claims.iat * 1000 + maxAgeMs, now)) {
    throw new DpopProofError('proof jti missing or replayed');
  }
}
