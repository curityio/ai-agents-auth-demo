import type { Request, Response } from 'express';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';

const SVID_AUDIENCE = 'https://curity.localtest.me/oauth/v2/oauth-token';
const SVID_FILE = '/run/spiffe/curity-actor.jwt';

const source = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

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
