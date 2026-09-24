/**
 * View model for the read-path Trace tab: turns the copilot's `steps` (AI SDK
 * tool-calling steps, in OUR `{name, args}` / `{name, result}` wire shape) into
 * one row per tool call, with the args flattened and the result summarised.
 */
import { describe, it, expect } from 'vitest';
import { buildTraceRows, summarizeResult, type TraceStep } from '../src/lib/trace-view';

const STEPS: TraceStep[] = [
  {
    toolCalls: [{ name: 'list_pods', args: { namespace: 'prod' } }],
    toolResults: [{ name: 'list_pods', result: { count: 4, namespace: 'prod' } }],
    finishReason: 'tool-calls',
  },
  {
    toolCalls: [
      { name: 'get_pod_logs', args: { pod: 'order-service-1', tail: 50 } },
      { name: 'get_deployment', args: { name: 'order-service' } },
    ],
    toolResults: [
      { name: 'get_pod_logs', result: 'line 1\nline 2' },
      { name: 'get_deployment', result: { image: 'busybox:1.36', replicas: 2 } },
    ],
    finishReason: 'stop',
  },
];

describe('buildTraceRows', () => {
  it('emits one row per tool call, numbered across steps', () => {
    const rows = buildTraceRows(STEPS);
    expect(rows.map((r) => [r.index, r.step, r.tool])).toEqual([
      [1, 1, 'list_pods'],
      [2, 2, 'get_pod_logs'],
      [3, 2, 'get_deployment'],
    ]);
  });

  it('flattens args into ordered key/value pairs rendered as strings', () => {
    const rows = buildTraceRows(STEPS);
    expect(rows[1]!.args).toEqual([
      ['pod', 'order-service-1'],
      ['tail', '50'],
    ]);
  });

  it('pairs each call with its result by name within the same step', () => {
    const rows = buildTraceRows(STEPS);
    expect(rows[2]!.result).toEqual({ image: 'busybox:1.36', replicas: 2 });
    expect(rows[2]!.summary).toBe('image: busybox:1.36 · replicas: 2');
  });

  it('decodes a JSON-encoded string result (MCP text content) before summarising', () => {
    // mcp-inspect returns tool output as text content that is itself JSON.
    const json = JSON.stringify(
      [
        { name: 'a', status: 'Running' },
        { name: 'b', status: 'Running' },
      ],
      null,
      2,
    );
    const rows = buildTraceRows([
      {
        toolCalls: [{ name: 'list_pods', args: {} }],
        toolResults: [{ name: 'list_pods', result: json }],
      },
    ]);
    expect(rows[0]!.result).toEqual([
      { name: 'a', status: 'Running' },
      { name: 'b', status: 'Running' },
    ]);
    expect(rows[0]!.summary).toBe('2 items');
  });

  it('leaves a non-JSON string result as text', () => {
    const rows = buildTraceRows([
      {
        toolCalls: [{ name: 'get_pod_logs', args: {} }],
        toolResults: [{ name: 'get_pod_logs', result: '[warn] x\nline 2' }],
      },
    ]);
    expect(rows[0]!.result).toBe('[warn] x\nline 2');
    expect(rows[0]!.summary).toBe('[warn] x');
  });

  it('marks a call whose result never arrived', () => {
    const rows = buildTraceRows([
      { toolCalls: [{ name: 'list_pods', args: {} }], toolResults: [], finishReason: 'error' },
    ]);
    expect(rows[0]!.result).toBeUndefined();
    expect(rows[0]!.summary).toBe('no result');
  });

  it('carries the finish reason of the LAST step only on its rows', () => {
    const rows = buildTraceRows(STEPS);
    expect(rows[0]!.finishReason).toBe('tool-calls');
    expect(rows[2]!.finishReason).toBe('stop');
  });

  it('flags a tool result that reports an error', () => {
    const rows = buildTraceRows([
      {
        toolCalls: [{ name: 'set_deployment_image', args: {} }],
        toolResults: [{ name: 'set_deployment_image', result: { error: 'forbidden', tool: 'x' } }],
      },
    ]);
    expect(rows[0]!.failed).toBe(true);
    expect(rows[0]!.summary).toBe('error: forbidden · tool: x');
  });
});

describe('summarizeResult', () => {
  it('uses the first line of a string, truncated', () => {
    expect(summarizeResult('a'.repeat(200) + '\nsecond')).toBe('a'.repeat(117) + '…');
  });
  it('lists primitive top-level keys of an object and counts the rest', () => {
    expect(summarizeResult({ ok: true, items: [1, 2], meta: { x: 1 } })).toBe(
      'ok: true · items: [2 items] · meta: {…}',
    );
  });
  it('reports array length', () => {
    expect(summarizeResult([1, 2, 3])).toBe('3 items');
  });
  it('handles nullish', () => {
    expect(summarizeResult(undefined)).toBe('no result');
    expect(summarizeResult(null)).toBe('null');
  });
});
