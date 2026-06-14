// Sign a private_key_jwt client assertion for a CIMD ephemeral client, for use
// by the smoke scripts (which hit Curity's /token endpoint directly).
//
// Usage:  printf '%s' "$PKCS8_PEM" | node scripts/cimd-sign-assertion.mjs <client_id> <token_endpoint>
// Prints the compact JWS assertion to stdout. Mirrors packages/auth-curity
// (createCimdIdentity kid + the exchange.ts assertion claims) so the smoke
// path authenticates exactly like the agents do.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// jose is a dependency of packages/auth-curity (not hoisted to the repo root
// under pnpm's strict layout). Resolve it from that package's context.
const require = createRequire(new URL('../packages/auth-curity/package.json', import.meta.url));
const { importPKCS8, exportJWK, calculateJwkThumbprint, SignJWT } = await import(
  require.resolve('jose')
);

const [clientId, audience] = process.argv.slice(2);
if (!clientId || !audience) {
  console.error('usage: cimd-sign-assertion.mjs <client_id> <token_endpoint>  (PKCS8 PEM on stdin)');
  process.exit(2);
}

const pem = readFileSync(0, 'utf8').trim();
const key = await importPKCS8(pem, 'RS256', { extractable: true });
const jwk = await exportJWK(key);
for (const f of ['d', 'p', 'q', 'dp', 'dq', 'qi']) delete jwk[f];
const kid = await calculateJwkThumbprint(jwk);

const assertion = await new SignJWT({})
  .setProtectedHeader({ alg: 'RS256', kid })
  .setIssuer(clientId)
  .setSubject(clientId)
  .setAudience(audience)
  .setJti(globalThis.crypto.randomUUID())
  .setIssuedAt()
  .setExpirationTime('60s')
  .sign(key);

process.stdout.write(assertion);
