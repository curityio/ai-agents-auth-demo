/**
 * Deep link from a trace id to Grafana Explore on the Tempo datasource — the
 * one-click proof of the hero's "OpenTelemetry tracing" claim. Tempo keeps
 * traces for 30 minutes, so the link goes stale after that.
 */
export const GRAFANA_URL = process.env.NEXT_PUBLIC_GRAFANA_URL ?? 'https://grafana.localtest.me';

/** Grafana datasource uid, as provisioned in k8s/telemetry/values-grafana.yaml. */
const TEMPO_UID = 'tempo';

export function grafanaTraceUrl(base: string, traceId: string): string {
  const panes = {
    a: {
      datasource: TEMPO_UID,
      queries: [
        {
          refId: 'A',
          datasource: { type: 'tempo', uid: TEMPO_UID },
          queryType: 'traceql',
          query: traceId,
        },
      ],
      range: { from: 'now-1h', to: 'now' },
    },
  };
  const q = new URLSearchParams({ schemaVersion: '1', orgId: '1', panes: JSON.stringify(panes) });
  return `${base.replace(/\/$/, '')}/explore?${q.toString()}`;
}
