import { calculateJwkThumbprint, exportJWK, importPKCS8, type JWK } from 'jose';

/**
 * Client ID Metadata Document (CIMD) identity for an ephemeral OAuth client.
 *
 * Curity dereferences a client's `client_id` (an HTTPS URL) to fetch this metadata
 * document at token-exchange time, then authenticates the caller's `private_key_jwt`
 * client assertion against the published public key. We publish the key *inline*
 * (`jwks`) so Curity needs only a single fetch.
 *
 * The public key is derived from the private key at construction, so there is one
 * source of truth (the PKCS8 PEM in the agent's Secret) and no public/private drift.
 */
export interface CimdIdentity {
  /** RFC 7638 JWK thumbprint of the public key; the assertion header and JWK share it. */
  readonly kid: string;
  /** The CIMD metadata document Curity fetches at the `client_id` URL. */
  metadataDocument(): CimdMetadataDocument;
  /** The published JWK Set (same single key embedded inline in the metadata document). */
  jwks(): { keys: JWK[] };
}

export interface CimdMetadataDocument {
  client_id: string;
  token_endpoint_auth_method: 'private_key_jwt';
  token_endpoint_auth_signing_alg: 'RS256';
  grant_types: string[];
  jwks: { keys: JWK[] };
}

export interface CreateCimdIdentityParams {
  /** PKCS8 PEM private key (RSA). The public half is derived from it. */
  privateKeyPkcs8Pem: string;
  /** The client's HTTPS client_id URL (must equal the URL Curity dereferences). */
  clientId: string;
}

const SIGNING_ALG = 'RS256';
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';

export async function createCimdIdentity(params: CreateCimdIdentityParams): Promise<CimdIdentity> {
  const key = await importPKCS8(params.privateKeyPkcs8Pem, SIGNING_ALG, { extractable: true });
  const publicJwk = await exportJWK(key);
  // exportJWK on a private key yields private fields; strip to the public components.
  const { d: _d, p: _p, q: _q, dp: _dp, dq: _dq, qi: _qi, ...publicOnly } = publicJwk;
  const kid = await calculateJwkThumbprint(publicOnly);
  const jwk: JWK = { ...publicOnly, kid, use: 'sig', alg: SIGNING_ALG };
  const keySet = { keys: [jwk] };

  return {
    kid,
    metadataDocument(): CimdMetadataDocument {
      return {
        client_id: params.clientId,
        token_endpoint_auth_method: 'private_key_jwt',
        token_endpoint_auth_signing_alg: SIGNING_ALG,
        grant_types: [TOKEN_EXCHANGE_GRANT],
        jwks: keySet,
      };
    },
    jwks() {
      return keySet;
    },
  };
}
