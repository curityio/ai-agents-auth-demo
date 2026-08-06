import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  CompositePropagator,
  W3CTraceContextPropagator,
  W3CBaggagePropagator,
} from '@opentelemetry/core';
import { B3Propagator, B3InjectEncoding } from '@opentelemetry/propagator-b3';
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
 * composite W3C tracecontext + baggage + B3 propagator (spec D8). The
 * `spiffe.id` resource attribute is read synchronously before start.
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
        new B3Propagator({ injectEncoding: B3InjectEncoding.MULTI_HEADER }),
      ],
    }),
  });
  sdk.start();
  return sdk;
}
