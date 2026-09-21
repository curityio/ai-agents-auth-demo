'use client';

import { Ban, Check, Eye, Lock, ShieldAlert, Wrench } from 'lucide-react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { orderTools, tierVerdict, type TierVerdict, type ToolTier } from '@/lib/tool-view';

export interface ToolInfo {
  name: string;
  description?: string;
  /** Roles the tool requires to be CALLED, as published by the MCP server in tools/list `_meta`. */
  requiredRoles?: string[];
  /** Whether the current user holds one of `requiredRoles`. Present iff `requiredRoles` is. */
  callable?: boolean;
}

export type TierStatus =
  | { status: 'ok'; tools: ToolInfo[] }
  | { status: 'step-up'; acrValues: string; scope: string }
  | { status: 'denied'; error: string; description: string }
  | { status: 'error'; error: string; description: string };

export type TierResult = { tier: ToolTier; route: string } & TierStatus;

export interface ToolTiersResponse {
  tiers: TierResult[];
}

const TIER_META: Record<
  ToolTier,
  {
    title: string;
    scope: string;
    blurb: string;
    gate: React.ReactNode;
    Icon: typeof Eye;
    iconClass: string;
  }
> = {
  observability: {
    title: 'Read tier',
    scope: 'obs:read',
    blurb: 'mcp-observability, reached by the copilot directly.',
    gate: (
      <>
        Listed when <span className="font-mono">obs:read</span> is on the copilot&rsquo;s token.
      </>
    ),
    Icon: Eye,
    iconClass: 'text-primary',
  },
  ops: {
    title: 'Write tier',
    scope: 'ops:write',
    blurb: 'mcp-ops, reached only by the specialist after MFA and a role check.',
    gate: (
      <>
        Listed only after an <span className="font-mono">ops:write</span> exchange, which Curity
        grants only with <span className="font-mono">acr=mfa</span> and role{' '}
        <span className="font-mono">sre</span> or <span className="font-mono">oncall</span>.
      </>
    ),
    Icon: Lock,
    iconClass: 'text-warn',
  },
};

const VERDICT_VARIANT: Record<TierVerdict['tone'], BadgeProps['variant']> = {
  ok: 'success',
  blocked: 'warning',
  denied: 'destructive',
  unknown: 'muted',
};

function ToolRow({ t }: { t: ToolInfo }) {
  const gated = !!t.requiredRoles;
  const refused = t.callable === false;
  const roles = t.requiredRoles?.join(' or ') ?? '';
  return (
    <li
      data-tool={t.name}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-3 py-2',
        refused ? 'border-warn/30 bg-warn/5' : 'border-border/70 bg-background/30',
      )}
    >
      <Wrench
        className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', refused ? 'text-warn' : 'text-primary')}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-semibold">{t.name}</span>
          {gated && (
            <Badge
              variant={refused ? 'warning' : 'success'}
              className="gap-1 font-mono text-[11px]"
              title={
                refused
                  ? `Listed, but calling it requires role ${roles}, which this user does not hold`
                  : `Calling it requires role ${roles}, which this user holds`
              }
            >
              {refused ? <Lock className="h-3 w-3" /> : <Check className="h-3 w-3" />}
              {refused ? `needs ${roles}` : `role ${roles}`}
            </Badge>
          )}
        </div>
        {t.description && <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>}
      </div>
      <span
        className={cn('mt-0.5 shrink-0', refused ? 'text-warn' : 'text-success')}
        title={refused ? 'Listed, but the call will be refused' : 'Callable with this token'}
        aria-label={refused ? 'call refused' : 'callable'}
      >
        {refused ? <Lock className="h-4 w-4" /> : <Check className="h-4 w-4" />}
      </span>
    </li>
  );
}

function Verdict({ tier }: { tier: TierResult }) {
  switch (tier.status) {
    case 'ok': {
      const tools = orderTools(tier.tier, tier.tools);
      const refused = tools.filter((t) => t.callable === false);
      return (
        <div className="space-y-2">
          {tools.length === 0 && (
            <p className="text-sm text-muted-foreground">
              The gateway listed no tools for this token.
            </p>
          )}
          <ul className="space-y-1.5">
            {tools.map((t) => (
              <ToolRow key={t.name} t={t} />
            ))}
          </ul>
          {refused.length > 0 && (
            <p className="text-xs text-muted-foreground">
              <span className="text-warn">Listed ≠ callable.</span> The gateway filters{' '}
              <span className="font-mono">tools/list</span> by tier scope only, so{' '}
              {refused.map((t, i) => (
                <span key={t.name}>
                  {i > 0 && ', '}
                  <span className="font-mono">{t.name}</span>
                </span>
              ))}{' '}
              stays visible but the call is refused without role{' '}
              <span className="font-mono">
                {[...new Set(refused.flatMap((t) => t.requiredRoles ?? []))].join(' / ')}
              </span>
              .
            </p>
          )}
        </div>
      );
    }
    case 'step-up':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/10 p-3 text-sm text-warn">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Not listed — the specialist refused to even ask. This user has not authenticated with{' '}
            <span className="font-mono">acr={tier.acrValues}</span>, so no{' '}
            <span className="font-mono">{tier.scope}</span> token was minted.
          </span>
        </div>
      );
    case 'denied':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <Ban className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Not listed — Curity refused the exchange (
            <span className="font-mono">{tier.error}</span>): {tier.description}
          </span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Could not probe this tier (<span className="font-mono">{tier.error}</span>):{' '}
            {tier.description}
          </span>
        </div>
      );
  }
}

/**
 * Two columns — one per MCP tier — showing exactly the tools agentgateway's
 * `tools/list` returned for the CURRENT user (one row each, with the server's
 * description and any role gate), or the gate that stopped the probe before a
 * list could be fetched. The header separates the tier's REQUIREMENT (same for
 * everyone) from the VERDICT for this token. No persona special-casing: the
 * verdicts come from the same exchanges a real request performs.
 */
export function ToolVisibility({ tiers }: { tiers: TierResult[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {tiers.map((t) => {
        const meta = TIER_META[t.tier];
        const verdict = tierVerdict(t);
        const ok = t.status === 'ok';
        return (
          <div
            key={t.tier}
            className={cn(
              'rounded-xl border bg-secondary/60 p-4',
              ok ? 'border-border' : 'border-dashed border-border/80',
            )}
          >
            <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <meta.Icon className={cn('h-4 w-4', meta.iconClass)} />
                <span className="text-sm font-semibold">{meta.title}</span>
                <Badge variant="outline" className="font-mono text-[11px]">
                  {t.route}
                </Badge>
                <Badge
                  variant="outline"
                  className="font-mono text-[11px]"
                  title="The tier's requirement, the same for every caller"
                >
                  requires {meta.scope}
                </Badge>
              </div>
              <Badge
                variant={VERDICT_VARIANT[verdict.tone]}
                className="text-[11px]"
                title="What the gateway did for your token"
              >
                {verdict.label}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{meta.blurb}</p>
            <p className="mb-3 mt-1 text-xs text-muted-foreground/90">{meta.gate}</p>
            <Verdict tier={t} />
          </div>
        );
      })}
    </div>
  );
}
