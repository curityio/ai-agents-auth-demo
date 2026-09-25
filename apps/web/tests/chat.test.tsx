/**
 * The Ask card: honest copy, prompts grouped by what they do, the shortcut
 * shown, the prefilled prompt equal to its chip, and the claims the request
 * will carry stated before Send. Failures are typed: a denial is a verdict,
 * not a transport error.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Chat } from '../src/app/chat';
import { RequestFailure } from '../src/components/request-failure';
import { SUGGESTIONS } from '../src/lib/chat-rules';

describe('Chat — Ask card', () => {
  const html = renderToStaticMarkup(
    <Chat asking={{ sub: 'alice', roles: ['sre', 'oncall'], acr: 'html-form' }} />,
  );
  const ask = html.match(/<div[^>]*id="ask"[\s\S]*?id="identities"/)?.[0] ?? '';

  it('does not promise instant answers', () => {
    expect(ask).not.toMatch(/instantly/);
    expect(ask).toMatch(/answered by the copilot directly/);
    expect(ask).toMatch(/route to the specialist/);
  });

  it('prefills the box with the first example prompt, verbatim', () => {
    expect(ask).toMatch(new RegExp(`<textarea[^>]*>${SUGGESTIONS[0]!.text}</textarea>`));
  });

  it('groups the prompts under Inspect and Act instead of a legend row', () => {
    expect(ask).toMatch(/data-prompt-group="Inspect"/);
    expect(ask).toMatch(/data-prompt-group="Act"/);
    expect(ask).not.toMatch(/Prompt legend/);
    expect(ask).not.toContain('→');
    const inspect = ask.match(/data-prompt-group="Inspect"[\s\S]*?data-prompt-group="Act"/)![0];
    for (const s of SUGGESTIONS.filter((s) => s.tier === 'read')) expect(inspect).toContain(s.text);
    for (const s of SUGGESTIONS.filter((s) => s.tier === 'write'))
      expect(inspect).not.toContain(s.text);
  });

  it('tints the Inspect eye lilac — the colour the hero and Tools panel use for the read tier', () => {
    const inspect = ask.match(/data-prompt-group="Inspect"[\s\S]*?<\/span>/)![0];
    expect(inspect).toMatch(/lucide-eye[^"]*text-accent-violet|text-accent-violet[^"]*lucide-eye/);
    const act = ask.match(/data-prompt-group="Act"[\s\S]*?<\/span>/)![0];
    expect(act).not.toMatch(/text-accent-violet/);
  });

  it('shows the Cmd+Enter shortcut next to Send', () => {
    expect(ask).toMatch(/<kbd[^>]*>⌘<\/kbd>/);
    expect(ask).toMatch(/Cmd or Ctrl \+ Enter/);
  });

  it('says who is asking, with roles and acr, before the request is sent', () => {
    const line = ask.match(/data-asking-as[\s\S]*?<\/p>/)?.[0] ?? '';
    expect(line).toMatch(/Asking as/);
    expect(line).toMatch(/alice/);
    expect(line).toMatch(/sre, oncall/);
    expect(line).toMatch(/html-form/);
    expect(line).toMatch(/privileged prompts will step up to MFA/);
  });

  it('drops the step-up hint once the token already carries acr=mfa', () => {
    const mfa = renderToStaticMarkup(
      <Chat asking={{ sub: 'alice', roles: ['sre'], acr: 'mfa' }} />,
    );
    const line = mfa.match(/data-asking-as[\s\S]*?<\/p>/)?.[0] ?? '';
    expect(line).toMatch(/mfa/);
    expect(line).not.toMatch(/step up/);
  });

  it('renders without the asking line when the claims are unknown', () => {
    const anon = renderToStaticMarkup(<Chat />);
    expect(anon).not.toMatch(/data-asking-as/);
    expect(anon).toMatch(/id="ask"/);
  });
});

describe('Chat — Workload identities card', () => {
  const panel = (html: string) =>
    html.match(/<div[^>]*id="identities"[\s\S]*?id="chain"/)?.[0] ?? '';

  it('says no flow has run yet instead of conjuring a read chain', () => {
    const html = panel(renderToStaticMarkup(<Chat preview={{ svids: [] }} />));
    expect(html).toMatch(/No flow yet/);
    expect(html).toMatch(/ask the copilot a question first/);
    expect(html).not.toMatch(/Read flow/);
    expect(html).not.toContain('data-chain-cards');
  });

  it('renders the chain cards once a flow has populated the panel', () => {
    const svid = {
      workload: 'web',
      sub: 'spiffe://demo.curity.local/ns/web/sa/web',
      aud: ['https://curity.localtest.me/oauth/v2/oauth-token'],
      iss: 'https://oidc-discovery.demo.curity.local',
      iat: 1000,
      exp: 1300,
      ttl_seconds: 300,
    };
    const html = panel(renderToStaticMarkup(<Chat preview={{ svids: [svid] }} />));
    expect(html).not.toMatch(/No flow yet/);
    expect(html).toContain('data-chain-cards');
  });
});

describe('RequestFailure', () => {
  it('shows a denial as a verdict, in prose', () => {
    const html = renderToStaticMarkup(
      <RequestFailure failure={{ kind: 'denied', reason: 'role sre required for ops:write' }} />,
    );
    expect(html).toMatch(/Access denied/);
    expect(html).not.toMatch(/Request failed/);
    expect(html).toMatch(/role sre required for ops:write/);
    expect(html).not.toMatch(/font-mono[^"]*"[^>]*>role sre required/);
  });
  it('shows a transport failure with the friendly message and the raw detail', () => {
    const html = renderToStaticMarkup(
      <RequestFailure
        failure={{
          kind: 'failed',
          message: "Couldn't reach the agent.",
          detail: 'HTTP 502 · {"error":"upstream_error"}',
        }}
      />,
    );
    expect(html).toMatch(/Request failed/);
    expect(html).toMatch(/Couldn&#x27;t reach the agent\./);
    expect(html).toMatch(/HTTP 502 · \{&quot;error&quot;:&quot;upstream_error&quot;\}/);
  });
});
