import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorkloadIdentities } from '../src/components/workload-identities';
import type { SvidView } from '../src/lib/svid-view';

const ISS = 'https://oidc-discovery.demo.curity.local';
const AUD = 'https://curity.localtest.me/oauth/v2/oauth-token';
const mk = (workload: string, ns: string): SvidView => ({
  workload,
  sub: `spiffe://demo.curity.local/ns/${ns}/sa/${workload}`,
  aud: [AUD],
  iss: ISS,
  iat: 1000,
  exp: 1300,
  ttl_seconds: 300,
});
const svids = [mk('web', 'web'), mk('agent-copilot', 'agents'), mk('agentgateway', 'mcp')];

describe('WorkloadIdentities', () => {
  const html = renderToStaticMarkup(
    <WorkloadIdentities
      svids={svids}
      flow="read"
      rotated={new Set(['agentgateway'])}
      now={1100 * 1000}
    />,
  );

  it('names the flow and the shared issuer/audience exactly once outside the raw disclosures', () => {
    expect(html).toContain('Read flow');
    const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(visible.split(ISS).length - 1).toBe(1);
    expect(visible.split(AUD).length - 1).toBe(1);
  });

  it('shows each full SPIFFE ID as text with its namespace', () => {
    expect(html.replace(/<wbr\/>/g, '')).toContain(
      'spiffe://demo.curity.local/ns/mcp/sa/agentgateway',
    );
    expect(html).toMatch(/ns\s*<\/span>[^<]*<[^>]*>mcp</);
  });

  it('summarises the chain order in a numbered strip above the cards', () => {
    const strip = html.match(/<ol[^>]*data-chain-strip[\s\S]*?<\/ol>/)?.[0];
    expect(strip, 'chain strip present').toBeTruthy();
    const names = [...strip!.matchAll(/>(web|agent-copilot|agentgateway)</g)].map((m) => m[1]);
    expect(names).toEqual(['web', 'agent-copilot', 'agentgateway']);
    expect(strip!.match(/data-connector/g)?.length).toBe(2);
  });

  it('numbers each card to match the strip', () => {
    const cards = html.match(/<ol[^>]*data-chain-cards[\s\S]*?<\/ol>/)?.[0];
    expect(cards, 'card grid present').toBeTruthy();
    expect(cards).not.toContain('data-connector');
    const numbers = [...cards!.matchAll(/data-chain-index="(\d+)"/g)].map((m) => m[1]);
    expect(numbers).toEqual(['1', '2', '3']);
  });

  it('breaks SPIFFE IDs only at path separators, never inside a segment', () => {
    // Every segment sits in a nowrap span, with a <wbr> only between segments.
    const stripped = html.replace(/<span class="whitespace-nowrap">|<\/span>/g, '');
    expect(stripped).toContain(
      'spiffe://<wbr/>demo.curity.local/<wbr/>ns/<wbr/>web/<wbr/>sa/<wbr/>web',
    );
    expect(html).toMatch(/<span class="whitespace-nowrap">agent-copilot<\/span>/);
  });

  it('renders the live lifetime and marks the rotated card', () => {
    expect(html).toContain('3m 20s left');
    expect(html).toContain('rotated');
  });

  it('keeps raw claims behind a disclosure', () => {
    expect(html).toContain('Raw claims');
    expect(html).toContain('<details');
  });

  it('renders the privileged flow badge in the same amber as the privileged prompt chips', () => {
    const priv = renderToStaticMarkup(
      <WorkloadIdentities svids={svids} flow="privileged" now={1100 * 1000} />,
    );
    const badge =
      priv.match(/<div class="[^"]*"[^>]*>(?:(?!<\/div>).)*Privileged flow<\/div>/)?.[0] ?? '';
    expect(badge).toContain('bg-warn');
    expect(badge).toContain('lucide-lock');
    const read = html.match(/<div class="[^"]*"[^>]*>(?:(?!<\/div>).)*Read flow<\/div>/)?.[0] ?? '';
    expect(read).not.toContain('bg-warn');
    expect(read).toContain('lucide-eye');
  });
});
