/*
 * OBO-chain INFO logging. A small, dependency-free pretty-printer used across
 * every service in the on-behalf-of chain (web → agents → MCP → APIs) to make
 * the important actions — inbound request receipt, token exchange, and the call
 * to the next hop — visible and readable in `kubectl logs`.
 *
 * This is a DEMO aid: it logs payload/identity detail (sub, scope, act chain,
 * audiences) without redaction on purpose. Set OBO_LOG=off to silence it.
 */

import { isSpanContextValid, trace, type Span } from '@opentelemetry/api';

const DISABLED = process.env.OBO_LOG === 'off';

/**
 * RECEIVE (inbound), EXCHANGE (token exchange), CALL (next hop), DENY (an
 * authorization refusal), DISCOVER (an OAuth discovery run: 401 challenge →
 * RFC 9728 → RFC 8414). DENY exists because the success paths were logged and
 * the refusals were not — which is backwards for a demo about authorization:
 * a denied hop would simply stop appearing in the logs, indistinguishable from
 * a crash. DISCOVER is emitted once per cold discovery so the log shows where a
 * client learned its authorization server from; cache hits are silent.
 */
export type OboKind = 'RECEIVE' | 'EXCHANGE' | 'CALL' | 'DENY' | 'DISCOVER';

/** W3C trace-context ids used to join this line to the rest of the request. */
export interface OboTrace {
  traceId?: string;
  spanId?: string;
}

export interface OboLogEvent {
  /** The service emitting the log, e.g. 'agent-copilot'. */
  service: string;
  /** RECEIVE (inbound), EXCHANGE (token exchange), or CALL (next hop). */
  kind: OboKind;
  /** Short one-line summary, e.g. '→ A2A agent-specialist (restart_deployment)'. */
  headline: string;
  /** Key/value detail lines, pretty-printed and aligned. */
  fields?: Record<string, unknown>;
  /**
   * ISO-8601 emission time, rendered on the header line. `oboLog` fills this in;
   * it is a parameter (not a `Date.now()` call inside the formatter) so that
   * `formatOboLog` stays pure and its tests stay deterministic.
   */
  at?: string;
  /**
   * Trace correlation ids. `oboLog` fills these in from the active span; same
   * purity argument as `at`.
   */
  trace?: OboTrace;
}

/**
 * Pull the W3C ids off a span for logging. An all-zero (invalid) span context —
 * what you get when nothing is instrumented or the context was lost — yields
 * nothing rather than a run of zeros that looks like a real id.
 *
 * Takes the span explicitly rather than defaulting to `trace.getActiveSpan()`
 * so the "no active span" branch is genuinely reachable from a test.
 */
export function traceFields(span: Span | undefined): OboTrace {
  if (!span) return {};
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return {};
  return { traceId: ctx.traceId, spanId: ctx.spanId };
}

/**
 * The id of the trace the caller is currently inside, for a response to carry
 * back to a UI that wants to deep-link it (Grafana/Tempo). Undefined when no
 * valid span is active, so an uninstrumented service reports nothing rather
 * than 32 zeros that look real.
 */
export function activeTraceId(): string | undefined {
  return traceFields(trace.getActiveSpan()).traceId;
}

export interface JwtSummary {
  sub?: string;
  aud?: string;
  scope?: string;
  acr?: string;
  /** act chain flattened oldest→newest, e.g. 'agent-copilot ▸ agent-specialist'. */
  act?: string;
  /**
   * RFC 8693 §4.4 `may_act.sub`, shortened to its SA — who this token PERMITS to
   * act next, as opposed to `act` which records who already did. Absent on
   * terminal tokens (nothing exchanges them onward).
   */
  mayAct?: string;
  roles?: string;
}

/**
 * Decode (WITHOUT verifying) a compact JWT's payload and pull the identity
 * claims worth logging. Verification happens elsewhere; this is for display.
 * Returns an empty object on any parse failure.
 */
