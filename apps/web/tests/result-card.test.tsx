/**
 * The Result card is self-contained: it repeats the question and names the
 * flow, its Identity tab says WHICH identity it shows and where the narrowed
 * ones are, and its Trace tab links the run to the OpenTelemetry trace.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResultCard, type AgentResponse } from '../src/components/result-card';

const read: AgentResponse = {
  answer: 'Two pods are running.',
  identity: { sub: 'alice', scopes: ['inspect:read', 'openid'], roles: ['sre'], acr: 'html-form' },
  steps: [
    {
      toolCalls: [{ name: 'list_pods', args: { namespace: 'prod' } }],
      toolResults: [{ name: 'list_pods', result: [{ name: 'a' }, { name: 'b' }] }],
      finishReason: 'stop',
    },
  ],
  traceId: 'abcdefabcdefabcdefabcdefabcdef12',
};
const privileged: AgentResponse = {
  answer: 'Restarted.',
  identity: { sub: 'alice', scopes: ['ops:write'], roles: ['sre'], acr: 'mfa' },
  route: 'privileged-a2a',
  intent: { kind: 'restart', deployment: 'order-service', namespace: 'prod' },
  specialist: { ok: true, status: 'completed', text: 'done' },
};

describe('ResultCard header', () => {
  const html = renderToStaticMarkup(<ResultCard response={read} asked="List all pods in prod" />);
  it('carries the same icon square as the other cards', () => {
    const header =
      html.match(/<div class="[^"]*flex flex-col[^"]*"[\s\S]*?Result<\/div>/)?.[0] ?? html;
    expect(header).toMatch(/mesh-hero/);
  });
  it('repeats the question and names the flow', () => {
    const asked = html.match(/data-asked[\s\S]*?<\/q>/)?.[0] ?? '';
    expect(asked).toMatch(/List all pods in prod/);
    expect(asked).toMatch(/Read flow/);
    const priv = renderToStaticMarkup(<ResultCard response={privileged} asked="Restart it" />);
    expect(priv.match(/data-asked[\s\S]*?<\/q>/)?.[0]).toMatch(/Privileged flow/);
  });
  it('omits the question line when none was recorded (preview data)', () => {
    const none = renderToStaticMarkup(<ResultCard response={read} />);
    expect(none).not.toMatch(/data-asked/);
    expect(none).toMatch(/Read flow/);
  });
});

describe('ResultCard identity tab', () => {
  const html = renderToStaticMarkup(<ResultCard response={read} asked="q" defaultTab="identity" />);
  it('says which identity this is and points at the chain for the narrowed ones', () => {
    expect(html).toMatch(/as the copilot received it/);
    expect(html).toMatch(/href="#chain"/);
  });
  it('keeps the JSON behind a Raw disclosure', () => {
    expect(html).toMatch(
      /<details[\s\S]*?<summary[^>]*>Raw claims<\/summary>[\s\S]*?&quot;sub&quot;/,
    );
    const visible = html.replace(/<details[\s\S]*?<\/details>/g, '');
    expect(visible).not.toMatch(/&quot;sub&quot;/);
  });
  it('warns that privileged actions will step up while acr is not mfa, and not once it is', () => {
    expect(html).toMatch(/data-stepup-note/);
    expect(html).toMatch(/step up/);
    const mfa = renderToStaticMarkup(
      <ResultCard response={privileged} asked="q" defaultTab="identity" />,
    );
    expect(mfa).not.toMatch(/data-stepup-note/);
  });
});

describe('ResultCard trace tab', () => {
  it('shows the trace id with a copy button and a Grafana link', () => {
    const html = renderToStaticMarkup(<ResultCard response={read} asked="q" defaultTab="trace" />);
    const row = html.match(/data-trace-id[\s\S]*?<\/div>/)?.[0] ?? '';
    expect(row).toMatch(/abcdefabcdefabcdefabcdefabcdef12/);
    expect(row).toMatch(/Copy/);
    expect(row).toMatch(
      /href="https:\/\/grafana\.localtest\.me\/explore\?[^"]*abcdefabcdefabcdefabcdefabcdef12[^"]*"[^>]*target="_blank"/,
    );
    expect(row).toMatch(/Open in Grafana/);
    expect(row).toMatch(/30 minutes/);
    expect(html).toMatch(/list_pods/);
  });
  it('shows no trace row when the copilot reported no trace id', () => {
    const html = renderToStaticMarkup(
      <ResultCard response={privileged} asked="q" defaultTab="trace" />,
    );
    expect(html).not.toMatch(/data-trace-id/);
    expect(html).toMatch(/privileged-a2a/);
  });
});

describe('ResultCard trace tab — privileged run with steps', () => {
  const restart: AgentResponse = {
    ...privileged,
    steps: [
      {
        toolCalls: [{ name: 'get_deployment', args: { name: 'order-service' } }],
        toolResults: [{ name: 'get_deployment', result: { replicas: 1 } }],
        finishReason: 'tool-calls',
      },
      {
        toolCalls: [{ name: 'restart_deployment', args: { name: 'order-service' } }],
        toolResults: [{ name: 'restart_deployment', result: { ok: true } }],
        finishReason: 'tool-calls',
      },
      {
        toolCalls: [{ name: 'get_deployment', args: { name: 'order-service' } }],
        toolResults: [{ name: 'get_deployment', result: { replicas: 1 } }],
        finishReason: 'stop',
      },
    ],
  };
  const html = renderToStaticMarkup(<ResultCard response={restart} asked="q" defaultTab="trace" />);

  it('introduces the steps as the specialist’s, naming both tiers and the MFA gate', () => {
    expect(html).toMatch(/specialist/);
    expect(html).toMatch(/mcp-ops/);
    expect(html).toMatch(/ops:write/);
    expect(html).toMatch(/acr=mfa/);
    expect(html).not.toMatch(/The copilot&#x27;s LLM chose/);
  });
  it('keeps the route and specialist status visible above the steps', () => {
    expect(html).toMatch(/privileged-a2a/);
    expect(html).toMatch(/completed/);
  });
  it('marks the act step as the ops tier and the reads around it as inspect', () => {
    const rows = [...html.matchAll(/data-tier="(\w+)"/g)].map((m) => m[1]);
    expect(rows).toEqual(['inspect', 'ops', 'inspect']);
    const act = html.match(/data-tier="ops"[\s\S]*?restart_deployment/)?.[0] ?? '';
    expect(act).toMatch(/text-warn/);
    expect(act).toMatch(/lucide-lock/);
  });
  it('still introduces a read run as the copilot’s, with no ops rows', () => {
    const readHtml = renderToStaticMarkup(
      <ResultCard response={read} asked="q" defaultTab="trace" />,
    );
    expect(readHtml).toMatch(/The copilot&#x27;s LLM chose/);
    expect(readHtml).not.toMatch(/data-tier="ops"/);
    expect(readHtml).not.toMatch(/privileged-a2a/);
  });
});
