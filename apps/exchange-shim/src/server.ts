import { createServer } from 'node:http';
import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { loadConfig } from './config.js';
import { handleExchange } from './exchange-handler.js';

const cfg = loadConfig();
const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: cfg.svidAudience, filePath: cfg.svidFile }],
});

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/exchange') {
    res.writeHead(404).end();
    return;
  }
  const callerAuth = req.headers['x-caller-authorization'];
  const targetAudience = req.headers['x-target-audience'];
  if (typeof callerAuth !== 'string' || typeof targetAudience !== 'string') {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid_request' }));
    return;
  }
  const callerToken = callerAuth.replace(/^Bearer\s+/i, '');
  handleExchange(
    { callerToken, targetAudience },
    {
      getSvidJwt: async () => {
        const svid = await svidSource.getSvid(cfg.svidAudience);
        if (!svid) throw new CurityAuthError(`SVID not available at ${cfg.svidFile}`, 'invalid_actor');
        return svid.jwt;
      },
      exchange: exchangeToken,
      tokenEndpoint: cfg.tokenEndpoint,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      audienceScopes: cfg.audienceScopes,
    },
  )
    .then((body) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    })
    .catch((e) => {
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'exchange_failed', error_description: (e as Error).message }),
      );
    });
});

server.listen(cfg.port, () => console.log(`exchange-shim on :${cfg.port}`));
