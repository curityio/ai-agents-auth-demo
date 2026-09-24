import { describe, it, expect } from 'vitest';
import { INSTRUMENTATION_CONFIG, NOISY_INSTRUMENTATIONS } from './instrumentation-config.js';
import { undiciRequestHook, httpRequestHook } from './span-names.js';

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
      expect(INSTRUMENTATION_CONFIG[keep]?.enabled).not.toBe(false);
    }
  });

  it('names http/undici spans by host + path via request hooks (bare "POST" told the audience nothing)', () => {
    expect(INSTRUMENTATION_CONFIG['@opentelemetry/instrumentation-undici']?.requestHook).toBe(undiciRequestHook);
    expect(INSTRUMENTATION_CONFIG['@opentelemetry/instrumentation-http']?.requestHook).toBe(httpRequestHook);
  });

  it('never enables something that ships off by default — only disables noise or adds hooks', () => {
    for (const [name, cfg] of Object.entries(INSTRUMENTATION_CONFIG)) {
      if ((NOISY_INSTRUMENTATIONS as readonly string[]).includes(name)) expect(cfg).toEqual({ enabled: false });
      else expect(cfg).not.toHaveProperty('enabled');
    }
  });
});
