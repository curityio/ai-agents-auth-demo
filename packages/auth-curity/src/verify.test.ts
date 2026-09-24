import { describe, it, expect, beforeAll } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { verifyJwt } from './verify.js';
import { CurityAuthError } from './errors.js';

interface TestEnv {
  issuer: string;
  jwksUri: string;
  privateKey: CryptoKey;
  kid: string;
  server: Server;
}

async function startJwksServer(): Promise<TestEnv> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  const kid = 'test-key-1';
  const jwksDoc = { keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] };

  const server = createServer((req, res) => {
    if (req.url === '/jwks') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(jwksDoc));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    issuer: 'https://curity.test/oauth/v2/oauth-anonymous',
    jwksUri: `http://127.0.0.1:${port}/jwks`,
    privateKey,
    kid,
    server,
  };
}

async function mintToken(
  env: TestEnv,
  overrides: {
    aud?: string;
    iss?: string;
    sub?: string;
    scope?: string;
    exp?: number;
    extra?: Record<string, unknown>;
  } = {},
): Promise<string> {
  return new SignJWT({
    scope: overrides.scope ?? 'openid profile inspect:read',
    ...overrides.extra,
  })
    .setProtectedHeader({ alg: 'RS256', kid: env.kid })
    .setIssuer(overrides.iss ?? env.issuer)
    .setAudience(overrides.aud ?? 'web-app')
    .setSubject(overrides.sub ?? 'alice')
    .setIssuedAt()
    .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 60)
    .sign(env.privateKey);
}

describe('verifyJwt', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await startJwksServer();
  });

  it('verifies a valid token and parses scopes', async () => {
    const token = await mintToken(env, { scope: 'openid inspect:read inspect:write' });
    const verified = await verifyJwt(token, {
      issuer: env.issuer,
      audience: 'web-app',
      jwksUri: env.jwksUri,
    });
    expect(verified.payload.sub).toBe('alice');
    expect(verified.scopes.has('inspect:read')).toBe(true);
    expect(verified.scopes.has('inspect:write')).toBe(true);
    expect(verified.scopes.has('ops:write')).toBe(false);
  });

  it('rejects a token with the wrong audience', async () => {
    const token = await mintToken(env, { aud: 'other-app' });
    await expect(
      verifyJwt(token, { issuer: env.issuer, audience: 'web-app', jwksUri: env.jwksUri }),
    ).rejects.toBeInstanceOf(CurityAuthError);
  });

  it('rejects a token with the wrong issuer', async () => {
    const token = await mintToken(env, { iss: 'https://attacker.example' });
    await expect(
      verifyJwt(token, { issuer: env.issuer, audience: 'web-app', jwksUri: env.jwksUri }),
    ).rejects.toMatchObject({ code: 'invalid_issuer' });
  });

  it('rejects an expired token', async () => {
    const token = await mintToken(env, { exp: Math.floor(Date.now() / 1000) - 3600 });
    await expect(
      verifyJwt(token, { issuer: env.issuer, audience: 'web-app', jwksUri: env.jwksUri }),
    ).rejects.toMatchObject({ code: 'expired_token' });
  });

  it('throws CurityAuthError when jwksUri is missing', async () => {
    await expect(
      verifyJwt('not-a-real-token', {
        issuer: env.issuer,
        audience: 'web-app',
      }),
    ).rejects.toMatchObject({ code: 'jwks_failed' });
  });
});
