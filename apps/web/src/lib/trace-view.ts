/**
 * View model for the read-path Trace tab.
 *
 * The copilot reports its LLM tool-calling loop as `steps`, in OUR wire shape
 * (`{name, args}` / `{name, result}` — held stable across AI SDK upgrades, see
 * CLAUDE.md fact #30). This flattens them into one row per tool call so the
 * tab can tell the story "the agent called list_pods with namespace=prod and
 * got 4 pods back" instead of dumping JSON. Pure: no React, no formatting of
 * dates, so every rule here is unit-testable.
 */

export interface TraceStep {
  toolCalls?: Array<{ name: string; args: unknown }>;
  toolResults?: Array<{ name: string; result: unknown }>;
  finishReason?: string;
}

export interface TraceRow {
  /** 1-based position across all steps. */
  index: number;
  /** 1-based step the call belongs to (one LLM turn can issue several calls). */
  step: number;
  tool: string;
  /** Args flattened to ordered key/value pairs, values rendered as strings. */
  args: Array<[string, string]>;
  /** Raw result, undefined when no result was reported for this call. */
  result: unknown;
  /** One-line summary of the result for the row header. */
  summary: string;
  /** True when the result is an object carrying an `error` field. */
  failed: boolean;
  /** The step's finish reason, repeated on each row of that step. */
  finishReason?: string;
}

const MAX_SUMMARY = 118;

function truncate(s: string, max = MAX_SUMMARY): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtValue(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (Array.isArray(v)) return `[${v.length} item${v.length === 1 ? '' : 's'}]`;
  if (typeof v === 'object') return '{…}';
  return String(v);
}

/** One-line rendering of a tool result. */
export function summarizeResult(result: unknown): string {
  if (result === undefined) return 'no result';
  if (result === null) return 'null';
  if (typeof result === 'string') return truncate(result.split('\n')[0] ?? '');
  if (Array.isArray(result)) return `${result.length} item${result.length === 1 ? '' : 's'}`;
  if (typeof result === 'object') {
    const parts = Object.entries(result as Record<string, unknown>).map(
      ([k, v]) => `${k}: ${fmtValue(v)}`,
    );
    return truncate(parts.join(' · '));
  }
  return String(result);
}

function flattenArgs(args: unknown): Array<[string, string]> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return args === undefined ? [] : [['input', fmtValue(args)]];
  }
  return Object.entries(args as Record<string, unknown>).map(([k, v]) => [
    k,
    typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
  ]);
}

/**
 * MCP servers return tool output as text content, and ours serialise JSON into
 * it. Decode that so the summary and the "Full result" view see the structure
 * rather than a string with escaped quotes. Only objects/arrays are decoded;
 * a plain string that happens to be valid JSON (e.g. a number) stays text.
 */
function decodeResult(result: unknown): unknown {
  if (typeof result !== 'string') return result;
  const t = result.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return result;
  try {
    return JSON.parse(t);
  } catch {
    return result;
  }
}

function isFailure(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    !Array.isArray(result) &&
    'error' in (result as Record<string, unknown>)
  );
}

export function buildTraceRows(steps: TraceStep[]): TraceRow[] {
  const rows: TraceRow[] = [];
  steps.forEach((step, si) => {
    // Results are matched by name within the step, consuming each at most once
    // so two calls to the same tool in one step pair up in order.
    const pending = [...(step.toolResults ?? [])];
    for (const call of step.toolCalls ?? []) {
      const ri = pending.findIndex((r) => r.name === call.name);
      const hit = ri >= 0 ? pending.splice(ri, 1)[0] : undefined;
      const result = decodeResult(hit?.result);
      rows.push({
        index: rows.length + 1,
        step: si + 1,
        tool: call.name,
        args: flattenArgs(call.args),
        result,
        summary: summarizeResult(result),
        failed: isFailure(result),
        finishReason: step.finishReason,
      });
    }
  });
  return rows;
}
