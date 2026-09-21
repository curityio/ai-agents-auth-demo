/**
 * Pure view rules for the header pill: how long the Curity access token has
 * left. Auth.js stores `account.expires_at` in SECONDS; the clock is in ms.
 */
export interface TokenLifetime {
  /** Whole seconds remaining, never negative. */
  remaining: number;
  level: 'ok' | 'low' | 'expired';
  label: string;
}

const LOW_SECONDS = 60;

export function tokenLifetime(expiresAt: number | undefined, now: number): TokenLifetime | null {
  if (expiresAt === undefined) return null;
  const remaining = Math.max(0, Math.floor(expiresAt - now / 1000));
  if (remaining === 0) return { remaining, level: 'expired', label: 'expired' };
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  const label = m > 0 ? `${m}m ${s}s left` : `${s}s left`;
  return { remaining, level: remaining < LOW_SECONDS ? 'low' : 'ok', label };
}
