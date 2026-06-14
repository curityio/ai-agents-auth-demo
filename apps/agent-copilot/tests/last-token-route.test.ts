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
    expect(out).toEqual({ showObs: false, showSpec: false });
  });

  it('surfaces the obs exchange when it was minted from the CURRENT inbound token', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
      undefined,
    );
    expect(out).toEqual({ showObs: true, showSpec: false });
  });

  it('fails closed when the inbound token has no jti', () => {
    const out = selectDownstreamBranch(
      { sub: 'alice', jti: undefined },
      { sub: 'alice', subjectJti: undefined, at: NOW },
      undefined,
    );
    expect(out).toEqual({ showObs: false, showSpec: false });
  });

  it('does not surface another user\'s exchange even with a matching-looking jti', () => {
    const out = selectDownstreamBranch(
      { sub: 'bob', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
      undefined,
    );
    expect(out).toEqual({ showObs: false, showSpec: false });
  });

  it('shows only the most-recently-exercised branch when both match the current token', () => {
    const obsNewer = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW + 5 },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
    );
    expect(obsNewer).toEqual({ showObs: true, showSpec: false });

    const specNewer = selectDownstreamBranch(
      { sub: 'alice', jti: 'NEW' },
      { sub: 'alice', subjectJti: 'NEW', at: NOW },
      { sub: 'alice', subjectJti: 'NEW', at: NOW + 5 },
    );
    expect(specNewer).toEqual({ showObs: false, showSpec: true });
  });
});
