'use client';

import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Clock,
  CornerDownRight,
  KeyRound,
  ShieldAlert,
  Sparkles,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { JsonBlock } from '@/components/json-block';
import { CopyButton } from '@/components/copy-button';
import { cn } from '@/lib/utils';
import {
  buildLedger,
  chainBaseline,
  hopDeltas,
  type ChainBaseline,
  type LedgerRow,
} from '@/lib/token-view';

export interface LedgerHop {
  hop: string;
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  /** Raw JWT — only present on the debug /inspect surface. */
  token?: string;
  /**
   * Presenter-facing caveat set by the agent that emitted the hop. Today only
   * the aud=llm-gateway rows carry one: the token is a real narrowing of the
   * user's delegation, but the model provider is outside the trust domain, so
   * the row is a LEAF of the chain, not a step toward the cluster.
   */
  note?: string;
}

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/**
 * A ticking clock so "time left" counts down on screen. The tokens themselves
 * do not change until the next request, so this re-renders locally instead of
 * polling the chain route — polling would spray extra spans and OBO-log lines
 * into the very telemetry the demo is showing.
 */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function TtlBadge({ iat, exp, now }: { iat?: number; exp?: number; now: number }) {
  if (exp === undefined) return null;
  const remaining = Math.round(exp - now / 1000);
  const total = iat !== undefined ? Math.round(exp - iat) : undefined;
  const expired = remaining <= 0;
  return (
    <Badge variant={expired ? 'destructive' : 'muted'} className="gap-1 font-mono">
      <Clock className="h-3 w-3" />
      {total !== undefined && `ttl ${fmtSeconds(total)} · `}
      {expired ? 'expired' : `${fmtSeconds(remaining)} left`}
    </Badge>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="w-16 shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex items-start gap-3">{children}</div>;
}

/**
 * One token, rendered as the story the presenter tells: who it is FOR (aud),
 * what it may DO (scope — with the scopes the exchange dropped kept on
 * screen, struck through), who has ACTED so far (act, newest actor
 * highlighted, with a check when it is the actor the parent's may_act named),
 * and who may act NEXT (may_act). sub/roles/acr live in the strip above the
 * hops and are repeated here only where a hop differs from the login token.
 *
 * A leaf (the LLM call) hangs off the spine as an indented, dashed side-row
 * with the same rows as any hop, and takes no spine number — so the spine
 * reads 0 → 1 → 2 with each hop minted from the one above.
 */
function LedgerRowView({
  row,
  hop,
  showRaw,
  now,
  base,
  numberOf,
}: {
  row: LedgerRow;
  hop: LedgerHop;
  showRaw: boolean;
  now: number;
  base: ChainBaseline;
  /** Spine number to print for a row index (a parent is always on the spine). */
  numberOf: (index: number) => number | string;
}) {
  const { summary: s, diff, leaf } = row;
  const isRoot = row.parentIndex === undefined;
  const parentNo = row.parentIndex === undefined ? '' : numberOf(row.parentIndex);
  // sub/roles/acr are printed once above the hops; repeat only what changed.
  const changed = hopDeltas(s, base);

  const header = (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <span className="font-mono text-sm font-semibold">{row.hop}</span>
      <div className="flex flex-wrap items-center gap-1.5">
        {leaf && (
          <Badge variant="outline" className="gap-1 font-mono" title={hop.note}>
            <Sparkles className="h-3 w-3" />
            leaf
          </Badge>
        )}
        {s.acr && changed.acr && (
          <Badge
            variant={s.acr === 'mfa' ? 'success' : 'secondary'}
            className="font-mono"
            title="Differs from the login token"
          >
            acr {s.acr}
          </Badge>
        )}
        <TtlBadge iat={s.iat} exp={s.exp} now={now} />
      </div>
    </div>
  );

  const claims = (
    <>
      {changed.sub && (
        <Row>
          <Label>sub</Label>
          <span className="font-mono">{s.sub ?? '—'}</span>
        </Row>
      )}

      <Row>
        <Label>aud</Label>
        <span className="flex flex-wrap items-center gap-1.5">
          {s.aud.map((a) => (
            <Badge
              key={a}
              variant={diff.audChanged ? 'accent' : 'outline'}
              className="font-mono"
              title={diff.audChanged ? 'Audience narrowed by this exchange' : undefined}
            >
              {a}
            </Badge>
          ))}
          {s.aud.length === 0 && <span className="text-muted-foreground">—</span>}
        </span>
      </Row>

      <Row>
        <Label>scope</Label>
        <span className="flex flex-wrap items-center gap-1.5">
          {s.scopes.map((sc) => (
            <Badge key={sc} variant="success" className="font-mono">
              {sc}
            </Badge>
          ))}
          {diff.scopesDropped.map((sc) => (
            <Badge
              key={`dropped-${sc}`}
              variant="muted"
              className="font-mono line-through opacity-60"
              title="Held by the parent token, dropped by this exchange"
            >
              {sc}
            </Badge>
          ))}
          {s.scopes.length === 0 && diff.scopesDropped.length === 0 && (
            <span className="text-muted-foreground">—</span>
          )}
        </span>
      </Row>

      {changed.roles && (
        <Row>
          <Label>roles</Label>
          <span className="flex flex-wrap items-center gap-1.5">
            {s.roles.map((r) => (
              <Badge key={r} variant="secondary" className="font-mono">
                {r}
              </Badge>
            ))}
            {s.roles.length === 0 && <span className="text-muted-foreground">—</span>}
          </span>
        </Row>
      )}
    </>
  );

  const delegation = (
    <>
      <Row>
        <Label>act</Label>
        <span className="flex flex-wrap items-center gap-1">
          {s.act.length === 0 && (
            <span className="text-muted-foreground">
              — {isRoot ? 'nobody has acted yet: this is the user’s own token' : ''}
            </span>
          )}
          {s.act.map((a, i) => {
            const newest = i === s.act.length - 1;
            const appended = newest && diff.actAppended;
            const id = s.actIds[i] ?? a;
            const badge = (
              <Badge
                variant={appended ? 'accent' : 'outline'}
                className={cn('gap-1 font-mono', appended && 'ring-1 ring-accent-violet/40')}
                title={
                  appended
                    ? diff.mayActHonoured
                      ? `${id} — appended by this exchange; hop ${parentNo}’s may_act named it`
                      : `${id} — appended by this exchange`
                    : id
                }
              >
                {a}
                {appended && diff.mayActHonoured && (
                  <Check className="h-3 w-3" aria-label="permitted by the parent’s may_act" />
                )}
              </Badge>
            );
            return (
              <span key={`${a}-${i}`} className="flex items-center gap-1">
                {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                {appended ? (
                  // The SVID this workload presented as actor_token — its card is above.
                  <a
                    href="#identities"
                    className="rounded-full"
                    aria-label={`${a}: see its workload identity`}
                  >
                    {badge}
                  </a>
                ) : (
                  badge
                )}
              </span>
            );
          })}
        </span>
      </Row>

      <Row>
        <Label>may_act</Label>
        <span className="flex flex-wrap items-center gap-1.5">
          {s.mayAct ? (
            <>
              <ArrowRight className="h-3 w-3 text-muted-foreground" />
              <Badge variant="outline" className="font-mono" title={s.mayActId ?? s.mayAct}>
                {s.mayAct}
              </Badge>
              <span className="text-xs text-muted-foreground">may present this token next</span>
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              none — terminal token, nothing exchanges it onward
            </span>
          )}
        </span>
      </Row>

      {diff.mayActHonoured === false && (
        <div className="mt-1 flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive">
          <X className="h-3.5 w-3.5" />
          <span>
            Minted from hop {parentNo}’s token, but presented by{' '}
            <span className="font-mono">{diff.actAppended}</span>, not the actor hop {parentNo}
            ’s <span className="font-mono">may_act</span> permitted
          </span>
        </div>
      )}
    </>
  );

  const raw = (
    <details className="mt-3 rounded-lg border bg-muted/10">
      <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
        Raw JWT
      </summary>
      <div className="space-y-3 px-3 pb-3">
        <JsonBlock data={{ header: hop.header, payload: hop.payload }} />
        {showRaw &&
          (hop.token ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
                  <KeyRound className="h-3 w-3" /> Encoded token
                </span>
                <CopyButton value={hop.token} label="Copy token" />
              </div>
              <pre className="max-h-32 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-foreground/70">
                {hop.token}
              </pre>
            </div>
          ) : (
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <ShieldAlert className="h-3 w-3" /> Raw token unavailable for this hop.
            </p>
          ))}
      </div>
    </details>
  );

  if (leaf) {
    return (
      <li data-leaf className="relative pl-9 sm:pl-16">
        <span
          className="absolute left-2.5 top-1 text-muted-foreground sm:left-9"
          title="A leaf: this token is not exchanged onward"
        >
          <CornerDownRight className="h-4 w-4" />
        </span>
        <div className="rounded-xl border border-dashed border-border bg-secondary/30 p-3.5">
          {header}
          {hop.note && <p className="mb-3 text-xs text-muted-foreground">{hop.note}</p>}
          <div className="space-y-2 text-sm">
            {claims}
            {delegation}
          </div>
          {raw}
        </div>
      </li>
    );
  }

  return (
    <li className="relative pl-9">
      <span
        data-spine-number={row.number}
        className="mesh-hero absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm ring-2 ring-background"
      >
        {row.number}
      </span>
      <div className="rounded-xl border border-border bg-secondary/60 p-3.5">
        {header}
        <div className="space-y-2 text-sm">
          {claims}
          {delegation}
        </div>
        {raw}
      </div>
    </li>
  );
}

const SAMPLE =
  'inline-flex items-center rounded-full border px-1.5 font-mono text-[10px] leading-4';

/** What the diff marks on a hop mean — the legend the tooltips otherwise carry. */
function Legend() {
  return (
    <div
      data-chain-legend
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5">
        <span className={cn(SAMPLE, 'border-transparent bg-primary/15 text-accent-violet')}>
          aud
        </span>
        narrowed by this exchange
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            SAMPLE,
            'border-transparent bg-muted text-muted-foreground line-through opacity-60',
          )}
        >
          scope
        </span>
        dropped by this exchange
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span
          className={cn(
            SAMPLE,
            'border-transparent bg-primary/15 text-accent-violet ring-1 ring-accent-violet/40',
          )}
        >
          actor
        </span>
        appended by this exchange
      </span>
      <span className="inline-flex items-center gap-1.5">
        <Check className="h-3 w-3" />
        the parent’s <span className="font-mono">may_act</span> named it
      </span>
    </div>
  );
}

