import { describe, it, expect } from 'vitest';
import { buildResource } from './resource.js';

describe('buildResource', () => {
  it('sets spiffe.id when provided', () => {
    const r = buildResource('spiffe://demo.curity.local/ns/agents/sa/agent-copilot');
    expect(r.attributes['spiffe.id']).toBe(
      'spiffe://demo.curity.local/ns/agents/sa/agent-copilot',
    );
  });

  it('falls back to "unknown" when null', () => {
    const r = buildResource(null);
    expect(r.attributes['spiffe.id']).toBe('unknown');
  });
});
