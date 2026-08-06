import { describe, it, expect } from 'vitest';
import { INSTRUMENTATION_CONFIG, NOISY_INSTRUMENTATIONS } from './instrumentation-config.js';

describe('INSTRUMENTATION_CONFIG', () => {
  it('disables the net instrumentation, which contributes only tcp/tls connect spans', () => {
    // On a read-path trace these were 16 of 47 spans (34%) and carry nothing for
    // the delegation story this demo tells — they are pure clutter in a live
    // waterfall. Transport failures still surface: the HTTP client span fails and
    // the exchange raises a CurityAuthError.
    expect(INSTRUMENTATION_CONFIG['@opentelemetry/instrumentation-net']).toEqual({
      enabled: false,
    });
  });

  it('disables dns and fs, the other two high-volume no-signal instrumentations', () => {
    expect(INSTRUMENTATION_CONFIG['@opentelemetry/instrumentation-dns']).toEqual({
      enabled: false,
    });
    expect(INSTRUMENTATION_CONFIG['@opentelemetry/instrumentation-fs']).toEqual({
      enabled: false,
    });
  });

  it('keeps every instrumentation the OBO chain is actually reconstructed from', () => {
    // http/undici carry the hop-to-hop spans and the identity attributes; express
    // gives the resource servers their route. Disabling any of these would break
    // the trace, so pin them against a careless addition to the noisy list.
    for (const keep of [
      '@opentelemetry/instrumentation-http',
      '@opentelemetry/instrumentation-undici',
      '@opentelemetry/instrumentation-express',
    ]) {
      expect(NOISY_INSTRUMENTATIONS).not.toContain(keep);
      expect(INSTRUMENTATION_CONFIG[keep]).toBeUndefined();
    }
  });

  it('only ever disables — it never enables something that ships off by default', () => {
    for (const cfg of Object.values(INSTRUMENTATION_CONFIG)) {
      expect(cfg).toEqual({ enabled: false });
    }
  });
});
