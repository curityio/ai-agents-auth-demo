'use client';

import { Activity, Bot, ExternalLink, Fingerprint, Layers, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CopyButton } from '@/components/copy-button';
import { FlowBadge } from '@/components/flow-badge';
import { JsonBlock } from '@/components/json-block';
import { Markdown } from '@/components/markdown';
import {
  IntentBadges,
  PrivilegedTrace,
  ToolTrace,
  type RestartIntent,
  type SpecialistView,
} from '@/components/agent-trace';
import { flowOf } from '@/lib/chat-rules';
import { GRAFANA_URL, grafanaTraceUrl } from '@/lib/trace-link';
import type { TraceStep as AgentStep } from '@/lib/trace-view';

export interface AgentResponse {
  answer: string;
  identity: { sub: string; scopes: string[]; roles?: string[]; acr?: string };
  // Inspect path: the LLM tool-calling steps.
  steps?: AgentStep[];
  // Privileged path: a deterministic agent-to-agent route (no LLM steps).
  route?: string;
  intent?: RestartIntent;
  specialist?: SpecialistView;
  /** The OpenTelemetry trace the copilot handled this request in. */
  traceId?: string;
}

export type ResultTab = 'answer' | 'identity' | 'trace';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-14 text-sm text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** The trace this run happened in, with the one-click way into Grafana. */
function TraceLink({ traceId, grafanaUrl }: { traceId: string; grafanaUrl: string }) {
  return (
    <div
      data-trace-id
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border/70 bg-secondary/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="inline-flex items-center gap-1.5">
        <Activity className="h-3.5 w-3.5 text-success" />
        trace
      </span>
      <code className="font-mono text-foreground/80">{traceId}</code>
      <CopyButton value={traceId} />
      <a
        href={grafanaTraceUrl(grafanaUrl, traceId)}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 font-medium text-primary underline-offset-4 hover:underline"
      >
        Open in Grafana
        <ExternalLink className="h-3 w-3" />
      </a>
      <span className="text-muted-foreground/70">· Tempo keeps traces for 30 minutes</span>
    </div>
  );
}

/**
 * The copilot's answer with the identity it presented and the tools it
 * called. Self-contained: it repeats the question and names the flow, so it
 * still reads once the prompt box has been edited.
 */
export function ResultCard({
  response,
  asked,
  defaultTab = 'answer',
  grafanaUrl = GRAFANA_URL,
}: {
  response: AgentResponse;
  /** The prompt that was submitted; absent for preview data. */
  asked?: string;
  defaultTab?: ResultTab;
  grafanaUrl?: string;
}) {
  const flow = flowOf(response);
  const { identity } = response;
  return (
    <Card id="result" className="scroll-mt-24 animate-fade-in-up">
      <CardHeader>
        <CardTitle className="flex items-center gap-2.5 text-lg">
          <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
            <Bot />
          </span>
          Result
        </CardTitle>
        <CardDescription>
          The agent’s answer plus the identity it presented and the tools it called.
        </CardDescription>
        <div
          {...(asked ? { 'data-asked': true } : {})}
          className="flex flex-wrap items-center gap-2 pt-1 text-sm"
        >
          <FlowBadge flow={flow} />
          {asked && (
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="text-muted-foreground">You asked</span>
              <q className="truncate italic text-foreground/90">{asked}</q>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue={defaultTab}>
          <TabsList>
            <TabsTrigger value="answer">
              <Sparkles />
              Answer
            </TabsTrigger>
            <TabsTrigger value="identity">
              <Fingerprint />
              Identity
            </TabsTrigger>
            <TabsTrigger value="trace">
              <Layers />
              Trace
            </TabsTrigger>
          </TabsList>

          <TabsContent value="answer" className="space-y-4">
            <Markdown className="rounded-xl border border-border bg-secondary/60 p-4 text-[15px] leading-relaxed">
              {response.answer}
            </Markdown>
            <IntentBadges intent={response.intent} />
          </TabsContent>

          <TabsContent value="identity" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              The user token as the copilot received it — before any exchange. The narrowed token
              each hop carried is in the{' '}
              <a
                href="#chain"
                className="font-medium text-primary underline-offset-4 hover:underline"
              >
                On-behalf-of chain
              </a>
              .
            </p>
            <Row label="Subject">
              <Badge variant="secondary" className="font-mono">
                {identity.sub}
              </Badge>
            </Row>
            <Row label="Scopes">
              {identity.scopes.length > 0 ? (
                identity.scopes.map((scope) => (
                  <Badge key={scope} variant="success" className="font-mono">
                    {scope}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">none</span>
              )}
            </Row>
            <Row label="Roles">
              {identity.roles && identity.roles.length > 0 ? (
                identity.roles.map((role) => (
                  <Badge key={role} variant="secondary" className="font-mono">
                    {role}
                  </Badge>
                ))
              ) : (
                <span className="text-sm text-muted-foreground">none</span>
              )}
            </Row>
            <Row label="ACR">
              {identity.acr ? (
                <Badge
                  variant={identity.acr === 'mfa' ? 'success' : 'secondary'}
                  className="font-mono"
                >
                  {identity.acr}
                </Badge>
              ) : (
                <span className="text-sm text-muted-foreground">none</span>
              )}
              {identity.acr !== 'mfa' && (
                <span data-stepup-note className="text-xs text-muted-foreground">
                  privileged actions need <code className="font-mono">acr=mfa</code> — the first one
                  will ask you to step up
                </span>
              )}
            </Row>
            <details className="rounded-lg border bg-muted/10">
              <summary className="cursor-pointer px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                Raw claims
              </summary>
              <div className="px-3.5 pb-3.5">
                <JsonBlock data={identity} />
              </div>
            </details>
          </TabsContent>

          <TabsContent value="trace" className="space-y-4">
            {response.traceId && <TraceLink traceId={response.traceId} grafanaUrl={grafanaUrl} />}
            {response.steps && response.steps.length > 0 ? (
              <ToolTrace
                steps={response.steps}
                flow={flow}
                route={response.route}
                specialist={response.specialist}
              />
            ) : response.route || response.specialist ? (
              <PrivilegedTrace
                route={response.route}
                intent={response.intent}
                specialist={response.specialist}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No execution trace available for this response.
              </p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
