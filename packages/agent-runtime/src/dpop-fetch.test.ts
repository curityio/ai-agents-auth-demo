import { describe, it, expect, vi } from 'vitest';
import { UnsecuredJWT, decodeJwt, decodeProtectedHeader } from 'jose';
import { accessTokenHash, createDpopKey } from '@ai-agents-demo/auth-curity';
import { withDpop } from './dpop-fetch.js';

const URL_ = 'https://mcp-gateway.localtest.me/inspect/mcp';
const bound = (jkt: string) => new UnsecuredJWT({ sub: 'alice', cnf: { jkt } }).encode();
const unbound = new UnsecuredJWT({ sub: 'alice' }).encode();

function sentHeaders(inner: ReturnType<typeof vi.fn>): Headers {
  return new Headers(inner.mock.calls[0]![1]?.headers);
}

describe('withDpop', () => {
  it('turns a bound Bearer into the DPoP scheme plus a proof for this method, URL and token', async () => {
    const key = await createDpopKey();
    const token = bound(key.jkt);
    const inner = vi.fn(async () => new Response('ok'));
    await withDpop(key, inner)(URL_ + '?q=1', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const h = sentHeaders(inner);
    expect(h.get('authorization')).toBe(`DPoP ${token}`);
    expect(h.get('content-type')).toBe('application/json');
    const proof = h.get('dpop')!;
    expect(decodeProtectedHeader(proof).typ).toBe('dpop+jwt');
    expect(decodeJwt(proof)).toMatchObject({ htm: 'POST', htu: URL_, ath: accessTokenHash(token) });
    expect(inner.mock.calls[0]![1]?.body).toBe('{}');
  });

  it('signs a fresh proof per request', async () => {
    const key = await createDpopKey();
    const inner = vi.fn(async () => new Response('ok'));
    const f = withDpop(key, inner);
    const init = { method: 'POST', headers: { authorization: `Bearer ${bound(key.jkt)}` } };
    await f(URL_, init);
    await f(URL_, init);
    const jti = (i: number) => decodeJwt(new Headers(inner.mock.calls[i]![1]?.headers).get('dpop')!).jti;
    expect(jti(0)).not.toBe(jti(1));
  });

  it('leaves an unbound token as plain Bearer (e.g. the A2A /last-token walk)', async () => {
    const key = await createDpopKey();
    const inner = vi.fn(async () => new Response('ok'));
    const init = { headers: { authorization: `Bearer ${unbound}` } };
    await withDpop(key, inner)(URL_, init);
    expect(inner).toHaveBeenCalledWith(URL_, init);
  });

  it('passes requests without credentials straight through', async () => {
    const key = await createDpopKey();
    const inner = vi.fn(async () => new Response('ok'));
    await withDpop(key, inner)(URL_, { method: 'POST' });
    expect(inner).toHaveBeenCalledWith(URL_, { method: 'POST' });
  });

  it('reads method, URL and headers from a Request object', async () => {
    const key = await createDpopKey();
    const token = bound(key.jkt);
    const inner = vi.fn(async () => new Response('ok'));
    await withDpop(key, inner)(new Request(URL_, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } }));
    const h = sentHeaders(inner);
    expect(h.get('authorization')).toBe(`DPoP ${token}`);
    expect(decodeJwt(h.get('dpop')!)).toMatchObject({ htm: 'DELETE', htu: URL_ });
  });
});
