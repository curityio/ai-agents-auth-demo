import { describe, it, expect, afterEach } from 'vitest';
import { trace, context } from '@opentelemetry/api';
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
