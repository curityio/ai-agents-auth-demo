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
    payload: {
      sub: 'alice',
      aud: 'agent-copilot',
      scope: 'obs:read',
      roles: ['sre', 'oncall'],
      acr: 'html-form',
      may_act: { sub: COPILOT },
    },
  },
  {
    hop: 'agent-copilot → agentgateway',
    header: {},
    payload: {
      sub: 'alice',
      aud: 'mcp-gateway',
      scope: 'obs:read',
      roles: ['sre', 'oncall'],
      acr: 'html-form',
      act: { sub: COPILOT },
      may_act: { sub: GATEWAY },
    },
  },
  {
    hop: 'agentgateway → mcp-observability',
    header: {},
    payload: {
      sub: 'alice',
      aud: 'mcp-observability',
      scope: 'obs:read',
      roles: ['sre', 'oncall'],
      acr: 'html-form',
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

  it('hoists sub, roles and acr into one facts strip and drops them from matching hops', () => {
    const strip = html.match(/<div[^>]*data-chain-facts[\s\S]*?<\/div>/)?.[0];
    expect(strip, 'facts strip present').toBeTruthy();
    expect(strip).toMatch(/>alice</);
    expect(strip).toMatch(/>sre</);
    expect(strip).toMatch(/>html-form</);
    const hops = html.slice(html.indexOf('<ol'));
    expect(hops).not.toMatch(/>sub<\/span>/);
    expect(hops).not.toMatch(/>roles<\/span>/);
    expect(hops).not.toMatch(/acr html-form/);
  });

  it('shows acr and roles on a hop only where they differ from the root', () => {
    const stepped = [
      ...chain,
      {
        hop: 'agent-specialist → agentgateway',
        header: {},
        payload: {
          sub: 'alice',
          aud: 'mcp-gateway',
          scope: 'ops:write',
          roles: ['sre'],
          acr: 'mfa',
          act: {
            sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-specialist',
            act: { sub: COPILOT },
          },
        },
      },
    ];
    const out = renderToStaticMarkup(<DelegationLedger chain={stepped} />);
    const hops = out.slice(out.indexOf('<ol'));
    expect(hops.match(/acr mfa/g)?.length).toBe(1);
    expect(hops.match(/>roles<\/span>/g)?.length).toBe(1);
    expect(hops).not.toMatch(/acr html-form/);
  });

  it('marks the appended actor with a check instead of a separate permitted strip', () => {
    expect(html).not.toMatch(/may_act<\/span> permitted/);
    const appended = html.match(
      /<(?:span|div)[^>]*title="[^"]*appended by this exchange[^"]*"[^>]*>[\s\S]*?<\/(?:span|div)>/,
    )?.[0];
    expect(appended, 'appended badge present').toBeTruthy();
    expect(appended).toMatch(/lucide-check/);
    expect(appended).toMatch(/may_act/);
  });

  it('keeps a red strip when the presenter was not the actor may_act named', () => {
    const bad = [
      chain[0],
      {
        hop: 'agent-specialist → agentgateway',
        header: {},
        payload: {
          sub: 'alice',
          aud: 'mcp-gateway',
          scope: 'obs:read',
          act: { sub: 'spiffe://demo.curity.local/ns/agents/sa/agent-specialist' },
        },
      },
    ];
    const out = renderToStaticMarkup(<DelegationLedger chain={bad} />);
    expect(out).toMatch(/not the actor hop 0/);
    expect(out).toMatch(/lucide-x/);
  });

  it('renders the LLM leaf as a collapsed side-row and keeps the spine numbered 0, 1, 2', () => {
    const withLeaf = [
      chain[0],
      {
        hop: 'agent-copilot → agentgateway (/llm)',
        header: {},
        payload: { sub: 'alice', aud: 'llm-gateway', scope: 'llm:invoke', act: { sub: COPILOT } },
        note: 'Model call — a leaf, not a hop toward the cluster.',
      },
      chain[1],
      chain[2],
    ];
    const out = renderToStaticMarkup(<DelegationLedger chain={withLeaf} />);
    const leaf = out.match(/<li[^>]*data-leaf[\s\S]*?<\/li>/)?.[0];
    expect(leaf, 'leaf row present').toBeTruthy();
    // visible like any hop: aud, scope, act, may_act; only the raw JWT folds away
    const visible = leaf!.slice(0, leaf!.indexOf('<details'));
    expect(visible).toMatch(/>llm-gateway</);
    expect(visible).toMatch(/>llm:invoke</);
    expect(visible).toMatch(/>act<\/span>/);
    expect(visible).toMatch(/>may_act<\/span>/);
    expect(leaf!.slice(leaf!.indexOf('<details'))).toMatch(/Raw JWT/);
    expect(leaf!.match(/<details/g)?.length).toBe(1);
    expect(leaf).not.toMatch(/data-spine-number/);
    const numbers = [...out.matchAll(/data-spine-number="(\d+)"/g)].map((m) => m[1]);
    expect(numbers).toEqual(['0', '1', '2']);
  });

  it('explains the diff marks in a legend under the facts strip', () => {
    const legend = html.match(/<div[^>]*data-chain-legend[\s\S]*?<\/div>/)?.[0];
    expect(legend, 'legend present').toBeTruthy();
    expect(legend).toMatch(/narrowed by this exchange/);
    expect(legend).toMatch(/dropped by this exchange/);
    expect(legend).toMatch(/appended by this exchange/);
    expect(legend).toMatch(/may_act/);
  });

  it('links the appended actor to its workload identity', () => {
    expect(html).toMatch(
      /<a[^>]*href="#identities"[^>]*>(?:(?!<\/a>).)*appended by this exchange/s,
    );
  });

  it('draws the diff marks as lilac on a purple tint, never a solid fill', () => {
    const aud = html.match(/<[^>]*title="Audience narrowed by this exchange"[^>]*>/)?.[0];
    expect(aud, 'narrowed aud badge').toBeTruthy();
    expect(aud).toMatch(/bg-primary\/15/);
    expect(aud).toMatch(/text-accent-violet/);
    expect(aud).not.toMatch(/bg-primary /);
    const actor = html.match(/<[^>]*title="[^"]*appended by this exchange[^"]*"[^>]*>/)?.[0];
    expect(actor).toMatch(/bg-primary\/15/);
    expect(actor).toMatch(/ring-1 ring-accent-violet\/40/);
    expect(actor).not.toMatch(/ring-primary/);
    const legend = html.match(/<div[^>]*data-chain-legend[\s\S]*?<\/div>/)![0];
    expect(legend).not.toMatch(/bg-primary /);
    expect(legend.match(/bg-primary\/15/g)?.length).toBe(2);
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
