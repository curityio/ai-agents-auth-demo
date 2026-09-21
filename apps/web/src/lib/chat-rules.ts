/**
 * Pure rules for the chat surface, kept out of the component so they can be
 * pinned by tests.
 */
import { friendlyErrorMessage } from './fetch-error';

export type Flow = 'read' | 'privileged';

/**
 * Which delegation flow a copilot response came from. The privileged path
 * (A2A → agent-specialist → mcp-ops) is signalled by `route`/`specialist` on
 * the response; anything else went through mcp-observability.
 */
export function flowOf(response: { route?: string; specialist?: unknown }): Flow {
  return response.route || response.specialist ? 'privileged' : 'read';
}

export interface OpenPanels {
  svidsOpen: boolean;
  oboOpen: boolean;
  toolsOpen: boolean;
}

/**
 * After a successful answer, the panels that explain it refresh — but only
 * the ones the presenter has ALREADY opened. Nothing opens by itself: the demo
 * is narrated panel by panel, and a panel that appears unbidden steals that
 * beat. Refreshing an open panel keeps it truthful for the answer on screen.
 */
export function panelsToRefresh(open: OpenPanels): {
  chain: boolean;
  svids: boolean;
  tools: boolean;
} {
  return { chain: open.oboOpen, svids: open.svidsOpen, tools: open.toolsOpen };
}

export type SuggestionTier = 'read' | 'write';

export interface Suggestion {
  text: string;
  /** read → mcp-observability inline; write → specialist + MFA step-up. */
  tier: SuggestionTier;
}

// Example prompts, chosen to exercise every MCP tool the copilot can reach.
// Read tier (observe path → mcp-observability): list_pods, get_pod_logs,
// get_deployment. Write tier (privileged path → agent-specialist → mcp-ops):
// restart_deployment, scale_deployment, set_deployment_image.
export const SUGGESTIONS: readonly Suggestion[] = [
  { text: 'List all pods in the prod namespace', tier: 'read' },
  { text: 'Show recent logs for the checkout-service deployment in prod', tier: 'read' },
  { text: 'What image and replica count is order-service running in prod?', tier: 'read' },
  { text: 'Restart the order-service deployment in prod', tier: 'write' },
  { text: 'Scale checkout-service to 3 replicas in prod', tier: 'write' },
  { text: 'Update order-service to image busybox:1.36 and verify the rollout', tier: 'write' },
];

export interface SuggestionGroup {
  /** What the prompts in the group DO — the label the chips sit under. */
  label: 'Observe' | 'Act';
  tier: SuggestionTier;
  prompts: readonly Suggestion[];
}

/** The example prompts grouped by what they do, so no legend row is needed. */
export const SUGGESTION_GROUPS: readonly SuggestionGroup[] = [
  { label: 'Observe', tier: 'read', prompts: SUGGESTIONS.filter((s) => s.tier === 'read') },
  { label: 'Act', tier: 'write', prompts: SUGGESTIONS.filter((s) => s.tier === 'write') },
];

/** The prompt the box opens with — the first chip, verbatim, so they agree. */
export const DEFAULT_PROMPT = SUGGESTIONS[0]!.text;

export type AgentFailure =
  | { kind: 'step-up'; acrValues: string; scope: string }
  | { kind: 'denied'; reason: string }
  | { kind: 'failed'; message: string; detail: string };

/**
 * A non-2xx from /api/agent is one of three different things: an RFC 9470
 * step-up challenge (the demo's MFA beat), an authorization verdict with a
 * reason (the role-denial beat), or a real failure. The UI shows each
 * differently — a denial is not an error, it is the system working.
 */
export function classifyAgentFailure(status: number, body: unknown): AgentFailure {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : undefined;
  const kind = obj?.kind;
  if (status === 401 && kind === 'step-up') {
    return {
      kind: 'step-up',
      acrValues: String(obj!.acrValues ?? ''),
      scope: String(obj!.scope ?? ''),
    };
  }
  if (status === 403 && kind === 'access-denied') {
    return { kind: 'denied', reason: String(obj!.reason ?? 'access denied') };
  }
  const code = typeof obj?.error === 'string' ? obj.error : undefined;
  const raw = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    kind: 'failed',
    message: friendlyErrorMessage(status, code, 'an answer from the copilot'),
    detail: raw ? `HTTP ${status} · ${raw}` : `HTTP ${status}`,
  };
}
