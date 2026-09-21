'use client';

import { Fragment, useEffect, useState } from 'react';
import { Clock, RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { FlowBadge } from '@/components/flow-badge';
import { JsonBlock } from '@/components/json-block';
import { cn } from '@/lib/utils';
import type { Flow } from '@/lib/chat-rules';
import { lifetime, sharedFacts, svidNamespace, type SvidView } from '@/lib/svid-view';

/** A SPIFFE ID with soft break opportunities after each `/`, so a narrow card
 *  wraps at path boundaries instead of mid-word. */
function SpiffeId({ id }: { id: string }) {
  // Split after each `/` that is not followed by another, so `spiffe://` stays
  // whole. Each segment is unbreakable, so the browser cannot also break at a
  // hyphen inside a workload name ("agent-" / "copilot").
  const parts = id.split(/(?<=\/)(?!\/)/);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && <wbr />}
          <span className="whitespace-nowrap">{part}</span>
        </Fragment>
      ))}
    </>
  );
}

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

/** Same 1s clock as the ledger: SVIDs rotate, so the lifetime should be seen moving. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function LifetimeBadge({ s, now }: { s: SvidView; now: number }) {
  const l = lifetime(s, now);
  if (!l) return null;
  const variant = l.level === 'expired' ? 'destructive' : l.level === 'low' ? 'warning' : 'muted';
  return (
    <Badge variant={variant} className="gap-1 whitespace-nowrap font-mono">
      <Clock className="h-3 w-3" />
      {l.total !== undefined && `ttl ${fmtSeconds(l.total)} · `}
      {l.level === 'expired' ? 'expired' : `${fmtSeconds(l.remaining)} left`}
    </Badge>
  );
}

function LifetimeBar({ s, now }: { s: SvidView; now: number }) {
  const l = lifetime(s, now);
  if (!l || l.total === undefined) return null;
  return (
    <div
      className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label="SVID lifetime remaining"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(l.fraction * 100)}
    >
      <div
        className={cn(
          'h-full rounded-full transition-[width] duration-1000 ease-linear',
          l.level === 'expired' ? 'bg-destructive' : l.level === 'low' ? 'bg-warn' : 'bg-primary',
        )}
        style={{ width: `${l.fraction * 100}%` }}
      />
    </div>
  );
}

function Card({
  s,
  index,
  showOwnFacts,
  rotated,
  now,
}: {
  s: SvidView;
  index: number;
  showOwnFacts: boolean;
  rotated: boolean;
  now: number;
}) {
  const ns = svidNamespace(s.sub);
  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-secondary/60 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2">
          <span
            data-chain-index={index}
            className="mesh-hero flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm ring-2 ring-background"
          >
            {index}
          </span>
          <span className="font-mono text-sm font-semibold">{s.workload}</span>
          {ns && (
            <Badge
              variant="outline"
              className="gap-1 border-border/70 font-mono text-[11px] font-normal text-muted-foreground"
            >
              <span className="font-sans">ns</span>
              <span className="text-muted-foreground">{ns}</span>
            </Badge>
          )}
          {rotated && (
            <Badge variant="success" className="gap-1" title="Issued after the previous refresh">
              <RefreshCw className="h-3 w-3" />
              rotated
            </Badge>
          )}
        </span>
      </div>

      {s.error ? (
        <p className="text-sm text-destructive">{s.error}</p>
      ) : (
        <div className="flex flex-1 flex-col gap-2.5 text-sm">
          {/* Lifetime lives with its bar, so the header row only carries identity
              chips and never pushes the countdown onto a second line. */}
          <div className="flex items-center gap-3">
            <LifetimeBar s={s} now={now} />
            <LifetimeBadge s={s} now={now} />
          </div>
          <div className="flex items-start gap-3">
            <span className="w-12 shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              sub
            </span>
            <span className="break-words font-mono text-[13px]">
              {s.sub && <SpiffeId id={s.sub} />}
            </span>
          </div>
          {showOwnFacts && (
            <>
              <div className="flex items-start gap-3">
                <span className="w-12 shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  iss
                </span>
                <span className="break-words font-mono text-[13px]">{s.iss}</span>
              </div>
              <div className="flex items-start gap-3">
                <span className="w-12 shrink-0 pt-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  aud
                </span>
                <span className="break-words font-mono text-[13px]">
                  {(Array.isArray(s.aud) ? s.aud : [s.aud]).filter(Boolean).join(' ')}
                </span>
              </div>
            </>
          )}
          <details className="mt-auto rounded-lg border bg-muted/10">
            <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
              Raw claims
            </summary>
            <div className="px-3 pb-3">
              <JsonBlock data={{ sub: s.sub, aud: s.aud, iss: s.iss, iat: s.iat, exp: s.exp }} />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

/**
 * The SVIDs of the workloads in the flow just run, in chain order — the same
 * order their SPIFFE IDs will appear in the ledger's `act` chain. Facts every
 * SVID shares (issuer, audience) are said once above the cards.
 */
export function WorkloadIdentities({
  svids,
  flow,
  rotated,
  now: nowProp,
}: {
  svids: SvidView[];
  flow: Flow;
  rotated?: Set<string>;
  /** Clock override (ms since epoch) — tests inject it; the UI ticks its own. */
  now?: number;
}) {
  const tick = useNow(1000);
  const now = nowProp ?? tick;
  const shared = sharedFacts(svids);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <FlowBadge flow={flow} />
        {shared && (
          <span>
            Every SVID here is issued by{' '}
            <span className="font-mono text-foreground/80">{shared.iss}</span> for audience{' '}
            <span className="font-mono text-foreground/80">{shared.aud.join(' ')}</span>
          </span>
        )}
      </div>

      <ol data-chain-cards className="grid gap-3 sm:grid-cols-2">
        {svids.map((s, i) => (
          <li key={s.workload}>
            <Card
              s={s}
              index={i + 1}
              showOwnFacts={!shared}
              rotated={rotated?.has(s.workload) ?? false}
              now={now}
            />
          </li>
        ))}
      </ol>
    </div>
  );
}
