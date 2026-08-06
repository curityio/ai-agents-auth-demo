import { exchangeToken } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: cfg.svidAudience, filePath: cfg.svidFile }],
});

// Routes and the reason this is express rather than node:http live in app.ts.
const app = createApp({
  cfg,
  getSvid: (audience) => svidSource.getSvid(audience),
  exchange: exchangeToken,
});

app.listen(cfg.port, () => console.log(`exchange-shim on :${cfg.port}`));
