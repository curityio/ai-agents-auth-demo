import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SignJWT, generateKeyPair } from 'jose';
import { readSpiffeIdSync } from './read-spiffe-id.js';

let dir: string;
let svidPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'spiffe-'));
  svidPath = join(dir, 'curity-actor.jwt');
  const { privateKey } = await generateKeyPair('RS256');
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setSubject('spiffe://demo.curity.local/ns/agents/sa/agent-copilot')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  writeFileSync(svidPath, jwt, 'utf8');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readSpiffeIdSync', () => {
  it('returns the SVID subject (SPIFFE ID)', () => {
    expect(readSpiffeIdSync(svidPath)).toBe(
      'spiffe://demo.curity.local/ns/agents/sa/agent-copilot',
    );
  });

  it('returns null when the file is missing', () => {
    expect(readSpiffeIdSync(join(dir, 'nope.jwt'))).toBeNull();
  });

  it('returns null for an empty file', () => {
    const p = join(dir, 'empty.jwt');
    writeFileSync(p, '', 'utf8');
    expect(readSpiffeIdSync(p)).toBeNull();
  });

  it('returns null when the JWT has no sub claim', async () => {
    const p = join(dir, 'no-sub.jwt');
    const { privateKey } = await generateKeyPair('RS256');
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    writeFileSync(p, jwt, 'utf8');
    expect(readSpiffeIdSync(p)).toBeNull();
  });
});
