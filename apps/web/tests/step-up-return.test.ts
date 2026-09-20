/**
 * The RFC 9470 step-up is a full-page OIDC redirect, so the prompt the user
 * typed has to survive in sessionStorage and be auto-retried ONCE on return.
 * These pure helpers own that handshake so the UI can also tell the user WHY a
 * request is firing by itself after they come back from MFA.
 */
import { describe, it, expect } from 'vitest';
import { stashStepUp, takeStepUpReturn } from '../src/lib/step-up-return';

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
}

describe('step-up return handshake', () => {
  it('returns nothing when no step-up is pending', () => {
    expect(takeStepUpReturn(fakeStorage())).toBeNull();
  });

  it('round-trips the stashed prompt and asks for a retry', () => {
    const s = fakeStorage();
    stashStepUp(s, 'Restart order-service', 'ops:write');
    expect(takeStepUpReturn(s)).toEqual({
      message: 'Restart order-service',
      scope: 'ops:write',
      retry: true,
    });
  });

  it('is one-shot: a second take finds nothing', () => {
    const s = fakeStorage();
    stashStepUp(s, 'x', 'ops:write');
    takeStepUpReturn(s);
    expect(takeStepUpReturn(s)).toBeNull();
    expect(s.length).toBe(0);
  });
});
