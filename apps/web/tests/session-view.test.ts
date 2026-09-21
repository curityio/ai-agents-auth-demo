/**
 * The header pill is the only sticky element, so it carries the session
 * truth: the acr the next request will present, and how long the 10-minute
 * access token has left — the thing that has silently failed demos.
 */
import { describe, it, expect } from 'vitest';
import { tokenLifetime } from '../src/lib/session-view';

const EXP = 1_000_000; // seconds since epoch, as Auth.js stores account.expires_at

describe('tokenLifetime', () => {
  it('counts down in minutes and seconds', () => {
    expect(tokenLifetime(EXP, (EXP - 372) * 1000)).toEqual({
      remaining: 372,
      level: 'ok',
      label: '6m 12s left',
    });
  });
  it('turns low inside the last minute', () => {
    expect(tokenLifetime(EXP, (EXP - 59) * 1000)).toMatchObject({
      level: 'low',
      label: '59s left',
    });
  });
  it('reports expiry rather than a negative number', () => {
    expect(tokenLifetime(EXP, (EXP + 5) * 1000)).toEqual({
      remaining: 0,
      level: 'expired',
      label: 'expired',
    });
  });
  it('is null when the session carries no expiry', () => {
    expect(tokenLifetime(undefined, 0)).toBeNull();
  });
});
