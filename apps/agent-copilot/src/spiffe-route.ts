import type { Request, Response } from 'express';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';

const source = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

/**
 * Debug endpoint: returns the agent's SPIFFE identity (decoded JWT-SVID claims).
 * Debug-only; gate behind a DEBUG flag before production. Never returns the raw JWT.
 */
export async function spiffeIdHandler(_req: Request, res: Response): Promise<void> {
  const svid = await source.getSvid(SVID_AUDIENCE);
  if (!svid) {
    res.status(503).json({ error: 'spiffe_svid_unavailable' });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  res.json({
    sub: svid.claims.sub,
    aud: svid.claims.aud,
    iss: svid.claims.iss,
    iat: svid.claims.iat,
    exp: svid.claims.exp,
    ttl_seconds: svid.claims.exp - now,
  });
}
