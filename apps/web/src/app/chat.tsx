'use client';

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import {
  AlertTriangle,
  Clock,
  Fingerprint,
  Layers,
  Loader2,
  Lock,
  RefreshCw,
  SendHorizontal,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { JsonBlock } from '@/components/json-block';
import { friendlyFetchError } from '@/lib/fetch-error';
import {
  IntentBadges,
  PrivilegedTrace,
  type RestartIntent,
  type SpecialistView,
} from '@/components/agent-trace';
import { DelegationLedger } from '@/components/delegation-ledger';
import { ToolVisibility, type ToolTiersResponse } from '@/components/tool-visibility';

interface AgentStep {
  toolCalls?: Array<{ name: string; args: unknown }>;
  toolResults?: Array<{ name: string; result: unknown }>;
  finishReason?: string;
}

interface AgentResponse {
  answer: string;
  identity: { sub: string; scopes: string[]; roles?: string[]; acr?: string };
  // Observability path: the LLM tool-calling steps.
  steps?: AgentStep[];
  // Privileged path: a deterministic agent-to-agent route (no LLM steps).
  route?: string;
  intent?: RestartIntent;
  specialist?: SpecialistView;
}

interface StepUpState {
  acrValues: string;
  scope: string;
}

interface SvidView {
  workload: string;
  sub?: string;
  aud?: string | string[];
  iss?: string;
  iat?: number;
  exp?: number;
  ttl_seconds?: number;
  error?: string;
}

interface SpiffeIdentitiesResponse {
  workloads: SvidView[];
}

interface DecodedView {
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
}

interface ChainHopView extends DecodedView {
  hop: string;
  /** Presenter-facing caveat from the emitting agent (today: the LLM leaf). */
  note?: string;
}

interface OboChainResponse {
  chain: ChainHopView[];
}

// Example prompts, chosen to exercise every MCP tool the copilot can reach.
// Read tier (observe path → mcp-observability): list_pods, get_pod_logs,
// get_deployment. Write tier (privileged path → agent-specialist → mcp-ops):
// restart_deployment, scale_deployment, set_deployment_image. Reads run inline;
// the writes route to the specialist and trigger MFA step-up.
const SUGGESTIONS = [
  // Read / observe
  'List all pods in the prod namespace',
  'Show recent logs for the checkout-service deployment in prod',
  'What image and replica count is order-service running in prod?',
  // Write / privileged (step-up gated)
  'Restart the order-service deployment in prod',
  'Scale checkout-service to 3 replicas in prod',
  'Update order-service to image busybox:1.36 and verify the rollout',
];

// A step-up (MFA) is a full-page OIDC redirect, which remounts this component
// and would otherwise discard the user's typed prompt. We stash it here before
// redirecting and restore + auto-retry it once on return.
const PENDING_KEY = 'sre.pendingMessage';
const RETRY_KEY = 'sre.autoRetry';

export interface ChatPreview {
  response?: AgentResponse | null;
  svids?: SvidView[] | null;
  obo?: OboChainResponse | null;
  tools?: ToolTiersResponse | null;
}

export function Chat({ preview }: { preview?: ChatPreview } = {}) {
  const [message, setMessage] = useState('List all pods in prod namespace');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AgentResponse | null>(preview?.response ?? null);
  const [error, setError] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<StepUpState | null>(null);

  const [svids, setSvids] = useState<SvidView[] | null>(preview?.svids ?? null);
  const [svidLoading, setSvidLoading] = useState(false);
  const [svidError, setSvidError] = useState<string | null>(null);

  const [obo, setObo] = useState<OboChainResponse | null>(preview?.obo ?? null);
  const [oboLoading, setOboLoading] = useState(false);
  const [oboError, setOboError] = useState<string | null>(null);

  const [tools, setTools] = useState<ToolTiersResponse | null>(preview?.tools ?? null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);

  // Restore the prompt the user submitted before a step-up redirect, and
  // (one-shot) auto-retry it now that they've authenticated with MFA.
  useEffect(() => {
    const pending = sessionStorage.getItem(PENDING_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_KEY);
    setMessage(pending);
    if (sessionStorage.getItem(RETRY_KEY)) {
      sessionStorage.removeItem(RETRY_KEY);
      void submit(pending);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(overrideMessage?: string) {
    const outgoing = overrideMessage ?? message;
    if (!outgoing.trim()) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    setStepUp(null);
    try {
      const r = await fetch('/api/agent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: outgoing }),
      });

      // Parse the body regardless of status — 401 step-up and 403 access-denied
      // both carry structured JSON we need to branch on.
      let body: unknown;
      try {
        body = await r.json();
      } catch {
        body = undefined;
      }

      if (!r.ok) {
        const kind =
          body && typeof body === 'object' ? (body as { kind?: string }).kind : undefined;

        if (r.status === 401 && kind === 'step-up') {
          const su = body as { acrValues: string; scope: string };
          setStepUp({ acrValues: su.acrValues, scope: su.scope });
          return;
        }

        if (r.status === 403 && kind === 'access-denied') {
          const ad = body as { reason: string };
          setError(`Access denied: ${ad.reason}`);
          return;
        }

        setError(
          `${r.status}: ${body && typeof body === 'object' ? JSON.stringify(body) : String(body ?? '')}`,
        );
        return;
      }

      const resp = body as AgentResponse;
      setResponse(resp);
      // If the identities panel is already open, refresh it to the flow just run
      // so it shows the relevant workloads (read vs privileged) without a manual click.
      if (svids !== null) {
        void loadSvids(resp.route || resp.specialist ? 'privileged' : 'read');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadSvids(flowOverride?: 'read' | 'privileged') {
    setSvidLoading(true);
    setSvidError(null);
    setSvids(null);
    try {
      // Show only the workloads in the flow the user just ran. The privileged
      // (A2A → mcp-ops) path is signalled by `route`/`specialist` on the response;
      // anything else is the read path through mcp-observability.
      const flow =
        flowOverride ?? (response?.route || response?.specialist ? 'privileged' : 'read');
      const r = await fetch(`/api/spiffe-identities?flow=${flow}`, { cache: 'no-store' });
      if (!r.ok) {
        setSvidError(`${r.status}: ${await r.text()}`);
        return;
      }
      const body = (await r.json()) as SpiffeIdentitiesResponse;
      setSvids(body.workloads);
    } catch (e) {
      setSvidError(String(e));
    } finally {
      setSvidLoading(false);
    }
  }

  async function loadObo() {
    setOboLoading(true);
    setOboError(null);
    setObo(null);
    try {
      const r = await fetch('/api/obo-chain', { cache: 'no-store' });
      if (!r.ok) {
        setOboError(await friendlyFetchError(r, 'the on-behalf-of chain'));
        return;
      }
      setObo((await r.json()) as OboChainResponse);
    } catch {
      setObo(null);
      setOboError("Couldn't load the on-behalf-of chain. Please try again.");
    } finally {
      setOboLoading(false);
    }
  }

  async function loadTools() {
    setToolsLoading(true);
    setToolsError(null);
    setTools(null);
    try {
      const r = await fetch('/api/tools', { cache: 'no-store' });
      if (!r.ok) {
        setToolsError(await friendlyFetchError(r, 'the visible tools'));
        return;
      }
      setTools((await r.json()) as ToolTiersResponse);
    } catch {
      setToolsError("Couldn't load the visible tools. Please try again.");
    } finally {
      setToolsLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5 text-lg">
            <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
              <Sparkles />
            </span>
            Ask the copilot
          </CardTitle>
          <CardDescription>
            Phrase a request in plain language. Read-only questions resolve instantly;
            privileged actions trigger a step-up MFA prompt.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="e.g. List all pods in the prod namespace"
            className="resize-none text-[15px]"
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && message.trim() && !loading) {
                void submit();
              }
            }}
          />

          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setMessage(s)}
                className="rounded-full border border-dashed border-border bg-secondary/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground"
              >
                {s}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              Press <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘</kbd>{' '}
              +{' '}
              <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">Enter</kbd>{' '}
              to send
            </span>
            <Button type="button" onClick={() => void submit()} disabled={loading || !message.trim()}>
              {loading ? (
                <>
                  <Loader2 className="animate-spin" />
                  Asking…
                </>
              ) : (
                <>
                  <SendHorizontal />
                  Send
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Request failed</AlertTitle>
          <AlertDescription className="break-words font-mono text-xs">{error}</AlertDescription>
        </Alert>
      )}

      {stepUp && (
        <Alert variant="warning">
          <Lock className="h-4 w-4" />
          <AlertTitle>Step-up authentication required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              This is a privileged action. Re-authenticate with multi-factor
              authentication to obtain an <code className="font-mono">acr=mfa</code> token for
              scope <code className="font-mono">{stepUp.scope}</code>.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                sessionStorage.setItem(PENDING_KEY, message);
                sessionStorage.setItem(RETRY_KEY, '1');
                void signIn(
                  'curity',
                  { callbackUrl: '/' },
                  {
                    acr_values: stepUp.acrValues,
                    prompt: 'login consent',
                    // Keep llm:invoke on the step-up re-auth: this scope string
                    // OVERRIDES the login default, so omitting it would strip
                    // llm:invoke from the post-MFA token and break the agents' LLM
                    // egress during the privileged remediation.
                    scope: `openid obs:read llm:invoke ${stepUp.scope}`,
                  },
                );
              }}
            >
              <ShieldCheck />
              Authenticate with MFA
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {response && (
        <Card className="animate-fade-in-up">
          <CardHeader>
            <CardTitle className="text-lg">Result</CardTitle>
            <CardDescription>
              The agent’s answer plus the identity it presented and the tools it called.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="answer">
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
                <div className="whitespace-pre-wrap rounded-xl border border-border bg-secondary/60 p-4 text-[15px] leading-relaxed">
                  {response.answer}
                </div>
                <IntentBadges intent={response.intent} />
              </TabsContent>

              <TabsContent value="identity" className="space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">Subject</span>
                  <Badge variant="secondary" className="font-mono">
                    {response.identity.sub}
                  </Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">Scopes</span>
                  {response.identity.scopes.length > 0 ? (
                    response.identity.scopes.map((scope) => (
                      <Badge key={scope} variant="success" className="font-mono">
                        {scope}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">none</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">Roles</span>
                  {response.identity.roles && response.identity.roles.length > 0 ? (
                    response.identity.roles.map((role) => (
                      <Badge key={role} variant="secondary" className="font-mono">
                        {role}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-sm text-muted-foreground">none</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm text-muted-foreground">ACR</span>
                  {response.identity.acr ? (
                    <Badge
                      variant={response.identity.acr === 'mfa' ? 'success' : 'secondary'}
                      className="font-mono"
                    >
                      {response.identity.acr}
                    </Badge>
                  ) : (
                    <span className="text-sm text-muted-foreground">none</span>
                  )}
                </div>
                <JsonBlock data={response.identity} />
              </TabsContent>

              <TabsContent value="trace">
                {response.steps && response.steps.length > 0 ? (
                  <JsonBlock data={response.steps} />
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
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2.5 text-lg">
                <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
                  <Fingerprint />
                </span>
                Workload identities
              </CardTitle>
              <CardDescription className="max-w-xl">
                Each pod carries its own SPIFFE JWT-SVID, distinct from the user token.
                These serve as the <code className="font-mono">actor_token</code> in the RFC 8693
                token exchange that delegates the user’s authority down the chain.
              </CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadSvids()} disabled={svidLoading}>
              {svidLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {svidLoading ? 'Fetching…' : svids ? 'Refresh' : 'Show identities'}
            </Button>
          </div>
        </CardHeader>
        {(svidError || svids) && (
          <CardContent className="space-y-3">
            {svidError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="break-words font-mono text-xs">
                  {svidError}
                </AlertDescription>
              </Alert>
            )}
            {svids && (
              <div className="grid gap-3 sm:grid-cols-2">
                {svids.map((s) => (
                  <div key={s.workload} className="rounded-xl border border-border bg-secondary/60 p-4 transition-shadow hover:shadow-md">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-mono text-sm font-semibold">{s.workload}</span>
                      {!s.error && typeof s.ttl_seconds === 'number' && (
                        <Badge variant="muted" className="gap-1 font-mono">
                          <Clock className="h-3 w-3" />
                          ttl {s.ttl_seconds}s
                        </Badge>
                      )}
                    </div>
                    {s.error ? (
                      <p className="text-sm text-destructive">{s.error}</p>
                    ) : (
                      <JsonBlock
                        data={{ sub: s.sub, aud: s.aud, iss: s.iss, ttl_seconds: s.ttl_seconds }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2.5 text-lg">
                <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
                  <Layers />
                </span>
                On-behalf-of chain
              </CardTitle>
              <CardDescription className="max-w-xl">
                Each hop is one OAuth 2 token the request traveled with, diffed against the
                token it was exchanged from: <code className="font-mono">scope</code> narrows
                (dropped scopes stay struck through), <code className="font-mono">act</code> grows
                by exactly one workload, and <code className="font-mono">may_act</code> names who
                is allowed to present the token next which the following hop then proves.
              </CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadObo()} disabled={oboLoading}>
              {oboLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {oboLoading ? 'Loading…' : obo ? 'Refresh' : 'Show chain'}
            </Button>
          </div>
        </CardHeader>
        {(oboError || obo) && (
          <CardContent>
            {oboError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">{oboError}</AlertDescription>
              </Alert>
            )}
            {obo && obo.chain.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No hops yet — ask the copilot a question first, then refresh.
              </p>
            )}
            {obo && obo.chain.length > 0 && <DelegationLedger chain={obo.chain} />}
          </CardContent>
        )}
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2.5 text-lg">
                <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
                  <Wrench />
                </span>
                MCP Tools Visibility
              </CardTitle>
              <CardDescription className="max-w-xl">
                The MCP tools agentgateway lists for <em>your</em> token, per tier. The list is
                filtered by tier scope, and the write tier is only probed after the MFA and role
                claim conditions are met. So what you see here is what the agents can even attempt.
              </CardDescription>
            </div>
            <Button type="button" variant="outline" size="sm" onClick={() => void loadTools()} disabled={toolsLoading}>
              {toolsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              {toolsLoading ? 'Probing…' : tools ? 'Refresh' : 'Check tools'}
            </Button>
          </div>
        </CardHeader>
        {(toolsError || tools) && (
          <CardContent>
            {toolsError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">{toolsError}</AlertDescription>
              </Alert>
            )}
            {tools && <ToolVisibility tiers={tools.tiers} />}
          </CardContent>
        )}
      </Card>
    </div>
  );
}
