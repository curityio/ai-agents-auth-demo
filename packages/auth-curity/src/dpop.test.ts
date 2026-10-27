import { describe, it, expect } from 'vitest';
import { SignJWT, decodeJwt, decodeProtectedHeader, exportJWK, generateKeyPair } from 'jose';
import {
  accessTokenHash,
  cnfJkt,
  createDpopKey,
  createDpopProof,
  DpopProofError,
  DpopReplayCache,
  verifyDpopProof,
} from './dpop.js';

const HTU = 'https://mcp-gateway.localtest.me/inspect/mcp';
const AT = 'eyJ.access.token';

async function verifyWith(proof: string, over: Partial<Parameters<typeof verifyDpopProof>[1]> = {}) {
  const key = over.jkt ? undefined : await createDpopKey();
  return verifyDpopProof(proof, {
    htm: 'POST',
    htu: HTU,
    accessToken: AT,
    jkt: key?.jkt ?? '',
    replay: new DpopReplayCache(),
    ...over,
  });
}

describe('createDpopProof', () => {
  it('signs an RFC 9449 proof: dpop+jwt header with the public JWK, htm/htu/jti/iat/ath claims', async () => {
    const key = await createDpopKey();
    const proof = await createDpopProof(key, { htm: 'POST', htu: HTU, accessToken: AT });
    const h = decodeProtectedHeader(proof);
    expect(h.typ).toBe('dpop+jwt');
    expect(h.alg).toBe('ES256');
    expect(h.jwk).toEqual(key.publicJwk);
    expect((h.jwk as Record<string, unknown>).d).toBeUndefined();
    const c = decodeJwt(proof);
    expect(c).toMatchObject({ htm: 'POST', htu: HTU, ath: accessTokenHash(AT) });
    expect(typeof c.jti).toBe('string');
    expect(typeof c.iat).toBe('number');
    expect(c.nonce).toBeUndefined();
  });

  it('carries a server nonce and omits ath when there is no access token (token endpoint)', async () => {
    const key = await createDpopKey();
    const c = decodeJwt(await createDpopProof(key, { htm: 'POST', htu: 'https://as/token', nonce: 'n-1' }));
    expect(c.nonce).toBe('n-1');
    expect(c.ath).toBeUndefined();
  });

  it('gives every proof a fresh jti', async () => {
    const key = await createDpopKey();
    const a = decodeJwt(await createDpopProof(key, { htm: 'POST', htu: HTU }));
    const b = decodeJwt(await createDpopProof(key, { htm: 'POST', htu: HTU }));
    expect(a.jti).not.toBe(b.jti);
  });
});

describe('accessTokenHash / cnfJkt', () => {
  it('hashes as base64url(SHA-256(token)) with no padding', () => {
    // SHA-256("abc"), base64url
    expect(accessTokenHash('abc')).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
  });

  it('reads cnf.jkt and ignores anything else', () => {
    expect(cnfJkt({ cnf: { jkt: 'abc' } })).toBe('abc');
    expect(cnfJkt({ cnf: { 'x5t#S256': 'abc' } })).toBeUndefined();
    expect(cnfJkt({})).toBeUndefined();
    expect(cnfJkt(null)).toBeUndefined();
  });
});

