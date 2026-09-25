/**
 * The hero is a stage: the landscape topology fills it on wide screens with the
 * copy overlaid in its empty top-left quadrant, and a caption narrates the idle
 * request loop. Nodes and chips jump to the panel that proves each claim — but
 * only when signed in, since the panels do not exist otherwise.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppShell } from '../src/components/app-shell';
import { HeroStage } from '../src/components/hero-stage';

describe('HeroStage', () => {
  const html = renderToStaticMarkup(<HeroStage signedIn />);
  it('draws every workload, both APIs and the Curity bar under them', () => {
    for (const label of [
      'web',
      'agent-copilot',
      'agent-specialist',
      'agentgateway',
      'mcp-inspect',
      'mcp-ops',
      'inspect-api',
      'ops-api',
      'LLM provider',
    ]) {
      expect(html, label).toMatch(new RegExp(`>${label}<`));
    }
    expect(html).toContain('CURITY');
    expect(html).toMatch(/sole token issuer · consulted at every hop/);
    expect(html).not.toMatch(/never in the request path/);
  });
  it('puts the Curity mark in the Curity bar, decorative beside the wordmark', () => {
    const bar = html.match(/<g[^>]*data-curity[^]*?<\/g>/)?.[0] ?? '';
    expect(bar).toMatch(/<svg[^>]*data-curity-mark[^>]*aria-hidden="true"/);
    expect(bar).toMatch(/data-curity-mark[^]*CURITY/);
  });
  it('draws the LLM provider dashed, outside the trust domain, jumping to the chain panel', () => {
    const node = html.match(/<g[^>]*data-node="llm-provider"[^]*?<\/g>/)?.[0] ?? '';
    expect(html).toMatch(/<a[^>]*href="#chain"[^>]*>\s*<g[^>]*data-node="llm-provider"/);
    expect(node).toMatch(/stroke-dasharray="4 3"/);
    expect(node).toMatch(/outside the trust domain/);
    expect(node).not.toMatch(/spiffe:\/\//);
    // every workload stays solid
    const gw = html.match(/<g[^>]*data-node="agentgateway"[^]*?<\/g>/)?.[0] ?? '';
    expect(gw).toContain('<rect');
    expect(gw).not.toMatch(/stroke-dasharray/);
  });
  it('shows only the legend under the picture — no narration, it flips too fast to read', () => {
    expect(html).not.toMatch(/data-hero-caption/);
    expect(html).not.toMatch(/alice signs in/);
    expect(html).toMatch(/token exchange · RFC 8693/);
    expect(html).toMatch(/carrying the token it was issued/);
  });
  it("names the tier each right-hand row is, in that tier's colour", () => {
    expect(html).toMatch(/data-tier-label="read"[^>]*>read tier · inspect:read</);
    expect(html).toMatch(/data-tier-label="privileged"[^>]*>write tier · ops:write · acr=mfa</);
    // Above the top row and below the bottom one — never on the request path.
    expect(html).toMatch(/data-tier-label="read"[^>]*y="5\d(\.\d+)?"/);
    expect(html).toMatch(/data-tier-label="privileged"[^>]*y="26\d(\.\d+)?"/);
  });
  it('explains the packet colours: lilac is a read, amber is privileged', () => {
    expect(html).toMatch(/read · inspect:read/);
    expect(html).toMatch(/privileged · ops:write, acr=mfa/);
  });
  it("keeps the exchange legend swatch neutral — an exchange takes its request's tier colour", () => {
    const swatch = html.match(/<i[^>]*data-legend-exchange[^>]*>/)?.[0] ?? '';
    expect(swatch).toMatch(/border-dashed/);
    expect(swatch).toMatch(/border-white/);
    expect(swatch).not.toMatch(/hsl\(32/); // no amber
  });
  it('renders its footer slot beside the legend', () => {
    const withFooter = renderToStaticMarkup(
      <HeroStage signedIn footer={<span data-footer-probe />} />,
    );
    expect(withFooter).toMatch(/<\/svg>[\s\S]*data-footer-probe[\s\S]*token exchange · RFC 8693/);
  });
  it('tells assistive tech what the picture is', () => {
    expect(html).toMatch(/<svg[^>]*role="img"/);
    expect(html).toMatch(/<svg[^>]*aria-labelledby="hero-stage-title"/);
    expect(html).toMatch(/<title id="hero-stage-title"/);
  });
  it('makes workloads, APIs and Curity jump links with SPIFFE tooltips when signed in', () => {
    expect(html).toMatch(/<a[^>]*href="#identities"[^>]*>(?:(?!<\/a>).)*>agent-copilot</s);
    expect(html).toMatch(/<a[^>]*href="#tools"[^>]*>(?:(?!<\/a>).)*>ops-api</s);
    expect(html).toMatch(/<a[^>]*href="#chain"[^>]*>(?:(?!<\/a>).)*CURITY/s);
    expect(html).toContain('spiffe://demo.curity.local/ns/agents/sa/agent-copilot');
    expect(html).toContain('spiffe://demo.curity.local/ns/mcp/sa/agentgateway');
  });
  it('keeps the nodes inert when signed out', () => {
    const out = renderToStaticMarkup(<HeroStage signedIn={false} />);
    expect(out).not.toMatch(/<a[ >]/);
    expect(out).toMatch(/>agent-copilot</);
  });
});

describe('AppShell hero', () => {
  const html = renderToStaticMarkup(
    <AppShell signedIn displayName="alice">
      <div />
    </AppShell>,
  );
  it('carries no status pill: nothing here checks liveness, so nothing claims it', () => {
    expect(html).not.toMatch(/Live demo/);
    expect(html).not.toMatch(/animate-ping/);
  });
  it('overlays the copy on the stage on wide screens and hides the stage below', () => {
    expect(html).toMatch(/hidden lg:block[^>]*>\s*<div[^>]*data-hero-stage/);
    expect(html).toMatch(/lg:absolute[^"]*lg:max-w-/);
  });
  it('moves the chips under the stage on wide screens and keeps them in the copy below', () => {
    const stage = html.slice(html.indexOf('data-hero-stage'));
    expect(stage).toMatch(/<\/svg>[\s\S]*href="#identities"[\s\S]*SPIFFE workload identity/);
    const overlay = html.slice(html.indexOf('lg:absolute'), html.indexOf('data-hero-stage'));
    expect(overlay).toMatch(/lg:hidden[\s\S]*?<a[^>]*href="#identities"/);
  });
  it('turns the capability chips into jump links when signed in', () => {
    for (const target of ['#identities', '#chain', '#ask', '#result']) {
      expect(html, target).toMatch(new RegExp(`<a[^>]*href="${target}"`));
    }
    expect(html).toContain('SPIFFE workload identity');
    expect(html).not.toContain('Governed LLM egress'); // the stage's LLM node carries that claim
  });
  it('colours each chip icon by what it stands for, text stays white', () => {
    const icon = (label: string) => {
      const m = html.match(
        new RegExp(`<svg[^>]*class="([^"]*)"[^>]*>(?:(?!</svg>).)*</svg>[^<]*${label}`, 's'),
      );
      return m?.[1] ?? '';
    };
    expect(icon('SPIFFE workload identity')).toMatch(/text-accent-violet/);
    // Not amber: amber means privileged on the stage and step-up below it.
    expect(icon('RFC 8693 token exchange')).toMatch(/text-accent-fuchsia/);
    expect(icon('RFC 8693 token exchange')).not.toMatch(/text-warn/);
    expect(icon('RFC 9470 step-up MFA')).toMatch(/text-\[#F7B9DE\]/);
    expect(icon('OpenTelemetry tracing')).toMatch(/text-success/);
    expect(icon('OpenTelemetry tracing')).toMatch(/h-4 w-4/);
  });
  it('keeps the chips inert when signed out', () => {
    const out = renderToStaticMarkup(
      <AppShell signedIn={false}>
        <div />
      </AppShell>,
    );
    expect(out).not.toMatch(/href="#identities"/);
    expect(out).toContain('SPIFFE workload identity');
  });
  it('links to the public source from the footer, signed in or out', () => {
    for (const signedIn of [true, false]) {
      const out = renderToStaticMarkup(
        <AppShell signedIn={signedIn}>
          <div />
        </AppShell>,
      );
      expect(out).toMatch(
        /<a[^>]*href="https:\/\/github\.com\/curityio\/ai-agents-auth-demo"[^>]*rel="noreferrer"[^>]*>[\s\S]*?Source on GitHub/,
      );
      // the GitHub mark leads the link, decorative beside its text
      expect(out).toMatch(
        /<a[^>]*href="https:\/\/github\.com\/curityio\/ai-agents-auth-demo"[^>]*>\s*<svg[^>]*data-github-mark[^>]*aria-hidden="true"[\s\S]*?Source on GitHub/,
      );
    }
  });
});

describe('HeroStage play/pause', () => {
  it('offers a pause button beside the legend, playing by default', () => {
    const html = renderToStaticMarkup(<HeroStage signedIn />);
    const btn = html.match(/<button[^>]*data-hero-toggle[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(btn).toMatch(/aria-label="Pause animation"/);
    expect(btn).toMatch(/aria-pressed="false"/);
    expect(btn).toMatch(/lucide-pause/);
    expect(btn).toMatch(/type="button"/);
  });
  it('reads as Play once stopped', () => {
    const html = renderToStaticMarkup(<HeroStage signedIn initiallyPaused />);
    const btn = html.match(/<button[^>]*data-hero-toggle[^>]*>[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(btn).toMatch(/aria-label="Play animation"/);
    expect(btn).toMatch(/aria-pressed="true"/);
    expect(btn).toMatch(/lucide-play/);
    expect(html).toMatch(/data-hero-stage[^>]*data-paused/);
  });
});