export function summarizeJwt(jwt: string | undefined | null): JwtSummary {
  if (!jwt) return {};
  try {
    const parts = jwt.split('.');
    if (parts.length < 2 || !parts[1]) return {};
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Record<
      string,
      unknown
    >;
    return {
      sub: payload.sub != null ? String(payload.sub) : undefined,
      aud: formatList(payload.aud),
      scope: payload.scope != null ? String(payload.scope) : undefined,
      acr: payload.acr != null ? String(payload.acr) : undefined,
      act: flattenAct(payload.act),
      mayAct: mayActSub(payload.may_act),
      roles: formatList(payload.roles),
    };
  } catch {
    return {};
  }
}

function formatList(v: unknown): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v.map(String).join(', ') : String(v);
}

/**
 * Flatten a nested RFC 8693 `act` claim — `{ sub, act: { sub, act } }` — into a
 * readable chain. The claim is outermost-first (outer = most recent actor); we
 * render oldest→newest joined with ' ▸ ', and shorten SPIFFE IDs to their SA.
 */
export function flattenAct(act: unknown): string | undefined {
  const chain: string[] = [];
  let cur: unknown = act;
  let guard = 0;
  while (cur && typeof cur === 'object' && guard++ < 16) {
    const node = cur as { sub?: unknown; act?: unknown };
    if (node.sub != null) chain.push(shortSpiffe(String(node.sub)));
    cur = node.act;
  }
  if (chain.length === 0) return undefined;
  return chain.reverse().join(' ▸ ');
}

/**
 * Pull `sub` out of an RFC 8693 §4.4 `may_act` claim and shorten it to its SA.
 * Unlike `act`, `may_act` is a flat single-level object — it grants the next hop,
 * it doesn't accumulate a history.
 */
export function mayActSub(mayAct: unknown): string | undefined {
  if (!mayAct || typeof mayAct !== 'object') return undefined;
  const sub = (mayAct as { sub?: unknown }).sub;
  return sub != null ? shortSpiffe(String(sub)) : undefined;
}

/** spiffe://demo.curity.local/ns/agents/sa/agent-copilot → agent-copilot */
function shortSpiffe(s: string): string {
  const m = /\/sa\/([^/]+)$/.exec(s);
  return m ? m[1]! : s;
}

/**
 * Render an OBO event as an aligned, box-drawn INFO block on stdout, stamped
 * with the current time and the active trace/span. An explicit `at`/`trace` on
 * the event wins, which is what lets callers log on behalf of another context.
 */
export function oboLog(event: OboLogEvent): void {
  if (DISABLED) return;
  console.log(
    formatOboLog({
      at: new Date().toISOString(),
      trace: traceFields(trace.getActiveSpan()),
      ...event,
    }),
  );
}

/** Pure formatter (exported for testing). */
export function formatOboLog(event: OboLogEvent): string {
  const { service, kind, headline, fields, at, trace: tc } = event;
  const stamp = at ? `${at} ` : '';
  const lines: string[] = [`┌─ ${stamp}INFO [${service}] ${kind} ${headline}`];
  // `trace` goes first so the correlation id sits next to the headline, and is
  // spread-before-fields so an explicit caller field of the same name wins.
  const entries = Object.entries({ trace: formatTrace(tc), ...fields }).filter(
    ([, v]) => v !== undefined && v !== null && v !== '',
  );
  const width = entries.reduce((w, [k]) => Math.max(w, k.length), 0);
  for (const [k, v] of entries) {
    lines.push(`│  ${k.padEnd(width)} : ${stringifyVal(v)}`);
  }
  lines.push('└─');
  return lines.join('\n');
}

/** `<traceId> ▸ <spanId>`, or just the trace id, or nothing. */
function formatTrace(tc: OboTrace | undefined): string | undefined {
  if (!tc?.traceId) return undefined;
  return tc.spanId ? `${tc.traceId} ▸ ${tc.spanId}` : tc.traceId;
}

function stringifyVal(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