describe('verifyDpopProof', () => {
  it('accepts a proof made by the bound key for this method, URL and token', async () => {
    const key = await createDpopKey();
    const proof = await createDpopProof(key, { htm: 'POST', htu: HTU, accessToken: AT });
    await expect(verifyWith(proof, { jkt: key.jkt })).resolves.toBeUndefined();
  });

  it('ignores query and fragment when comparing htu (RFC 9449 §4.3)', async () => {
    const key = await createDpopKey();
    const proof = await createDpopProof(key, { htm: 'POST', htu: HTU, accessToken: AT });
    await expect(verifyWith(proof, { jkt: key.jkt, htu: HTU + '?x=1#f' })).resolves.toBeUndefined();
  });

  it('rejects a proof from a different key than the token is bound to', async () => {
    const key = await createDpopKey();
    const other = await createDpopKey();
    const proof = await createDpopProof(other, { htm: 'POST', htu: HTU, accessToken: AT });
    await expect(verifyWith(proof, { jkt: key.jkt })).rejects.toThrow(/jkt/);
  });

  it.each([
    ['method', { htm: 'GET' }, /htm/],
    ['URL', { htu: 'https://mcp-gateway.localtest.me/ops/mcp' }, /htu/],
    ['access token', { accessToken: 'eyJ.other.token' }, /ath/],
  ])('rejects a proof made for another %s', async (_what, over, msg) => {
    const key = await createDpopKey();
    const proof = await createDpopProof(key, { htm: 'POST', htu: HTU, accessToken: AT });
    await expect(verifyWith(proof, { jkt: key.jkt, ...over })).rejects.toThrow(msg);
  });

  it('rejects a replayed proof (same jti) within the window', async () => {
    const key = await createDpopKey();
    const replay = new DpopReplayCache();
    const proof = await createDpopProof(key, { htm: 'POST', htu: HTU, accessToken: AT });
    await verifyWith(proof, { jkt: key.jkt, replay });
    await expect(verifyWith(proof, { jkt: key.jkt, replay })).rejects.toThrow(/replay/);
  });

  it('rejects a stale proof and one issued in the future', async () => {
    const key = await createDpopKey();
    const proof = await createDpopProof(key, { htm: 'POST', htu: HTU, accessToken: AT });
    const iat = decodeJwt(proof).iat! * 1000;
    await expect(verifyWith(proof, { jkt: key.jkt, now: () => iat + 61_000 })).rejects.toThrow(/iat/);
    await expect(verifyWith(proof, { jkt: key.jkt, now: () => iat - 61_000 })).rejects.toThrow(/iat/);
  });

  it('rejects a token without ath, and a proof with the wrong typ', async () => {
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const jwk = await exportJWK(publicKey);
    const { calculateJwkThumbprint } = await import('jose');
    const jkt = await calculateJwkThumbprint(jwk);
    const base = { htm: 'POST', htu: HTU, jti: 'j1' };
    const noAth = await new SignJWT(base).setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk }).setIssuedAt().sign(privateKey);
    await expect(verifyWith(noAth, { jkt })).rejects.toThrow(/ath/);
    const wrongTyp = await new SignJWT({ ...base, jti: 'j2', ath: accessTokenHash(AT) })
      .setProtectedHeader({ typ: 'JWT', alg: 'ES256', jwk }).setIssuedAt().sign(privateKey);
    await expect(verifyWith(wrongTyp, { jkt })).rejects.toThrow(DpopProofError);
  });

  it('rejects a proof whose embedded JWK carries the private key', async () => {
    const { privateKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(privateKey); // includes "d"
    const { calculateJwkThumbprint } = await import('jose');
    const proof = await new SignJWT({ htm: 'POST', htu: HTU, jti: 'j3', ath: accessTokenHash(AT) })
      .setProtectedHeader({ typ: 'dpop+jwt', alg: 'ES256', jwk }).setIssuedAt().sign(privateKey);
    await expect(verifyWith(proof, { jkt: await calculateJwkThumbprint(jwk) })).rejects.toThrow(/private/);
  });

  it('rejects garbage as a DpopProofError, never a raw library error', async () => {
    await expect(verifyWith('not-a-jwt', { jkt: 'x' })).rejects.toThrow(DpopProofError);
  });
});

describe('DpopReplayCache', () => {
  it('forgets a jti once its window has passed, and stays bounded', () => {
    const c = new DpopReplayCache(2);
    expect(c.remember('a', 1_000, 0)).toBe(true);
    expect(c.remember('a', 1_000, 500)).toBe(false);
    expect(c.remember('a', 2_000, 1_500)).toBe(true); // expired → accepted again
    c.remember('b', 9_000, 1_600);
    c.remember('c', 9_000, 1_700); // evicts the oldest
    expect(c.size).toBeLessThanOrEqual(2);
  });
});
