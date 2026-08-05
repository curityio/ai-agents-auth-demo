/*
 * OBO-chain INFO logging. A small, dependency-free pretty-printer used across
 * every service in the on-behalf-of chain (web → agents → MCP → APIs) to make
 * the important actions — inbound request receipt, token exchange, and the call
 * to the next hop — visible and readable in `kubectl logs`.
 *
 * This is a DEMO aid: it logs payload/identity detail (sub, scope, act chain,
 * audiences) without redaction on purpose. Set OBO_LOG=off to silence it.
 */

const DISABLED = process.env.OBO_LOG === 'off';

export type OboKind = 'RECEIVE' | 'EXCHANGE' | 'CALL';

export interface OboLogEvent {
  /** The service emitting the log, e.g. 'agent-copilot'. */
  service: string;
  /** RECEIVE (inbound), EXCHANGE (token exchange), or CALL (next hop). */
  kind: OboKind;
  /** Short one-line summary, e.g. '→ A2A agent-specialist (restart_deployment)'. */
  headline: string;
  /** Key/value detail lines, pretty-printed and aligned. */
  fields?: Record<string, unknown>;
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

/** Render an OBO event as an aligned, box-drawn INFO block on stdout. */
export function oboLog(event: OboLogEvent): void {
  if (DISABLED) return;
  console.log(formatOboLog(event));
}

/** Pure formatter (exported for testing). */
export function formatOboLog(event: OboLogEvent): string {
  const { service, kind, headline, fields } = event;
  const lines: string[] = [`┌─ INFO [${service}] ${kind} ${headline}`];
  if (fields) {
    const entries = Object.entries(fields).filter(
      ([, v]) => v !== undefined && v !== null && v !== '',
    );
    const width = entries.reduce((w, [k]) => Math.max(w, k.length), 0);
    for (const [k, v] of entries) {
      lines.push(`│  ${k.padEnd(width)} : ${stringifyVal(v)}`);
    }
  }
  lines.push('└─');
  return lines.join('\n');
}

function stringifyVal(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
