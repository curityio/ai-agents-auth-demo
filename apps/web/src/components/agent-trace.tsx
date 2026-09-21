import {
  Box,
  CheckCircle2,
  Clock,
  Layers,
  Lock,
  RotateCw,
  Workflow,
  Wrench,
  XCircle,
} from 'lucide-react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { JsonBlock } from '@/components/json-block';
import { cn } from '@/lib/utils';
import type { Flow } from '@/lib/chat-rules';
import { toolTier } from '@/lib/tool-view';
import { buildTraceRows, type TraceStep } from '@/lib/trace-view';

/** The deterministic intent the copilot parsed for a privileged action. */
export interface RestartIntent {
  kind?: string;
  deployment?: string;
  namespace?: string;
  reasonHint?: string;
}

/** The agent-specialist's A2A response, as surfaced by the BFF. */
export interface SpecialistView {
  ok?: boolean;
  status?: string;
  text?: string;
  result?: unknown;
}

const DEFAULT_NAMESPACE = 'prod';

/** Friendly chips summarizing the parsed action — shown in the Answer tab. */
export function IntentBadges({ intent }: { intent?: RestartIntent }) {
  if (!intent?.deployment) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Action
      </span>
      <Badge variant="secondary" className="gap-1">
        <RotateCw className="h-3.5 w-3.5" />
        {intent.kind ?? 'restart'}
      </Badge>
      <Badge variant="outline" className="gap-1 font-mono">
        <Box className="h-3.5 w-3.5 text-primary" />
        {intent.deployment}
      </Badge>
      <Badge variant="outline" className="gap-1 font-mono">
        <Layers className="h-3.5 w-3.5 text-primary" />
        {intent.namespace ?? DEFAULT_NAMESPACE}
      </Badge>
    </div>
  );
}

const STATUS_CONFIG: Record<string, { variant: BadgeProps['variant']; Icon: typeof Clock }> = {
  completed: { variant: 'success', Icon: CheckCircle2 },
  failed: { variant: 'destructive', Icon: XCircle },
  'step-up': { variant: 'warning', Icon: Lock },
};

export function SpecialistStatusBadge({ status, ok }: { status?: string; ok?: boolean }) {
  const label = status ?? (ok ? 'completed' : 'unknown');
  const conf = STATUS_CONFIG[label] ?? { variant: 'muted' as const, Icon: Clock };
  const { Icon } = conf;
  return (
    <Badge variant={conf.variant} className="gap-1">
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Badge>
  );
}

/**
 * Readable rendering of the privileged (deterministic A2A) route — replaces a
 * raw JSON dump in the Trace tab. Shows the route + specialist status, the
 * parsed action, the specialist's message, and the raw payload on demand.
 */
export function PrivilegedTrace({
  route,
  intent,
  specialist,
}: {
  route?: string;
  intent?: RestartIntent;
  specialist?: SpecialistView;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Privileged actions are routed to the specialist agent over A2A, which runs its own LLM
        tool-calling loop (inspect → act → verify); those steps appear here when the run executes.
        The authorization gates — role, scope, and MFA step-up — are enforced deterministically
        before the loop runs, so this summary is shown when no tool steps were produced (e.g. a
        step-up challenge or a denied/failed action).
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="gap-1">
          <Workflow className="h-3.5 w-3.5 text-primary" />
          {route ?? 'privileged'}
        </Badge>
        {specialist && <SpecialistStatusBadge status={specialist.status} ok={specialist.ok} />}
      </div>

      {intent?.deployment && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 rounded-lg border bg-muted/20 p-4 text-sm">
          <dt className="text-muted-foreground">Deployment</dt>
          <dd className="font-mono">{intent.deployment}</dd>
          <dt className="text-muted-foreground">Namespace</dt>
          <dd className="font-mono">{intent.namespace ?? DEFAULT_NAMESPACE}</dd>
          {intent.reasonHint && (
            <>
              <dt className="text-muted-foreground">Reason</dt>
              <dd className="text-foreground/80">{intent.reasonHint}</dd>
            </>
          )}
        </dl>
      )}

      {specialist?.text && (
        <div className="rounded-lg border bg-muted/20 p-3.5">
          <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Specialist response
          </div>
          <p className="whitespace-pre-wrap break-words text-sm">{specialist.text}</p>
        </div>
      )}

      <details className="rounded-lg border bg-muted/10">
        <summary className="cursor-pointer px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          Raw response
        </summary>
        <div className="px-3.5 pb-3.5">
          <JsonBlock data={{ route, intent, specialist }} />
        </div>
      </details>
    </div>
  );
}

