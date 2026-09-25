import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { SESSION_TOKENS_ENDPOINT } from '../src/components/session-tokens-view';

// The page is a client component, so its fetch runs in the browser and no
// server-side render exercises it. Pin the contract instead: the endpoint it
// fetches must be an App Router route that exists in this tree. When the token
// viewer moved from /inspect to /tokens the API route moved with it but the
// component kept fetching the old path, and nothing failed until a browser did.
describe('SessionTokensView', () => {
  it('fetches an /api route that exists', () => {
    expect(SESSION_TOKENS_ENDPOINT).toMatch(/^\/api\//);
    const routeFile = path.resolve(__dirname, '../src/app', SESSION_TOKENS_ENDPOINT.slice(1), 'route.ts');
    expect(existsSync(routeFile), `${SESSION_TOKENS_ENDPOINT} has no route.ts at ${routeFile}`).toBe(true);
  });
});
