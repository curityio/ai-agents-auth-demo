import { describe, it, expect, afterEach } from 'vitest';
import { trace, context, propagation, ROOT_CONTEXT } from '@opentelemetry/api';
import { startTelemetry } from './telemetry.js';
import type { NodeSDK } from '@opentelemetry/sdk-node';

let sdk: NodeSDK | undefined;

afterEach(async () => {
  if (sdk) await sdk.shutdown();
  sdk = undefined;
});

describe('startTelemetry', () => {
  it('starts an SDK that produces recording spans', () => {
    sdk = startTelemetry({ spiffeIdPath: '/nonexistent/svid.jwt' });
    const tracer = trace.getTracer('test');
    tracer.startActiveSpan('unit', (span) => {
      expect(span.isRecording()).toBe(true);
      span.end();
    });
    // active span resolves to the no-op outside a started span
    expect(trace.getSpan(context.active())).toBeUndefined();
  });
});

// W3C trace context is the ONLY wire format. A second format in the composite
// propagator broke the MCP waterfall: agentgateway rewrites `traceparent` to its
// own span but forwards every other header untouched, so a B3 `x-b3-spanid`
// written by the calling agent reached mcp-inspect still naming the CALLER — and
// the composite's extract is a reduce in which the last propagator wins, so the
// server parented to the caller and the gateway looked like a bystander.
describe('propagation', () => {
  const TRACE_ID = 'c3640dceb2bf74d46789b7f1f8aac7e6';
  const GATEWAY_SPAN = '306bc56e519fcf74';
  const CALLER_SPAN = 'c58bf5a004ed3df9';

  it('injects W3C headers only — no x-b3-*', () => {
    sdk = startTelemetry({ spiffeIdPath: '/nonexistent/svid.jwt' });
    const carrier: Record<string, string> = {};
    trace.getTracer('test').startActiveSpan('outbound', (span) => {
      propagation.inject(context.active(), carrier);
      span.end();
    });
    expect(carrier).toHaveProperty('traceparent');
    expect(Object.keys(carrier).filter((k) => k.startsWith('x-b3-') || k === 'b3')).toEqual([]);
  });

  it('parents to traceparent even when a stale x-b3-spanid disagrees', () => {
    sdk = startTelemetry({ spiffeIdPath: '/nonexistent/svid.jwt' });
    const carrier = {
      traceparent: `00-${TRACE_ID}-${GATEWAY_SPAN}-01`,
      'x-b3-traceid': TRACE_ID,
      'x-b3-spanid': CALLER_SPAN,
      'x-b3-sampled': '1',
    };
    const parent = trace.getSpanContext(propagation.extract(ROOT_CONTEXT, carrier));
    expect(parent?.traceId).toBe(TRACE_ID);
    expect(parent?.spanId).toBe(GATEWAY_SPAN);
  });
});
