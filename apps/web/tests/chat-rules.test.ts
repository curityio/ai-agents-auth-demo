/**
 * Small pure rules the chat surface relies on, kept out of the component so
 * they can be pinned: which flow a response belongs to (drives which workload
 * identities to show and whether the chain auto-loads), and the tier tag on
 * each example prompt (drives the chip icon so the audience can predict MFA).
 */
import { describe, it, expect } from 'vitest';
import { flowOf, panelsToRefresh, SUGGESTIONS } from '../src/lib/chat-rules';

describe('flowOf', () => {
  it('is privileged when the copilot routed to the specialist', () => {
    expect(flowOf({ route: 'a2a:specialist' })).toBe('privileged');
    expect(flowOf({ specialist: { ok: true } })).toBe('privileged');
  });
  it('is read otherwise', () => {
    expect(flowOf({})).toBe('read');
    expect(flowOf({ route: undefined, specialist: undefined })).toBe('read');
  });
});

describe('panelsToRefresh', () => {
  it('loads nothing by itself: the presenter opens each panel as they explain it', () => {
    expect(panelsToRefresh({ svidsOpen: false, oboOpen: false, toolsOpen: false })).toEqual({
      chain: false,
      svids: false,
      tools: false,
    });
  });
  it('refreshes only the panels that are already open, so an open panel never goes stale', () => {
    expect(panelsToRefresh({ svidsOpen: true, oboOpen: true, toolsOpen: false })).toEqual({
      chain: true,
      svids: true,
      tools: false,
    });
  });
});

describe('SUGGESTIONS', () => {
  it('tags every example prompt with a tier, and both tiers are represented', () => {
    const tiers = new Set(SUGGESTIONS.map((s) => s.tier));
    expect(tiers).toEqual(new Set(['read', 'write']));
    for (const s of SUGGESTIONS) expect(s.text.length).toBeGreaterThan(0);
  });
  it('puts the read prompts first so the demo starts without MFA', () => {
    const firstWrite = SUGGESTIONS.findIndex((s) => s.tier === 'write');
    expect(SUGGESTIONS.slice(0, firstWrite).every((s) => s.tier === 'read')).toBe(true);
  });
});
