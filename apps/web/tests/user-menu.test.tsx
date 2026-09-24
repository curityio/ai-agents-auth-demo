import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenCountdown, UserMenu } from '../src/components/user-menu';

const EXP = 1_000_000;

describe('UserMenu pill', () => {
  it('draws the same initials as the landing card, however Curity named the user', () => {
    // No `profile` scope at login, so the session name is often the username or the email.
    for (const name of ['alice', 'alice@demo.curity.local', 'Alice Andersson']) {
      const html = renderToStaticMarkup(<UserMenu name={name} />);
      expect(html, name).toMatch(/data-avatar-initials[^>]*>AA</);
    }
    expect(renderToStaticMarkup(<UserMenu name="bob" />)).toMatch(/>BB</);
    expect(renderToStaticMarkup(<UserMenu name="carol" />)).toMatch(/>CC</);
    // someone off the persona sheet still gets initials from what we have
    expect(renderToStaticMarkup(<UserMenu name="dave" />)).toMatch(/>DA</);
  });
  it('shows acr=mfa as a green badge beside the name', () => {
    const html = renderToStaticMarkup(
      <UserMenu name="alice" acr="mfa" expiresAt={EXP} now={(EXP - 300) * 1000} />,
    );
    const badge = html.match(/<[^>]*data-acr[^>]*>[^<]*<\/[^>]+>/)?.[0] ?? '';
    expect(badge).toMatch(/>mfa</);
    expect(badge).toMatch(/text-success/);
  });
  it('shows a weaker acr muted, so stepping up is visibly a change', () => {
    const html = renderToStaticMarkup(<UserMenu name="alice" acr="html-form" />);
    const badge = html.match(/<[^>]*data-acr[^>]*>[^<]*<\/[^>]+>/)?.[0] ?? '';
    expect(badge).toMatch(/>html-form</);
    expect(badge).not.toMatch(/text-success/);
  });
  it('shows no badge when the acr is unknown', () => {
    expect(renderToStaticMarkup(<UserMenu name="alice" />)).not.toMatch(/data-acr/);
  });
  it('tints the pill amber inside the last minute of the token', () => {
    const low = renderToStaticMarkup(
      <UserMenu name="alice" acr="mfa" expiresAt={EXP} now={(EXP - 30) * 1000} />,
    );
    expect(low).toMatch(/data-token-low/);
    const ok = renderToStaticMarkup(
      <UserMenu name="alice" acr="mfa" expiresAt={EXP} now={(EXP - 300) * 1000} />,
    );
    expect(ok).not.toMatch(/data-token-low/);
  });
});

describe('TokenCountdown (menu row)', () => {
  it('names the token and its remaining lifetime', () => {
    const html = renderToStaticMarkup(<TokenCountdown expiresAt={EXP} now={(EXP - 372) * 1000} />);
    expect(html).toMatch(/Access token/);
    expect(html).toMatch(/6m 12s left/);
  });
  it('says to sign in again once expired', () => {
    const html = renderToStaticMarkup(<TokenCountdown expiresAt={EXP} now={(EXP + 1) * 1000} />);
    expect(html).toMatch(/expired/);
    expect(html).toMatch(/sign in again/i);
    expect(html).toMatch(/text-destructive/);
  });
  it('renders nothing without an expiry', () => {
    expect(renderToStaticMarkup(<TokenCountdown now={0} />)).toBe('');
  });
});
