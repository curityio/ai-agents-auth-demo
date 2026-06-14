import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SignJWT } from 'jose';
import { SpiffeJwtSvidSource } from './svid-source.js';

async function fakeSvid(opts: {
  sub: string;
  audience: string;
  iss?: string;
  ttlSeconds?: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  // We sign with a throwaway HMAC key — this package never verifies signatures,
  // so the key material is irrelevant to the test.
  const key = new TextEncoder().encode('test-key-not-used-for-verification');
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(opts.iss ?? 'https://oidc-discovery.demo.curity.local')
    .setSubject(opts.sub)
    .setAudience(opts.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.ttlSeconds ?? 300))
    .sign(key);
}

describe('SpiffeJwtSvidSource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'spiffe-test-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns null when the file is missing', async () => {
    const source = new SpiffeJwtSvidSource({
      audiences: [{ audience: 'aud-1', filePath: join(dir, 'missing.jwt') }],
    });
    expect(await source.getSvid('aud-1')).toBeNull();
  });

  it('reads and decodes a JWT file written by spiffe-helper', async () => {
    const path = join(dir, 'svid.jwt');
    const jwt = await fakeSvid({
      sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot',
      audience: 'https://curity.localtest.me/oauth/v2/oauth-token',
    });
    await writeFile(path, jwt);

    const source = new SpiffeJwtSvidSource({
      audiences: [{ audience: 'curity', filePath: path }],
    });
    const svid = await source.getSvid('curity');
    expect(svid).not.toBeNull();
    expect(svid!.claims.sub).toBe('spiffe://demo.curity.local/ns/agents/sa/agent-copilot');
    expect(svid!.claims.aud).toBe('https://curity.localtest.me/oauth/v2/oauth-token');
    expect(svid!.audience).toBe('curity');
  });

  it('listAudiences returns configured audiences', () => {
    const source = new SpiffeJwtSvidSource({
      audiences: [
        { audience: 'curity', filePath: join(dir, 'a.jwt') },
        { audience: 'specialist', filePath: join(dir, 'b.jwt') },
      ],
    });
    expect(source.listAudiences()).toEqual(['curity', 'specialist']);
  });

  it('returns null for an unconfigured audience', async () => {
    const source = new SpiffeJwtSvidSource({ audiences: [] });
    expect(await source.getSvid('whatever')).toBeNull();
  });

  it('close is idempotent', () => {
    const source = new SpiffeJwtSvidSource({ audiences: [] });
    source.close();
    source.close();
  });
});
