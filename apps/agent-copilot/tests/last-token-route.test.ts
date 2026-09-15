/**
 * Unit tests for selectDownstreamBranch — the OBO-chain hop selector.
 *
 * Regression: the process-global exchange slots persist across logins. After a
 * FRESH login (new inbound token) WITHOUT running a flow, a prior session's
 * exchange for the SAME user must NOT leak into the chain. Selection is gated on
 * the subject-token `jti`, not just the `sub`.
 */
import { describe, it, expect } from 'vitest';
import { selectDownstreamBranch } from '../src/last-token-route.js';

const NOW = 1_000;

describe('selectDownstreamBranch — session correlation by jti', () => {
  it('does NOT surface a same-user exchange minted from a DIFFERENT (prior-session) token', () => {
    // alice freshly logged in (jti=NEW); the stale obs slot is alice's too but
    // was minted from a previous session's token (jti=OLD) — the reported bug.
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'OLD', at: NOW },
      undefined,
    );
    expect(out).toEqual({ showObs: false, showSpec: false, showLlm: false });
  });

  it('surfaces the obs exchange when it was minted from the CURRENT inbound token', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
      undefined,
    );
    expect(out).toEqual({ showObs: true, showSpec: false, showLlm: false });
  });

  it('fails closed when the inbound token has no jti', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: undefined },
      { sub: 'alice', subjectJti: undefined, at: NOW },
      undefined,
    );
    expect(out).toEqual({ showObs: false, showSpec: false, showLlm: false });
  });

  it('does not surface another user\'s exchange even with a matching-looking jti', () => {
    const out = selectDownstreamBranch(
      { sub: 'bob', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
      undefined,
    );
    expect(out).toEqual({ showObs: false, showSpec: false, showLlm: false });
  });

  it('shows only the most-recently-exercised branch when both match the current token', () => {
    const obsNewer = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW + 5 },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
    );
    expect(obsNewer).toEqual({ showObs: true, showSpec: false, showLlm: false });

    const specNewer = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
      { sub: 'alice', subjectJti: 'NEW', at: NOW + 5 },
    );
    expect(specNewer).toEqual({ showObs: false, showSpec: true, showLlm: false });
  });
});

describe('selectDownstreamBranch — the LLM leaf rides with the branch it was minted in', () => {
  // The copilot exchanges → aud=llm-gateway ONLY on the observe path, and only
  // AFTER the mcp-gateway exchange in that same request. So the leaf is shown
  // iff the observe branch is shown and the LLM slot was stamped after it.
  const obs = { sub: 'alice', subjectJti: 'NEW', at: NOW };

  it('shows the LLM leaf next to the observe branch it was minted with', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      obs,
      undefined,
      { sub: 'alice', subjectJti: 'NEW', at: NOW + 1 },
    );
    expect(out).toEqual({ showObs: true, showSpec: false, showLlm: true });
  });

  it('hides a leaf stamped BEFORE the observe exchange (a prior read flow whose LLM hop never re-ran)', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      obs,
      undefined,
      { sub: 'alice', subjectJti: 'NEW', at: NOW - 1 },
    );
    expect(out).toEqual({ showObs: true, showSpec: false, showLlm: false });
  });

  it('hides the copilot leaf under the privileged branch — the copilot never calls the model on that path', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      obs,
      { sub: 'alice', subjectJti: 'NEW', at: NOW + 10 },
      { sub: 'alice', subjectJti: 'NEW', at: NOW + 1 },
    );
    expect(out).toEqual({ showObs: false, showSpec: true, showLlm: false });
  });

  it('applies the same session gate as the branches: a prior-session leaf does not leak in', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      obs,
      undefined,
      { sub: 'alice', subjectJti: 'OLD', at: NOW + 1 },
    );
    expect(out).toEqual({ showObs: true, showSpec: false, showLlm: false });
  });

  it('keeps the two-slot call shape working (no LLM slot → no leaf)', () => {
    const out = selectDownstreamBranch({ sub: 'alice', jti: 'NEW' }, obs, undefined);
    expect(out).toEqual({ showObs: true, showSpec: false, showLlm: false });
  });
});
