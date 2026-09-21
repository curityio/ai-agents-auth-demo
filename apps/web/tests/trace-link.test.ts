/**
 * "Open in Grafana" deep-links the trace the copilot just reported into
 * Grafana Explore on the Tempo datasource, so the OpenTelemetry claim in the
 * hero can be proved in one click.
 */
import { describe, it, expect } from 'vitest';
import { GRAFANA_URL, grafanaTraceUrl } from '../src/lib/trace-link';

describe('grafanaTraceUrl', () => {
  it('builds an Explore link that queries the Tempo datasource for the trace id', () => {
    const url = new URL(grafanaTraceUrl('https://grafana.localtest.me', 'abc123'));
    expect(url.origin + url.pathname).toBe('https://grafana.localtest.me/explore');
    expect(url.searchParams.get('schemaVersion')).toBe('1');
    const panes = JSON.parse(url.searchParams.get('panes')!) as Record<string, any>;
    const pane = Object.values(panes)[0];
    expect(pane.queries[0]).toMatchObject({
      datasource: { type: 'tempo', uid: 'tempo' },
      queryType: 'traceql',
      query: 'abc123',
    });
  });
  it('tolerates a trailing slash on the base', () => {
    expect(grafanaTraceUrl('https://g/', 'x')).toMatch(/^https:\/\/g\/explore\?/);
  });
  it('defaults to the demo Grafana host', () => {
    expect(GRAFANA_URL).toBe('https://grafana.localtest.me');
  });
});
