import {
  Box,
  CheckCircle2,
  Clock,
  Layers,
  Lock,
  RotateCw,
  Workflow,
  XCircle,
} from 'lucide-react';

import { Badge, type BadgeProps } from '@/components/ui/badge';
import { JsonBlock } from '@/components/json-block';

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
        Privileged actions are routed to the specialist agent over A2A, which runs its own
        LLM tool-calling loop (inspect → act → verify); those steps appear here when the run
        executes. The authorization gates — role, scope, and MFA step-up — are enforced
        deterministically before the loop runs, so this summary is shown when no tool steps
        were produced (e.g. a step-up challenge or a denied/failed action).
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
