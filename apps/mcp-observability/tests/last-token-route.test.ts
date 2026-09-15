/**
 * Unit tests for buildChain — the rows mcp-observability's /last-token contributes to the
 * OBO-chain view.
 *
 * Both rows must come from the last REAL tool call. In particular the
 * "agentgateway → mcp-observability" row must NOT be decoded from the /last-token request's
 * own bearer: the chain walk travels through agentgateway too, so that bearer
 * is a token the exchange-shim minted for the walk — same claims shape, but a
 * different jti and a full TTL, i.e. not the token the flow ran with.
 */
import { describe, it, expect } from 'vitest';
import { buildChain } from '../src/last-token-route.js';

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'k' })}.${b64(payload)}.sig`;
}

const INBOUND = jwt({ sub: 'alice', aud: 'mcp-observability', jti: 'flow-inbound' });
const EXCHANGED = jwt({ sub: 'alice', aud: 'obs-api', jti: 'flow-exchanged' });

describe('buildChain', () => {
  it('builds BOTH rows from the last tool call: inbound subject token, then the obs-api token', () => {
    const chain = buildChain({ subjectToken: INBOUND, accessToken: EXCHANGED, at: 1 }, false);
    expect(chain.map((h) => h.hop)).toEqual(['agentgateway → mcp-observability', 'mcp-observability → obs-api']);
    expect(chain[0]!.payload).toMatchObject({ jti: 'flow-inbound' });
    expect(chain[1]!.payload).toMatchObject({ jti: 'flow-exchanged' });
    expect(chain[0]!.token).toBeUndefined();
  });

  it('contributes nothing when no tool call has run — it does not fall back to the caller\'s bearer', () => {
    expect(buildChain(undefined, false)).toEqual([]);
  });

  it('includes raw tokens only when asked', () => {
    const chain = buildChain({ subjectToken: INBOUND, accessToken: EXCHANGED, at: 1 }, true);
    expect(chain[0]!.token).toBe(INBOUND);
    expect(chain[1]!.token).toBe(EXCHANGED);
  });
});
