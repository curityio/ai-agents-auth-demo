import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeAll, afterAll } from 'vitest';

// The OTel Node SDK flushes recorded spans to the OTLP/HTTP Collector on
// `sdk.shutdown()`. Unit tests run with no Collector, so that flush would be
// refused (ECONNREFUSED) and `shutdown()` would reject. Export itself is
// intentionally NOT under test here — we only need it to not blow up the
// shutdown path. Stand up a throwaway OTLP/HTTP sink that swallows exports so
// `shutdown()` resolves cleanly.
//
// `setupFiles` runs once per test worker, so a hardcoded port would race
// across parallel workers (EADDRINUSE) and could collide with a real OTLP
// collector on the dev machine. Instead we bind to an ephemeral port (0 = OS
// picks a free one) and point this worker's exporter at it via
// OTEL_EXPORTER_OTLP_ENDPOINT — each worker gets its own private sink.
let collector: Server | undefined;

beforeAll(async () => {
  collector = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-protobuf' });
      res.end();
    });
  });
  // Bind to an ephemeral port on loopback; the OS assigns a free one.
  await new Promise<void>((resolve) => collector!.listen(0, '127.0.0.1', resolve));
  // Read the assigned port and steer this worker's OTLPTraceExporter at it.
  // The trace exporter appends `/v1/traces`; the sink accepts any path.
  const { port } = collector!.address() as AddressInfo;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  if (collector) {
    await new Promise<void>((resolve) => collector!.close(() => resolve()));
    collector = undefined;
  }
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
});
