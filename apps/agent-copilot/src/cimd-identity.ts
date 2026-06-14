import { createCimdIdentity, type CimdIdentity } from '@ai-agents-demo/auth-curity';
import type { Config } from './config.js';

// Built once per process from the agent's private key. Shared by the metadata
// routes (publish the JWKS) and the token-exchange callers (the assertion `kid`).
let cached: Promise<CimdIdentity> | undefined;

export function getCimdIdentity(cfg: Config): Promise<CimdIdentity> {
  cached ??= createCimdIdentity({
    privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
    clientId: cfg.agentClientId,
  });
  return cached;
}