/**
 * The on-behalf-of chain as a ledger: one row per token, each diffed against
 * the token it was exchanged FROM (see `buildLedger` for how the parent is
 * found — by `act`-chain prefix, not list position).
 */
export function DelegationLedger({
  chain,
  showRaw = false,
  now: nowProp,
}: {
  chain: LedgerHop[];
  showRaw?: boolean;
  /** Clock override (ms since epoch) — tests inject it; the UI ticks its own. */
  now?: number;
}) {
  const tick = useNow(1000);
  const now = nowProp ?? tick;
  const rows = buildLedger(chain);
  const base = chainBaseline(rows);
  const numberOf = (i: number) => rows[i]?.number ?? i;
  const mono = 'font-mono text-foreground/80';
  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <div data-chain-facts className="text-xs text-muted-foreground">
          Every token below carries sub <span className={mono}>{base.sub ?? '—'}</span> · roles{' '}
          {base.roles.length > 0 ? (
            base.roles.map((r, i) => (
              <span key={r}>
                {i > 0 && ', '}
                <span className={mono}>{r}</span>
              </span>
            ))
          ) : (
            <span className={mono}>—</span>
          )}{' '}
          · acr{' '}
          <span className={cn(mono, base.acr === 'mfa' && 'text-success')}>{base.acr ?? '—'}</span>
          <span className="text-muted-foreground/70">
            {' '}
            — a hop repeats these only where it differs.
          </span>
        </div>
      )}
      {rows.length > 0 && <Legend />}
      <ol className="relative space-y-4 before:absolute before:left-[11px] before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-border">
        {rows.map((row) => (
          <LedgerRowView
            key={`${row.index}-${row.hop}`}
            row={row}
            hop={chain[row.index]!}
            showRaw={showRaw}
            now={now}
            base={base}
            numberOf={numberOf}
          />
        ))}
      </ol>
    </div>
  );
}
