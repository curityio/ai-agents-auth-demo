import type { Span } from '@opentelemetry/api';

/**
 * Legible span names for the auto-instrumented HTTP hops.
 *
 * The OpenTelemetry conventions name a client span by METHOD alone (`POST`) and a
 * server span by METHOD + route only once a router has set `http.route` — which
 * the ESM services here often never get (fact #28's module-patching race also
 * bites the express instrumentation). In Grafana that leaves a waterfall of bare
 * `agent-copilot POST` rows: the discovery probe, the RFC 9728 fetch, the token
 * exchange and the tool call all read the same until you click each one.
 *
 * These hooks rename the span to `METHOD /path` in both directions, query string
 * dropped. Path only, no host: every path in this system is distinct enough on its
 * own (`/inspect/mcp`, `/oauth/v2/oauth-token`, `/llm/chat/completions`,
 * `/pods`), and the host stays one click away in `server.address`. The conventions
 * avoid paths in span names because of cardinality; every path in this demo is
 * fixed, so that concern does not apply — do NOT lift this unchanged into a service
 * with user-shaped paths.
 */
export function outboundSpanName(method: string, _origin: string, path: string): string {
  return inboundSpanName(method, path);
}

export function inboundSpanName(method: string, url: string): string {
  const q = url.indexOf('?');
  return `${method} ${q === -1 ? url : url.slice(0, q)}`;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null;
const str = (v: unknown): v is string => typeof v === 'string';

/** `@opentelemetry/instrumentation-undici` requestHook: fetch() client spans. */
export function undiciRequestHook(span: Span, request: unknown): void {
  if (!isRec(request) || !str(request.method) || !str(request.origin) || !str(request.path)) return;
  span.updateName(outboundSpanName(request.method, request.origin, request.path));
}

/**
 * `@opentelemetry/instrumentation-http` requestHook. It fires for BOTH directions:
 * an IncomingMessage (server; has `url`) and a ClientRequest (client; has `path`). If a router later sets `http.route`, the instrumentation renames the
 * server span to `METHOD route` at response end — the same text for this repo.
 */
export function httpRequestHook(span: Span, request: unknown): void {
  if (!isRec(request) || !str(request.method)) return;
  if (str(request.path)) {
    span.updateName(inboundSpanName(request.method, request.path));
    return;
  }
  if (str(request.url)) span.updateName(inboundSpanName(request.method, request.url));
}
