import { describe, it, expect } from 'vitest';
import { calculateJwkThumbprint, exportJWK, exportPKCS8, generateKeyPair } from 'jose';
import { createCimdIdentity } from './cimd.js';

const CLIENT_ID = 'https://copilot.localtest.me/.well-known/oauth-client';

async function freshPem() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  return { pem: await exportPKCS8(privateKey), publicKey };
}

describe('createCimdIdentity', () => {
  it('builds a CIMD metadata document for private_key_jwt + token-exchange', async () => {
    const { pem } = await freshPem();
    const identity = await createCimdIdentity({ privateKeyPkcs8Pem: pem, clientId: CLIENT_ID });
    const doc = identity.metadataDocument();

    expect(doc.client_id).toBe(CLIENT_ID);
    expect(doc.token_endpoint_auth_method).toBe('private_key_jwt');
    expect(doc.token_endpoint_auth_signing_alg).toBe('RS256');
    expect(doc.grant_types).toContain('urn:ietf:params:oauth:grant-type:token-exchange');
    expect(doc).not.toHaveProperty('client_secret');
  });

  it('publishes exactly one public signing key inline (no private material)', async () => {
    const { pem } = await freshPem();
    const identity = await createCimdIdentity({ privateKeyPkcs8Pem: pem, clientId: CLIENT_ID });
    const doc = identity.metadataDocument();

    expect(doc.jwks.keys).toHaveLength(1);
    const jwk = doc.jwks.keys[0]!;
    expect(jwk.kid).toBe(identity.kid);
    expect(jwk.use).toBe('sig');
    expect(jwk.alg).toBe('RS256');
    expect(jwk).not.toHaveProperty('d');
    expect(jwk).not.toHaveProperty('p');
  });

  it('jwks() returns the same key set as the inline metadata jwks', async () => {
    const { pem } = await freshPem();
    const identity = await createCimdIdentity({ privateKeyPkcs8Pem: pem, clientId: CLIENT_ID });
    expect(identity.jwks()).toEqual(identity.metadataDocument().jwks);
  });

  it('derives kid as the RFC 7638 thumbprint of the public key', async () => {
    const { pem, publicKey } = await freshPem();
    const expectedKid = await calculateJwkThumbprint(await exportJWK(publicKey));
    const identity = await createCimdIdentity({ privateKeyPkcs8Pem: pem, clientId: CLIENT_ID });
    expect(identity.kid).toBe(expectedKid);
  });
});
