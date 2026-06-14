/**
 * Map a failed `fetch` Response from one of the BFF debug routes
 * (/api/obo-chain, /api/inspect) to a friendly, user-facing message.
 *
 * `subject` names what was being loaded, e.g. "the on-behalf-of chain" or
 * "session tokens", and is interpolated into the generic fallbacks.
 */
export async function friendlyFetchError(res: Response, subject: string): Promise<string> {
  let code: string | undefined;
  try {
    code = ((await res.json()) as { error?: string }).error;
  } catch {
    // non-JSON / empty body — fall through to status-based mapping
  }

  if (
    res.status === 401 ||
    code === 'session_expired' ||
    code === 'unauthenticated' ||
    code === 'no_access_token'
  ) {
    return 'Your session has expired. Sign in again to refresh your tokens.';
  }
  if (res.status === 502 || code === 'upstream_error') {
    return `Couldn't reach the agent to load ${subject}. It may be restarting — try again in a moment.`;
  }
  return `Couldn't load ${subject}. Please try again.`;
}
