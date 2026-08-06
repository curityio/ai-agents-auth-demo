import { describe, it, expect } from 'vitest';
import { buildExchangeAttributes } from './exchange-span.js';

const base = {
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-observability',
  audience: 'obs-api',
  scope: 'obs:read',
};

describe('buildExchangeAttributes', () => {
  it('records the token endpoint so the span says WHERE the exchange went', () => {
    // Without this the span states what was requested (audience/scope) but not
    // which authorization server issued it — you had to expand the child HTTP
    // span to find out. Every hop in this demo exchanges against Curity, so a
    // span that cannot name its own endpoint is the one thing a reviewer asks
    // about first.
    const attrs = buildExchangeAttributes(base);
    expect(attrs['auth.exchange.token_endpoint']).toBe(
      'https://curity.localtest.me/oauth/v2/oauth-token',
    );
  });

  it('splits the endpoint into server address and path for filterable queries', () => {
    const attrs = buildExchangeAttributes(base);
    expect(attrs['server.address']).toBe('curity.localtest.me');
    expect(attrs['url.path']).toBe('/oauth/v2/oauth-token');
  });

  it('keeps the authorization semantics that were already there', () => {
    const attrs = buildExchangeAttributes(base);
    expect(attrs['auth.exchange.audience']).toBe('obs-api');
    expect(attrs['auth.exchange.scope']).toBe('obs:read');
    expect(attrs['auth.exchange.client_id']).toBe('mcp-observability');
    expect(attrs['auth.exchange.grant_type']).toBe(
      'urn:ietf:params:oauth:grant-type:token-exchange',
    );
  });

  it('still records the raw endpoint when it is not a parsable URL', () => {
    // A misconfigured CURITY_TOKEN_ENDPOINT must not throw from a span helper —
    // the exchange should fail on its own terms with a legible error, not die
    // while being described.
    const attrs = buildExchangeAttributes({ ...base, tokenEndpoint: 'not a url' });
    expect(attrs['auth.exchange.token_endpoint']).toBe('not a url');
    expect(attrs['server.address']).toBeUndefined();
    expect(attrs['url.path']).toBeUndefined();
  });
});
