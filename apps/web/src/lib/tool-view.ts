/**
 * Pure rules for the tools card. No React, no fetch.
 */

export type ToolTier = 'observability' | 'ops';

/** Fixed, meaningful order per tier: reads as list → describe → logs; writes
 *  least → most invasive. Anything the server adds later trails alphabetically. */
const TOOL_ORDER: Record<ToolTier, string[]> = {
  observability: ['list_pods', 'get_deployment', 'get_pod_logs'],
  ops: ['restart_deployment', 'scale_deployment', 'set_deployment_image'],
};

/** Which tier a tool call went to. Unknown names are read as observability —
 *  the safe default, since it never claims a call was privileged. */
export function toolTier(name: string): ToolTier {
  return TOOL_ORDER.ops.includes(name) ? 'ops' : 'observability';
}

export function orderTools<T extends { name: string }>(tier: ToolTier, tools: T[]): T[] {
  const known = TOOL_ORDER[tier];
  const rank = (n: string) => {
    const i = known.indexOf(n);
    return i === -1 ? known.length : i;
  };
  return [...tools].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export type TierProbe =
  | { status: 'ok'; tools: Array<{ name: string }> }
  | { status: 'step-up'; acrValues: string; scope: string }
  | { status: 'denied'; error: string; description: string }
  | { status: 'error'; error: string; description: string };

export interface TierVerdict {
  label: string;
  tone: 'ok' | 'blocked' | 'denied' | 'unknown';
}

/** What the gateway did for THIS token on a tier — the verdict, as opposed to
 *  the tier's requirement, which is the same for everyone. */
export function tierVerdict(t: TierProbe): TierVerdict {
  switch (t.status) {
    case 'ok':
      return t.tools.length === 0
        ? { label: 'nothing listed', tone: 'blocked' }
        : {
            label: `${t.tools.length} tool${t.tools.length === 1 ? '' : 's'} listed for you`,
            tone: 'ok',
          };
    case 'step-up':
      return { label: 'not listed · step-up required', tone: 'blocked' };
    case 'denied':
      return { label: 'not listed · denied', tone: 'denied' };
    case 'error':
      return { label: 'could not probe', tone: 'unknown' };
  }
}
