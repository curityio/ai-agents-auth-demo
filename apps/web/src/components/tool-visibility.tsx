'use client';

import { Ban, Eye, Lock, ShieldAlert, Wrench } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export interface ToolInfo {
  name: string;
  description?: string;
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
    case 'ok':
      return (
        <div className="flex flex-wrap gap-1.5">
          {tier.tools.length === 0 && (
            <span className="text-sm text-muted-foreground">The gateway listed no tools for this token.</span>
          )}
          {tier.tools.map((t) => (
            <Badge key={t.name} variant="success" className="gap-1 font-mono" title={t.description}>
              <Wrench className="h-3 w-3" />
              {t.name}
            </Badge>
          ))}
        </div>
      );
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