/**
 * Readable rendering of an LLM tool-calling loop: one row per tool call, with
 * the arguments the model chose and a one-line result summary. The read flow
 * is the copilot's own loop; the privileged flow is the specialist's
 * inspect → act → verify loop, forwarded over A2A — the same shape, but a
 * different agent, and the act step went to mcp-ops on ops:write. The raw
 * step payload stays available on demand.
 */
export function ToolTrace({
  steps,
  flow,
  route,
  specialist,
}: {
  steps: TraceStep[];
  flow: Flow;
  route?: string;
  specialist?: SpecialistView;
}) {
  const rows = buildTraceRows(steps);
  // The loop's overall outcome is the LAST step's finish reason (usually
  // 'stop' on the final, tool-free answer step), not the last tool call's.
  const finishReason = steps[steps.length - 1]?.finishReason;
  return (
    <div className="space-y-4">
      {flow === 'privileged' ? (
        <>
          <p className="text-sm text-muted-foreground">
            The specialist's LLM chose these tool calls, in order: inspect, act, verify. Reads went
            to mcp-observability on <code className="font-mono">obs:read</code>; the action went to
            mcp-ops on <code className="font-mono">ops:write</code>, which Curity only issues for{' '}
            <code className="font-mono">acr=mfa</code>.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline" className="gap-1">
              <Workflow className="h-3.5 w-3.5 text-primary" />
              {route ?? 'privileged'}
            </Badge>
            {specialist && <SpecialistStatusBadge status={specialist.status} ok={specialist.ok} />}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          The copilot's LLM chose these tool calls, in order. Each one travelled through
          agentgateway to mcp-observability on a token narrowed to{' '}
          <code className="font-mono">obs:read</code>.
        </p>
      )}

      <ol className="relative space-y-3 before:absolute before:left-[11px] before:top-2 before:h-[calc(100%-1rem)] before:w-px before:bg-border">
        {rows.map((r) => {
          const tier = toolTier(r.tool);
          const ops = tier === 'ops';
          return (
            <li key={r.index} data-tier={tier} className="relative pl-9">
              <span
                className={cn(
                  'absolute left-0 top-0.5 flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold text-white shadow-sm ring-2 ring-background',
                  r.failed ? 'bg-destructive' : ops ? 'bg-warn' : 'mesh-hero',
                )}
              >
                {r.index}
              </span>
              <div
                className={cn(
                  'rounded-xl border p-3.5',
                  ops ? 'border-warn/40 bg-warn/5' : 'border-border bg-secondary/60',
                )}
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 font-mono text-sm font-semibold">
                    {ops ? (
                      <Lock className="h-3.5 w-3.5 text-warn" />
                    ) : (
                      <Wrench className="h-3.5 w-3.5 text-primary" />
                    )}
                    {r.tool}
                    {ops && (
                      <Badge variant="warning" className="ml-1 font-sans text-[11px] font-normal">
                        ops:write · mfa
                      </Badge>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="muted" className="font-mono text-[11px]">
                      step {r.step}
                    </Badge>
                    <Badge variant={r.failed ? 'destructive' : 'success'} className="gap-1">
                      {r.failed ? (
                        <XCircle className="h-3 w-3" />
                      ) : (
                        <CheckCircle2 className="h-3 w-3" />
                      )}
                      {r.failed ? 'failed' : 'ok'}
                    </Badge>
                  </span>
                </div>

                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground pt-0.5">
                    args
                  </dt>
                  <dd className="flex flex-wrap gap-1.5">
                    {r.args.length === 0 && <span className="text-muted-foreground">none</span>}
                    {r.args.map(([k, v]) => (
                      <Badge key={k} variant="outline" className="font-mono">
                        <span className="text-muted-foreground">{k}=</span>
                        {v}
                      </Badge>
                    ))}
                  </dd>
                  <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground pt-0.5">
                    result
                  </dt>
                  <dd
                    className={cn(
                      'font-mono text-xs',
                      r.failed ? 'text-destructive' : 'text-foreground/80',
                    )}
                  >
                    {r.summary}
                  </dd>
                </dl>

                {r.result !== undefined && (
                  <details className="mt-2 rounded-lg border bg-muted/10">
                    <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                      Full result
                    </summary>
                    <div className="px-3 pb-3">
                      <JsonBlock data={r.result} />
                    </div>
                  </details>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {rows.length} tool call{rows.length === 1 ? '' : 's'} across {steps.length} step
        {steps.length === 1 ? '' : 's'}
        {finishReason && (
          <>
            <span aria-hidden>·</span>
            finished: <span className="font-mono">{finishReason}</span>
          </>
        )}
      </div>

      <details className="rounded-lg border bg-muted/10">
        <summary className="cursor-pointer px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
          Raw steps
        </summary>
        <div className="px-3.5 pb-3.5">
          <JsonBlock data={steps} />
        </div>
      </details>
    </div>
  );
}
