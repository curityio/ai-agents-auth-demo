/**
 * The ledger badges show short workload names (fits on a projector) and carry
 * the full SPIFFE ID as a tooltip, so namespace + trust domain stay one hover
 * away without expanding the raw JWT.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DelegationLedger } from '../src/components/delegation-ledger';

const COPILOT = 'spiffe://demo.curity.local/ns/agents/sa/agent-copilot';
const GATEWAY = 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway';
const OBS = 'spiffe://demo.curity.local/ns/mcp/sa/mcp-observability';

const chain = [
  {
    hop: 'user → agent-copilot (inbound)',
    header: {},
    payload: { sub: 'alice', aud: 'agent-copilot', scope: 'obs:read', may_act: { sub: COPILOT } },
  },
  {
    hop: 'agentgateway → mcp-observability',
    header: {},
    payload: {
      sub: 'alice',
      aud: 'mcp-observability',
      scope: 'obs:read',
      act: { sub: GATEWAY, act: { sub: COPILOT } },
      may_act: { sub: OBS },
    },
  },
];

describe('DelegationLedger', () => {
  const html = renderToStaticMarkup(<DelegationLedger chain={chain} />);

  it('puts the full SPIFFE ID on every act badge', () => {
    expect(html).toContain(`title="${COPILOT}`);
    expect(html).toContain(`title="${GATEWAY}`);
  });

  it('puts the full SPIFFE ID on the may_act badge', () => {
    expect(html).toContain(`title="${OBS}"`);
  });

  it('still shows the short name as the badge text', () => {
    expect(html).toMatch(/>agentgateway</);
    expect(html).not.toMatch(/>spiffe:\/\//);
  });

  it('renders the time left relative to the clock it is given', () => {
    const exp = 1_800_000_000;
    const timed = [
      {
        hop: 'user → agent-copilot (inbound)',
        header: {},
        payload: { sub: 'alice', iat: exp - 300, exp },
      },
    ];
    expect(
      renderToStaticMarkup(<DelegationLedger chain={timed} now={(exp - 65) * 1000} />),
    ).toContain('ttl 5m · 1m 5s left');
    expect(
      renderToStaticMarkup(<DelegationLedger chain={timed} now={(exp - 64) * 1000} />),
    ).toContain('ttl 5m · 1m 4s left');
    expect(
      renderToStaticMarkup(<DelegationLedger chain={timed} now={(exp + 1) * 1000} />),
    ).toContain('expired');
  });
});
