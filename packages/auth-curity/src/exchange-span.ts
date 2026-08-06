import type { Attributes } from '@opentelemetry/api';

/** The subset of ExchangeTokenParams that describes the exchange (no secrets). */
export interface ExchangeSpanInput {
  tokenEndpoint: string;
  clientId: string;
  audience: string;
  scope: string;
}

/**
 * Build the `auth.token_exchange` span attributes.
 *
 * Pure (no OTel side effects) so it is trivially testable — same split as
 * `buildIdentityAttributes`.
 *
 * Includes the token endpoint deliberately: the authorization semantics
 * (audience/scope) are meaningless without knowing which authorization server
 * issued them, and previously that only existed on the child HTTP span, so the
 * exchange span could not be read on its own. `server.address` / `url.path` are
 * split out because Tempo/TraceQL filters on discrete attributes far better than
 * on a substring of a full URL.
 *
 * Never put the tokens themselves here — subject/actor tokens are credentials and
 * spans are exported off-box.
 */
export function buildExchangeAttributes(input: ExchangeSpanInput): Attributes {
  const attrs: Attributes = {
    'auth.exchange.audience': input.audience,
    'auth.exchange.scope': input.scope,
    'auth.exchange.client_id': input.clientId,
    'auth.exchange.grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange',
    'auth.exchange.token_endpoint': input.tokenEndpoint,
  };
  try {
    const u = new URL(input.tokenEndpoint);
    attrs['server.address'] = u.hostname;
    attrs['url.path'] = u.pathname;
  } catch {
    // Not a parsable URL (misconfiguration). Keep the raw value above and let the
    // exchange itself fail with a legible error rather than throwing from here.
  }
  return attrs;
}
