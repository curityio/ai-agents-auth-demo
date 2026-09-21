'use client';

import { Ban, Eye, Lock, ShieldAlert, Wrench } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

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

export type TierResult = { tier: 'observability' | 'ops'; route: string } & TierStatus;

export interface ToolTiersResponse {
  tiers: TierResult[];
}

const TIER_META: Record<TierResult['tier'], { title: string; scope: string; blurb: string }> = {
  observability: {
    title: 'Read tier',
    scope: 'obs:read',
    blurb: 'mcp-observability, reached by the copilot directly.',
  },
  ops: {
    title: 'Write tier',
    scope: 'ops:write',
    blurb: 'mcp-ops, reached only by the specialist after MFA and a role check.',
  },
};

function Verdict({ tier }: { tier: TierResult }) {
  switch (tier.status) {
    case 'ok': {
      const gated = tier.tools.filter((t) => t.requiredRoles);
      const refused = gated.filter((t) => t.callable === false);
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {tier.tools.length === 0 && (
              <span className="text-sm text-muted-foreground">The gateway listed no tools for this token.</span>
            )}
            {tier.tools.map((t) => {
              // Listed by the gateway, but the server publishes a per-tool role rule
              // this user does not meet: the CALL will be refused. Keep it on screen
              // (that is the point) and say so, instead of letting "listed" read as
              // "allowed".
              if (t.callable === false) {
                return (
                  <Badge
                    key={t.name}
                    variant="warning"
                    className="gap-1 font-mono"
                    title={`${t.description ?? t.name} — listed, but calling it requires role ${t.requiredRoles!.join(' or ')}`}
                  >
                    <Lock className="h-3 w-3" />
                    {t.name}
                    <span className="font-sans font-normal opacity-80">· needs {t.requiredRoles!.join('/')}</span>
                  </Badge>
                );
              }
              return (
                <Badge
                  key={t.name}
                  variant="success"
                  className="gap-1 font-mono"
                  title={
                    t.requiredRoles
                      ? `${t.description ?? t.name} — calling it requires role ${t.requiredRoles.join(' or ')}, which this user holds`
                      : t.description
                  }
                >
                  <Wrench className="h-3 w-3" />
                  {t.name}
                </Badge>
              );
            })}
          </div>
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
              stays visible but the gateway refuses the call without role{' '}
              <span className="font-mono">{[...new Set(refused.flatMap((t) => t.requiredRoles ?? []))].join(' / ')}</span>.
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
            Not allowed. The user did not authenticate with{' '}
            <span className="font-mono">acr={tier.acrValues}</span>, so an{' '}
            <span className="font-mono">{tier.scope}</span> token not issued.
          </span>
        </div>
      );
    case 'denied':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <Ban className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Not listed — Curity refused the exchange (<span className="font-mono">{tier.error}</span>):{' '}
            {tier.description}
          </span>
        </div>
      );
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Could not probe this tier (<span className="font-mono">{tier.error}</span>): {tier.description}
          </span>
        </div>
      );
  }
}

/**
 * Two columns — one per MCP tier — showing exactly the tool names agentgateway's
 * `tools/list` returned for the CURRENT user, or the gate that stopped the probe
 * before a list could be fetched. No persona special-casing: the verdicts come
 * from the same exchanges a real request performs.
 */
export function ToolVisibility({ tiers }: { tiers: TierResult[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {tiers.map((t) => {
        const meta = TIER_META[t.tier];
        const ok = t.status === 'ok';
        return (
          <div
            key={t.tier}
            className={cn(
              'rounded-xl border bg-secondary/60 p-4',
              ok ? 'border-border' : 'border-dashed border-border/80',
            )}
          >
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">{meta.title}</span>
                <Badge variant="outline" className="font-mono text-[11px]">
                  {t.route}
                </Badge>
              </div>
              <Badge variant={ok ? 'success' : 'muted'} className="font-mono text-[11px]">
                requires {meta.scope}
              </Badge>
            </div>
            <p className="mb-3 text-xs text-muted-foreground">{meta.blurb}</p>
            <Verdict tier={t} />
          </div>
        );
      })}
    </div>
  );
}
