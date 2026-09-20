'use client';

import { ArrowRight, Check, Clock, KeyRound, ShieldAlert, Sparkles, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { JsonBlock } from '@/components/json-block';
import { CopyButton } from '@/components/copy-button';
import { cn } from '@/lib/utils';
import { buildLedger, type LedgerRow } from '@/lib/token-view';

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

function TtlBadge({ iat, exp }: { iat?: number; exp?: number }) {
  if (exp === undefined) return null;
  const remaining = Math.round(exp - Date.now() / 1000);
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
 * One token, rendered as the story the presenter tells: who the subject is, who
 * it is FOR (aud), what it may DO (scope — with the scopes the exchange dropped
 * kept on screen, struck through), who has ACTED so far (act, newest actor
 * highlighted), and who may act NEXT (may_act). Between hops, a check confirms
 * the actor that presented the parent token was the one its may_act named.
 */
function LedgerRowView({ row, hop, showRaw }: { row: LedgerRow; hop: LedgerHop; showRaw: boolean }) {
  const { summary: s, diff } = row;
  const isRoot = row.parentIndex === undefined;

  return (
    <li className="relative pl-9">
      <span className="mesh-hero absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm ring-2 ring-background">
        {row.index}
      </span>
      <div className="rounded-xl border border-border bg-secondary/60 p-3.5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono text-sm font-semibold">{row.hop}</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {hop.note && (
              <Badge variant="outline" className="gap-1 font-mono" title={hop.note}>
                <Sparkles className="h-3 w-3" />
                leaf
              </Badge>
            )}
            {s.acr && (
              <Badge variant={s.acr === 'mfa' ? 'success' : 'secondary'} className="font-mono">
                acr {s.acr}
              </Badge>
            )}
            <TtlBadge iat={s.iat} exp={s.exp} />
          </div>
        </div>

        {hop.note && <p className="mb-3 text-xs text-muted-foreground">{hop.note}</p>}

        <div className="space-y-2 text-sm">
          <Row>
            <Label>sub</Label>
            <span className="font-mono">{s.sub ?? '—'}</span>
          </Row>

          <Row>
            <Label>aud</Label>
            <span className="flex flex-wrap items-center gap-1.5">
              {s.aud.map((a) => (
                <Badge
                  key={a}
                  variant={diff.audChanged ? 'default' : 'outline'}
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
                return (
                  <span key={`${a}-${i}`} className="flex items-center gap-1">
                    {i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground" />}
                    <Badge
                      variant={appended ? 'default' : 'outline'}
                      className={cn('font-mono', appended && 'ring-2 ring-primary/40')}
                      title={appended ? `${id} — appended by this exchange` : id}
                    >
                      {a}
                    </Badge>
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

          {diff.mayActHonoured !== undefined && (
            <div
              className={cn(
                'mt-1 flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs',
                diff.mayActHonoured
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-destructive/40 bg-destructive/10 text-destructive',
              )}
            >
              {diff.mayActHonoured ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
              {diff.mayActHonoured ? (
                <span>
                  Minted from hop {row.parentIndex}’s token, presented by{' '}
                  <span className="font-mono">{diff.actAppended}</span>, the actor hop {row.parentIndex}’s{' '}
                  <span className="font-mono">may_act</span> permitted
                </span>
              ) : (
                <span>
                  Minted from hop {row.parentIndex}’s token, but presented by{' '}
                  <span className="font-mono">{diff.actAppended}</span>, not the actor hop {row.parentIndex}’s{' '}
                  <span className="font-mono">may_act</span> permitted
                </span>
              )}
            </div>
          )}
        </div>

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
      </div>
    </li>
  );
}

/**
 * The on-behalf-of chain as a ledger: one row per token, each diffed against
 * the token it was exchanged FROM (see `buildLedger` for how the parent is
 * found — by `act`-chain prefix, not list position).
 */
export function DelegationLedger({ chain, showRaw = false }: { chain: LedgerHop[]; showRaw?: boolean }) {
  const rows = buildLedger(chain);
  return (
    <ol className="relative space-y-4 before:absolute before:left-[11px] before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-border">
      {rows.map((row) => (
        <LedgerRowView key={`${row.index}-${row.hop}`} row={row} hop={chain[row.index]!} showRaw={showRaw} />
      ))}
    </ol>
  );
}
