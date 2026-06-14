import { describe, it, expect } from 'vitest';
import { buildResourceMetadata } from '../src/protected-resource-metadata.js';

describe('buildResourceMetadata', () => {
  it('publishes resource, authorization_servers, scopes and required acr', () => {
    const doc = buildResourceMetadata({
      resource: 'https://mcp-ops.localtest.me',
      authorizationServer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
      scopesSupported: ['ops:write'],
      acrValuesSupported: ['mfa'],
    });
    expect(doc.resource).toBe('https://mcp-ops.localtest.me');
    expect(doc.authorization_servers).toContain('https://curity.localtest.me/oauth/v2/oauth-anonymous');
    expect(doc.scopes_supported).toContain('ops:write');
    expect(doc.acr_values_supported).toContain('mfa');
    expect(doc.bearer_methods_supported).toEqual(['header']);
  });

  it('omits acr_values_supported when acrValuesSupported is not provided', () => {
    const doc = buildResourceMetadata({
      resource: 'https://mcp-observability.localtest.me',
      authorizationServer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
      scopesSupported: ['obs:read'],
    });
    expect(doc.resource).toBe('https://mcp-observability.localtest.me');
    expect(doc.authorization_servers).toContain('https://curity.localtest.me/oauth/v2/oauth-anonymous');
    expect(doc.scopes_supported).toContain('obs:read');
    expect('acr_values_supported' in doc).toBe(false);
  });
});
