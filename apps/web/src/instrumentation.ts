import { registerOTel } from '@vercel/otel';

// Next.js auto-loads this `register()` on server start (App Router, Next 15).
// @vercel/otel reads OTEL_EXPORTER_OTLP_ENDPOINT and exports OTLP/HTTP to the
// Collector. It auto-instruments fetch, so the BFF -> agent-copilot call
// continues the same trace.
//
// propagateContextUrls is REQUIRED: @vercel/otel defaults it to [] and so does
// NOT inject the W3C `traceparent` header on outgoing fetch (a safeguard against
// leaking trace context to third parties). Without it the BFF span starts its
// own trace and agent-copilot never joins it. We allow-list all URLs because
// this BFF only ever calls in-cluster services (agent-copilot, Curity, MCP
// metadata) — there is no untrusted egress to leak to.
export function register() {
  registerOTel({
    serviceName: process.env.OTEL_SERVICE_NAME ?? 'web',
    instrumentationConfig: {
      fetch: { propagateContextUrls: [/.*/] },
    },
  });
}
