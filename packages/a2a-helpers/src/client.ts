/**
 * A2A client-side helpers — authenticating fetch + AuthenticationHandler shim.
 *
 * The SDK's `Client` accepts an `AuthenticationHandler` that supplies request
 * headers per call. We use it to inject `Authorization: Bearer …` from
 * a caller-supplied token provider. The provider can be sync or async —
 * commonly it triggers an RFC 8693 exchange on the calling agent.
 */

import type {
  AuthenticationHandler,
  HttpHeaders,
} from '@a2a-js/sdk/client';

export type BearerTokenProvider = () => string | Promise<string>;

/**
 * Create an `AuthenticationHandler` that supplies a bearer token on every
 * outbound A2A call.
 *
 * The handler never retries on its own — auth retry is a concern of the
 * caller (the agent's own exchange-and-retry loop, not the A2A SDK). On
 * any non-200 response the SDK surfaces the error to the caller as-is.
 */
export function createBearerAuthHandler(provider: BearerTokenProvider): AuthenticationHandler {
  return {
    headers: async (): Promise<HttpHeaders> => {
      const token = await provider();
      return { authorization: `Bearer ${token}` };
    },
    shouldRetryWithHeaders: async () => undefined,
  };
}
