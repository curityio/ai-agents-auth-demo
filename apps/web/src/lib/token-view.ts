/**
 * View model for the delegation ledger.
 *
 * Pure functions over decoded JWT payloads (as returned by `/api/obo-chain`):
 * no React, no fetch, no Date — so every rule that decides what the audience
 * sees ("this scope was dropped", "this actor was the one may_act permitted")
 * is unit-testable in isolation.
 *
 * Claim shapes are normalised defensively because Curity emits them in more than
 * one form: `aud` is a string or array, `scope` is space-delimited, `act` is a
 * nested object (outermost = most recent actor), and `may_act` can arrive as an
 * object or a JSON string depending on how the token was hydrated.
 */

export type JwtPayload = Record<string, unknown> | null | undefined;

export interface HopSummary {
  sub?: string;
  aud: string[];
  scopes: string[];
  acr?: string;
  roles: string[];
  /** Actor chain oldest → newest, as short workload names. */
  act: string[];
  /** The same chain as full SPIFFE IDs (same order as `act`), for tooltips. */
  actIds: string[];
  /** Short name of the workload permitted to present this token next. */
  mayAct?: string;
  /** Full SPIFFE ID behind `mayAct`, for the tooltip. */
  mayActId?: string;
  iat?: number;
  exp?: number;
}

export interface HopDiff {
  /** Scopes carried over from the parent token. Empty on the root hop. */
  scopesKept: string[];
  /** Scopes the parent had that this token no longer carries. */
  scopesDropped: string[];
  /** True when `aud` differs from the parent's. False on the root hop. */
  audChanged: boolean;
  /** The one actor this exchange appended to the parent's act chain. */
  actAppended?: string;
  /**
   * Whether `actAppended` is the workload the parent's `may_act` named.
   * `undefined` when there is no parent, or the parent carries no `may_act`.
   */
  mayActHonoured?: boolean;
}

export interface LedgerRow {
  index: number;
  hop: string;
  summary: HopSummary;
  /** Index of the row this token was exchanged from; undefined for the root. */
  parentIndex?: number;
  diff: HopDiff;
}

const SPIFFE_SA = /^spiffe:\/\/[^/]+\/ns\/[^/]+\/sa\/([^/]+)$/;

export function shortSpiffe(id: string): string {
  const m = SPIFFE_SA.exec(id);
  return m ? m[1]! : id;
}

export function listClaim(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean);
  return [String(v)];
}

/** Full actor IDs oldest → newest (the nested `act` claim is newest-outermost). */
export function actChainIds(act: unknown): string[] {
  const newestFirst: string[] = [];
  let cur: unknown = act;
  let guard = 0;
  while (cur && typeof cur === 'object' && guard++ < 16) {
    const node = cur as { sub?: unknown; act?: unknown };
    if (node.sub != null) newestFirst.push(String(node.sub));
    cur = node.act;
  }
  return newestFirst.reverse();
}

export function flattenActChain(act: unknown): string[] {
  return actChainIds(act).map(shortSpiffe);
}

/** Full ID named by `may_act`, whatever shape Curity hydrated the claim in. */
export function mayActId(v: unknown): string | undefined {
  if (v == null) return undefined;
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return v;
    }
  }
  if (obj && typeof obj === 'object' && 'sub' in obj) {
    const sub = (obj as { sub?: unknown }).sub;
    return sub == null ? undefined : String(sub);
  }
  return undefined;
}

export function mayActSub(v: unknown): string | undefined {
  const id = mayActId(v);
  return id === undefined ? undefined : shortSpiffe(id);
}

export function summarizeHop(payload: JwtPayload): HopSummary {
  const p = payload ?? {};
  return {
    sub: p.sub != null ? String(p.sub) : undefined,
    aud: listClaim(p.aud),
    scopes: listClaim(p.scope),
    acr: p.acr != null ? String(p.acr) : undefined,
    roles: listClaim(p.roles),
    act: flattenActChain(p.act),
    actIds: actChainIds(p.act),
    mayAct: mayActSub(p.may_act),
    mayActId: mayActId(p.may_act),
    iat: typeof p.iat === 'number' ? p.iat : undefined,
    exp: typeof p.exp === 'number' ? p.exp : undefined,
  };
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((v, i) => of[i] === v);
}

/**
 * The token a hop was exchanged FROM is the nearest earlier hop whose act
 * chain is this hop's chain minus its newest actor. Position in the list is
 * not enough: the chain is flattened depth-first, so a second branch (the
 * specialist's ops:write token) follows the whole read branch but descends
 * from the specialist's delegation token, not from obs-api's terminal token.
 */
function findParentIndex(summaries: HopSummary[], i: number): number | undefined {
  const cur = summaries[i]!;
  if (cur.act.length === 0) return undefined;
  const want = cur.act.slice(0, -1);
  for (let j = i - 1; j >= 0; j--) {
    const cand = summaries[j]!;
    if (cand.act.length === want.length && isPrefix(want, cand.act)) return j;
  }
  return undefined;
}

function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => b[i] === v);
}

function diffAgainst(parent: HopSummary | undefined, cur: HopSummary): HopDiff {
  if (!parent) {
    return { scopesKept: [], scopesDropped: [], audChanged: false };
  }
  const actAppended = cur.act[cur.act.length - 1];
  return {
    scopesKept: cur.scopes.filter((s) => parent.scopes.includes(s)),
    scopesDropped: parent.scopes.filter((s) => !cur.scopes.includes(s)),
    audChanged: !sameList(parent.aud, cur.aud),
    actAppended,
    mayActHonoured:
      parent.mayAct === undefined || actAppended === undefined
        ? undefined
        : parent.mayAct === actAppended,
  };
}

export function buildLedger(chain: Array<{ hop: string; payload: JwtPayload }>): LedgerRow[] {
  const summaries = chain.map((h) => summarizeHop(h.payload));
  return chain.map((h, i) => {
    const parentIndex = findParentIndex(summaries, i);
    const parent = parentIndex === undefined ? undefined : summaries[parentIndex];
    return {
      index: i,
      hop: h.hop,
      summary: summaries[i]!,
      parentIndex,
      diff: diffAgainst(parent, summaries[i]!),
    };
  });
}

/**
 * Which flow a chain belongs to. The copilot's /last-token renders exactly one
 * branch (observe XOR privileged), and only the privileged branch delegates
 * to the specialist — so a hop naming agent-specialist decides it. Undefined
 * when nothing beyond the inbound token has run yet.
 */
export function flowOfChain(
  chain: Array<{ hop: string; payload: Record<string, unknown> | null }>,
): 'read' | 'privileged' | undefined {
  if (chain.length < 2) return undefined;
  const privileged = chain.some(
    (h) =>
      /agent-specialist|mcp-ops|ops-api/.test(h.hop) ||
      listClaim(h.payload?.aud).some((a) => /agent-specialist|mcp-ops|ops-api/.test(a)),
  );
  return privileged ? 'privileged' : 'read';
}
