import { startTelemetry } from './telemetry.js';

// Side-effect entry: loaded via `node --import @ai-agents-demo/otel-bootstrap`
// BEFORE the app, so auto-instrumentation can patch modules as they load.
const sdk = startTelemetry();

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    sdk
      .shutdown()
      .catch((e) => console.error('[otel-bootstrap] shutdown error', e))
      .finally(() => process.exit(0));
  });
}

export { startTelemetry } from './telemetry.js';
export { buildResource } from './resource.js';
export { INSTRUMENTATION_CONFIG, NOISY_INSTRUMENTATIONS } from './instrumentation-config.js';
