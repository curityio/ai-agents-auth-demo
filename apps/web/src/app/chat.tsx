'use client';

import { useEffect, useState } from 'react';
import { signIn } from 'next-auth/react';
import {
  AlertTriangle,
  ChevronUp,
  Eye,
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
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { WorkloadIdentities } from '@/components/workload-identities';
import { FlowBadge } from '@/components/flow-badge';
import { flowOfChain } from '@/lib/token-view';
import { rotatedWorkloads, type SvidView } from '@/lib/svid-view';
import { ResultSkeleton } from '@/components/result-skeleton';
import { friendlyFetchError } from '@/lib/fetch-error';
import {
  classifyAgentFailure,
  DEFAULT_PROMPT,
  flowOf,
  panelsToRefresh,
  SUGGESTION_GROUPS,
  svidFlowToShow,
  type AgentFailure,
  type Flow,
} from '@/lib/chat-rules';
import type { Asking } from '@/lib/asking';
import { RequestFailure } from '@/components/request-failure';
import { stashStepUp, takeStepUpReturn, type StepUpReturn } from '@/lib/step-up-return';
import { ResultCard, type AgentResponse } from '@/components/result-card';
import { DelegationLedger } from '@/components/delegation-ledger';
import { ToolVisibility, type ToolTiersResponse } from '@/components/tool-visibility';

interface StepUpState {
  acrValues: string;
  scope: string;
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

export interface ChatPreview {
  response?: AgentResponse | null;
  svids?: SvidView[] | null;
  obo?: OboChainResponse | null;
  tools?: ToolTiersResponse | null;
}

export function Chat({
  preview,
  asking,
}: {
  preview?: ChatPreview;
  /** Claims the request will carry, decoded server-side from the access token. */
  asking?: Asking;
} = {}) {
  const [message, setMessage] = useState(DEFAULT_PROMPT);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AgentResponse | null>(preview?.response ?? null);
  // The prompt the current answer is for — the Result card repeats it, since
  // the box may have been edited since.
  const [asked, setAsked] = useState<string | undefined>(undefined);
  const [error, setError] = useState<Exclude<AgentFailure, { kind: 'step-up' }> | null>(null);
  const [stepUp, setStepUp] = useState<StepUpState | null>(null);
  // Set when the page remounted after an MFA step-up redirect: the prompt the
  // user typed is being retried on their behalf, and the banner says so.
  const [mfaReturn, setMfaReturn] = useState<StepUpReturn | null>(null);

  const [svids, setSvids] = useState<SvidView[] | null>(preview?.svids ?? null);
  const [svidFlow, setSvidFlow] = useState<Flow>('read');
  // Workloads whose SVID was re-issued between the previous view and this one:
  // shows spiffe-helper rotation happening, rather than asserting it.
  const [svidRotated, setSvidRotated] = useState<Set<string>>(new Set());
  const [svidLoading, setSvidLoading] = useState(false);
  const [svidError, setSvidError] = useState<string | null>(null);

  const [obo, setObo] = useState<OboChainResponse | null>(preview?.obo ?? null);
  const [oboLoading, setOboLoading] = useState(false);
  const [oboError, setOboError] = useState<string | null>(null);

  const [tools, setTools] = useState<ToolTiersResponse | null>(preview?.tools ?? null);
  const [toolsLoading, setToolsLoading] = useState(false);
  const [toolsError, setToolsError] = useState<string | null>(null);

  // Restore the prompt the user submitted before a step-up redirect, and
  // (one-shot) auto-retry it now that they've authenticated with MFA. A
  // step-up is a full-page OIDC redirect, which remounts this component.
  useEffect(() => {
    const back = takeStepUpReturn(sessionStorage);
    if (!back) return;
    setMessage(back.message);
    if (back.retry) {
      setMfaReturn(back);
      void submit(back.message, { fromStepUp: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(overrideMessage?: string, opts: { fromStepUp?: boolean } = {}) {
    const outgoing = overrideMessage ?? message;
    if (!outgoing.trim()) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    setStepUp(null);
    if (!opts.fromStepUp) setMfaReturn(null);
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
        const failure = classifyAgentFailure(r.status, body);
        if (failure.kind === 'step-up') {
          setStepUp({ acrValues: failure.acrValues, scope: failure.scope });
        } else {
          setError(failure);
        }
        return;
      }

      const resp = body as AgentResponse;
      setResponse(resp);
      setAsked(outgoing);
      // A new answer refreshes the panels that explain it — only the ones the
      // presenter already opened; nothing opens by itself.
      const plan = panelsToRefresh({
        svidsOpen: svids !== null,
        oboOpen: obo !== null,
        toolsOpen: tools !== null,
      });
      if (plan.chain) void loadObo();
      if (plan.svids) void loadSvids(flowOf(resp));
      if (plan.tools) void loadTools();
    } catch (e) {
      setError({
        kind: 'failed',
        message: "Couldn't reach the copilot. Check your connection and try again.",
        detail: String(e),
      });
    } finally {
      setLoading(false);
    }
  }

  async function loadSvids(flowOverride?: Flow) {
    const before = svids;
    setSvidLoading(true);
    setSvidError(null);
    setSvids(null);
    try {
      // Show only the workloads in the flow the user just ran. The privileged
      // (A2A → mcp-ops) path is signalled by `route`/`specialist` on the response;
      // anything else is the read path through mcp-observability. Before any
      // answer there is no flow, so nothing is fetched and the panel says so —
      // the same beat as the chain panel's "No hops yet".
      const flow = svidFlowToShow(response, flowOverride);
      if (!flow) {
        setSvidRotated(new Set());
        setSvids([]);
        return;
      }
      const r = await fetch(`/api/spiffe-identities?flow=${flow}`, { cache: 'no-store' });
      if (!r.ok) {
        setSvidError(`${r.status}: ${await r.text()}`);
        return;
      }
      const body = (await r.json()) as SpiffeIdentitiesResponse;
      setSvidFlow(flow);
      setSvidRotated(rotatedWorkloads(before, body.workloads));
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
      <Card id="ask" className="scroll-mt-24">
        <CardHeader>
          <CardTitle className="flex items-center gap-2.5 text-lg">
            <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
              <Sparkles />
            </span>
            Ask the copilot
          </CardTitle>
          <CardDescription>
            Read-only questions are answered by the copilot directly; privileged actions route to
            the specialist and trigger a step-up MFA prompt.
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

          {/* Example prompts, grouped by what they do. The group label and the
              chip colour say "read" vs "privileged" in place, so no legend. */}
          <div className="space-y-2">
            {SUGGESTION_GROUPS.map((g) => (
              <div key={g.label} data-prompt-group={g.label} className="flex items-start gap-2">
                <span
                  className={`inline-flex w-20 shrink-0 items-center gap-1.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide ${
                    g.tier === 'write' ? 'text-warn/90' : 'text-muted-foreground'
                  }`}
                >
                  {g.tier === 'write' ? (
                    <Lock className="h-3 w-3" />
                  ) : (
                    <Eye className="h-3 w-3 text-accent-violet" />
                  )}
                  {g.label}
                </span>
                <div className="flex flex-1 flex-wrap gap-2">
                  {g.prompts.map((s) => (
                    <button
                      key={s.text}
                      type="button"
                      onClick={() => setMessage(s.text)}
                      title={
                        s.tier === 'write'
                          ? 'Privileged: routes to the specialist and requires MFA step-up'
                          : 'Read-only: answered by the copilot via mcp-observability'
                      }
                      className={
                        s.tier === 'write'
                          ? 'inline-flex items-center rounded-full border border-dashed border-warn/40 bg-warn/5 px-3 py-1 text-xs text-warn/90 transition-colors hover:border-warn/70 hover:bg-warn/15 hover:text-warn'
                          : 'inline-flex items-center rounded-full border border-dashed border-border bg-secondary/40 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-accent hover:text-accent-foreground'
                      }
                    >
                      {s.text}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-4">
            {/* Who the request goes out as — stated before Send, so the acr can
                be pointed at before a privileged prompt triggers step-up. */}
            {asking?.sub ? (
              <p data-asking-as className="text-xs text-muted-foreground">
                Asking as <span className="font-medium text-foreground/90">{asking.sub}</span>
                {asking.roles.length > 0 && (
                  <>
                    {' '}
                    · roles{' '}
                    <span className="font-mono text-foreground/80">{asking.roles.join(', ')}</span>
                  </>
                )}
                {asking.acr && (
                  <>
                    {' '}
                    · acr <span className="font-mono text-foreground/80">{asking.acr}</span>
                  </>
                )}
                {asking.acr !== 'mfa' && (
                  <span className="text-muted-foreground/70">
                    {' '}
                    · privileged prompts will step up to MFA
                  </span>
                )}
              </p>
            ) : (
              <span />
            )}
            <span className="flex items-center gap-3">
              <span
                className="hidden items-center gap-1 text-[11px] text-muted-foreground/70 sm:inline-flex"
                title="Cmd or Ctrl + Enter sends"
              >
                <kbd className="rounded border border-border/70 bg-secondary/60 px-1.5 py-0.5 font-sans">
                  ⌘
                </kbd>
                <kbd className="rounded border border-border/70 bg-secondary/60 px-1.5 py-0.5 font-sans">
                  ↵
                </kbd>
              </span>
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={loading || !message.trim()}
              >
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
            </span>
          </div>
        </CardContent>
      </Card>

      {error && <RequestFailure failure={error} />}

      {mfaReturn && (
        <Alert variant="info" className="animate-fade-in-up">
          <ShieldCheck className="h-4 w-4" />
          <AlertTitle>Re-authenticated with MFA</AlertTitle>
          <AlertDescription>
            Curity issued a fresh token with <code className="font-mono">acr=mfa</code>
            {mfaReturn.scope && (
              <>
                {' '}
                and scope <code className="font-mono">{mfaReturn.scope}</code>
              </>
            )}
            . {loading ? 'Retrying your request now…' : 'Your request was retried automatically.'}
          </AlertDescription>
        </Alert>
      )}

      {stepUp && (
        <Alert variant="warning">
          <Lock className="h-4 w-4" />
          <AlertTitle>Step-up authentication required</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              This is a privileged action. Re-authenticate with multi-factor authentication to
              obtain an <code className="font-mono">acr=mfa</code> token for scope{' '}
              <code className="font-mono">{stepUp.scope}</code>.
            </p>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                stashStepUp(sessionStorage, message, stepUp.scope);
                void signIn(
                  'curity',
                  { callbackUrl: '/' },
                  {
                    acr_values: stepUp.acrValues,
                    // NOT `login`: Curity's TOTP authenticator has html-auth as its
                    // previous-authenticator, so the user's existing password SSO
                    // session identifies them and the step-up lands straight on the
                    // OTP page. prompt=login discards every SSO session and would put
                    // a password prompt in front of the TOTP. The TOTP factor itself
                    // cannot be satisfied by SSO (1s lifetime in the configmap), so
                    // every privileged action still asks for a code.
                    prompt: 'consent',
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

      {loading && !response && <ResultSkeleton />}

      {response && <ResultCard response={response} asked={asked} />}

      <Card id="identities" className="scroll-mt-24">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2.5 text-lg">
                <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
                  <Fingerprint />
                </span>
                Workload Identities
              </CardTitle>
              <CardDescription className="max-w-xl">
                Each pod carries its own SPIFFE JWT-SVID, distinct from the user token. These serve
                as the <code className="font-mono">actor_token</code> in the RFC 8693 token exchange
                that delegates the user’s authority down the chain. Shown in chain order for the
                flow you last ran.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {(svids || svidError) && !svidLoading && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSvids(null);
                    setSvidError(null);
                  }}
                >
                  <ChevronUp />
                  Hide
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadSvids()}
                disabled={svidLoading}
              >
                {svidLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {svidLoading ? 'Fetching…' : svids ? 'Refresh' : 'Show identities'}
              </Button>
            </div>
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
            {svids && svids.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No flow yet — ask the copilot a question first, then refresh.
              </p>
            )}
            {svids && svids.length > 0 && (
              <WorkloadIdentities svids={svids} flow={svidFlow} rotated={svidRotated} />
            )}
          </CardContent>
        )}
      </Card>

      <Card id="chain" className="scroll-mt-24">
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
                Each hop is one OAuth 2 token the request traveled with, diffed against the token it
                was exchanged from.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {(obo || oboError) && !oboLoading && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setObo(null);
                    setOboError(null);
                  }}
                >
                  <ChevronUp />
                  Hide
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadObo()}
                disabled={oboLoading}
              >
                {oboLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {oboLoading ? 'Loading…' : obo ? 'Refresh' : 'Show chain'}
              </Button>
            </div>
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
            {obo && obo.chain.length > 0 && (
              <div className="space-y-4">
                {(() => {
                  const flow = flowOfChain(obo.chain);
                  return flow ? (
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <FlowBadge flow={flow} />
                      <span>
                        {flow === 'privileged'
                          ? 'The copilot delegated to the specialist, which acted through mcp-ops.'
                          : 'The copilot read through mcp-observability on its own.'}
                      </span>
                    </div>
                  ) : null;
                })()}
                <DelegationLedger chain={obo.chain} />
              </div>
            )}
          </CardContent>
        )}
      </Card>

      <Card id="tools" className="scroll-mt-24">
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2.5 text-lg">
                <span className="mesh-hero flex h-8 w-8 items-center justify-center rounded-xl text-white shadow-sm ring-1 ring-white/30 [&_svg]:h-4 [&_svg]:w-4">
                  <Wrench />
                </span>
                Tools this token can reach
              </CardTitle>
              <CardDescription className="max-w-xl">
                The MCP tools agentgateway lists for <em>your</em> token, per tier. The list is
                filtered by tier scope, and the write tier is only probed once the MFA and role
                conditions are met.
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              {(tools || toolsError) && !toolsLoading && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTools(null);
                    setToolsError(null);
                  }}
                >
                  <ChevronUp />
                  Hide
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void loadTools()}
                disabled={toolsLoading}
              >
                {toolsLoading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                {toolsLoading ? 'Probing…' : tools ? 'Refresh' : 'Check tools'}
              </Button>
            </div>
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
