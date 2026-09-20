/**
 * Pure rules for the chat surface, kept out of the component so they can be
 * pinned by tests.
 */

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
