/**
 * Auto-instrumentations that produce high span volume and no signal for this
 * demo, and are therefore switched off.
 *
 * The traces here exist to make an authorization argument: who delegated to whom,
 * with which audience and scope. `net` emits a `tcp.connect` (and usually a
 * wrapping `tls.connect`) for every single outbound connection — on a read-path
 * trace that was 16 of 47 spans, a third of the waterfall, none of it about
 * delegation. In a live demo that is what the audience has to scroll past.
 *
 * Turning these off does NOT hide failures: a refused connection still fails the
 * enclosing HTTP client span, and a failed token exchange still raises a
 * CurityAuthError recorded on `auth.token_exchange`. What is lost is only the
 * connect-level *timing* breakdown — re-enable `net` if you are ever debugging
 * TLS handshake or DNS latency rather than authorization.
 */
export const NOISY_INSTRUMENTATIONS = [
  '@opentelemetry/instrumentation-net',
  '@opentelemetry/instrumentation-dns',
  '@opentelemetry/instrumentation-fs',
] as const;

import type { Span } from '@opentelemetry/api';
import { httpRequestHook, undiciRequestHook } from './span-names.js';

export interface InstrumentationEntry {
  enabled?: false;
  requestHook?: (span: Span, request: unknown) => void;
}

/**
 * Config passed to `getNodeAutoInstrumentations()`. Two kinds of entry, nothing
 * else: the noisy instrumentations above are DISABLED, and `http` + `undici` get a
 * `requestHook` that renames their spans to `METHOD host/path` (see span-names.ts —
 * a bare `POST` row told the audience nothing). Anything not named here keeps its
 * upstream default; `express` (which gives the servers their `http.route`) is untouched.
 */
export const INSTRUMENTATION_CONFIG: Record<string, InstrumentationEntry> = {
  ...Object.fromEntries(NOISY_INSTRUMENTATIONS.map((name) => [name, { enabled: false as const }])),
  '@opentelemetry/instrumentation-undici': { requestHook: undiciRequestHook },
  '@opentelemetry/instrumentation-http': { requestHook: httpRequestHook },
};
