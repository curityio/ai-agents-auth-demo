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

describe('SUGGESTION_GROUPS', () => {
  it('splits the prompts into an Observe group and an Act group, in that order', async () => {
    const { SUGGESTION_GROUPS } = await import('../src/lib/chat-rules');
    expect(SUGGESTION_GROUPS.map((g) => g.label)).toEqual(['Observe', 'Act']);
    expect(SUGGESTION_GROUPS[0]!.prompts.every((s) => s.tier === 'read')).toBe(true);
    expect(SUGGESTION_GROUPS[1]!.prompts.every((s) => s.tier === 'write')).toBe(true);
    expect(SUGGESTION_GROUPS.flatMap((g) => g.prompts)).toEqual([...SUGGESTIONS]);
  });
});

describe('DEFAULT_PROMPT', () => {
  it('is the first example prompt, verbatim, so the prefilled box and the chip agree', async () => {
    const { DEFAULT_PROMPT } = await import('../src/lib/chat-rules');
    expect(DEFAULT_PROMPT).toBe(SUGGESTIONS[0]!.text);
  });
});

describe('classifyAgentFailure', () => {
  it('recognises the RFC 9470 step-up challenge', async () => {
    const { classifyAgentFailure } = await import('../src/lib/chat-rules');
    expect(
      classifyAgentFailure(401, { kind: 'step-up', acrValues: 'mfa', scope: 'ops:write' }),
    ).toEqual({ kind: 'step-up', acrValues: 'mfa', scope: 'ops:write' });
  });
  it('treats a typed 403 as a verdict with a reason, not a failure', async () => {
    const { classifyAgentFailure } = await import('../src/lib/chat-rules');
    expect(
      classifyAgentFailure(403, { kind: 'access-denied', reason: 'role sre required' }),
    ).toEqual({ kind: 'denied', reason: 'role sre required' });
  });
  it('maps anything else to a friendly message and keeps the raw detail', async () => {
    const { classifyAgentFailure } = await import('../src/lib/chat-rules');
    const f = classifyAgentFailure(502, { error: 'upstream_error' });
    expect(f.kind).toBe('failed');
    if (f.kind !== 'failed') throw new Error('unreachable');
    expect(f.message).toMatch(/reach the agent/);
    expect(f.detail).toBe('HTTP 502 · {"error":"upstream_error"}');
    const expired = classifyAgentFailure(401, { error: 'session_expired' });
    expect(expired.kind === 'failed' && expired.message).toMatch(/session has expired/);
    const bare = classifyAgentFailure(500, undefined);
    expect(bare.kind === 'failed' && bare.detail).toBe('HTTP 500');
  });
});
