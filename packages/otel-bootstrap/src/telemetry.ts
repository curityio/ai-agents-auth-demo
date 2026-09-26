import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
} from '@opentelemetry/core';
import { readSpiffeIdSync } from '@ai-agents-demo/spiffe';
import { buildResource } from './resource.js';
import { INSTRUMENTATION_CONFIG } from './instrumentation-config.js';

export interface StartTelemetryOptions {
  /** Path to the on-disk SVID. Defaults to SPIFFE_SVID_PATH or the helper's path. */
  spiffeIdPath?: string;
}

/**
 * Start the OTel Node SDK: auto-instrumentation (http/express/undici/fetch),
 * OTLP/proto export to the Collector (OTEL_EXPORTER_OTLP_ENDPOINT), and a
 * composite W3C tracecontext + baggage propagator. The `spiffe.id` resource
 * attribute is read synchronously before start.
 *
 * W3C is the ONLY trace-context format, deliberately. B3 used to ride along
 * (multi-header `x-b3-*`) and broke the MCP waterfall: agentgateway rewrites
 * `traceparent` to its own span but forwards every other header untouched, so
 * the calling agent's `x-b3-spanid` reached mcp-inspect still naming the caller,
 * and the composite's extract is a reduce in which the LAST propagator wins. The
 * MCP server parented to the caller and the gateway looked like a bystander
 * (CLAUDE.md fact #29). Nothing here consumes B3 — agentgateway, @vercel/otel and
 * this SDK all speak W3C — so do not add it back.
 */
export function startTelemetry(opts: StartTelemetryOptions = {}): NodeSDK {
  const svidPath =
    opts.spiffeIdPath ??
    process.env.SPIFFE_SVID_PATH ??
    '/run/spiffe/curity-actor.jwt';

  const sdk = new NodeSDK({
    resource: buildResource(readSpiffeIdSync(svidPath)),
    traceExporter: new OTLPTraceExporter(), // reads OTEL_EXPORTER_OTLP_ENDPOINT
    // See instrumentation-config: net/dns/fs are off so the waterfall shows the
    // delegation chain rather than a third of a screen of tcp/tls connects.
    instrumentations: [getNodeAutoInstrumentations(INSTRUMENTATION_CONFIG)],
    textMapPropagator: new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  });
  sdk.start();
  return sdk;
}
