/**
 * The hero's topology and the step script its idle animation plays.
 *
 * Geometry is the landscape picture: the request runs left to right along the
 * middle row, the read tier sits top-right, the privileged tier bottom-right,
 * and Curity is a bar underneath — off the request path. Every workload that
 * exchanges "drops" straight down to the bar and back; mcp-observability is
 * routed around mcp-ops through the corridor between the rows.
 *
 * A journey is a list of stops. Each stop is where the packet is after the
 * step, how long it took to get there, and what the picture should show
 * meanwhile (which nodes/edges are lit, whether Curity glows, the caption a
 * presenter reads aloud). The player is dumb on purpose — the same script
 * shape can later be built from a real token chain instead of this idle one.
 */
export const VIEW = { w: 680, h: 346 } as const;
export const CURITY = { x: 18, y: 294, w: 644, h: 40 } as const;

const NW = 100;
const NH = 28;
// The band above the middle row (left of x=440) is where the hero copy sits.
const ROW = { top: 76, mid: 154, bottom: 232 } as const;
const CORRIDOR = (ROW.mid + ROW.bottom) / 2;

export type Tone = 'read' | 'privileged';
export type NodeId =
  | 'web'
  | 'agent-copilot'
  | 'agent-specialist'
  | 'agentgateway'
  | 'mcp-observability'
  | 'mcp-ops'
  | 'obs-api'
  | 'ops-api'
  | 'llm-provider';

export type TopoNode = {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  h: number;
  /** k8s namespace, for the SPIFFE ID tooltip. */
  ns: string;
  /** Workloads that exchange drop to Curity; the APIs only verify. */
  exchanges: boolean;
  /** Explicit route to Curity when a straight drop would cross another row. */
  route?: Point[];
  /** Display text when the id is not a workload name. */
  label?: string;
  /**
   * Outside the trust domain: no SPIFFE ID, never exchanges, drawn dashed. The
   * LLM provider only ever sees an `aud=llm-gateway` leaf token, and the vendor
   * API key exists solely at agentgateway — the point of the `/llm` route.
   */
  external?: boolean;
};
export type Point = { x: number; y: number };

const node = (
  id: NodeId,
  x: number,
  y: number,
  ns: string,
  exchanges: boolean,
  route?: Point[],
): TopoNode => ({ id, x, y, w: NW, h: NH, ns, exchanges, route });

export const NODES: TopoNode[] = [
  node('web', 56, ROW.mid, 'web', true),
  node('agent-copilot', 172, ROW.mid, 'agents', true),
  node('agentgateway', 388, ROW.mid, 'mcp', true),
  node('agent-specialist', 288, ROW.bottom, 'agents', true),
  node('mcp-observability', 504, ROW.top, 'mcp', true, [
    { x: 504, y: ROW.top + NH / 2 },
    { x: 504, y: CORRIDOR },
    { x: 424, y: CORRIDOR },
    { x: 424, y: CURITY.y },
  ]),
  node('obs-api', 622, ROW.top, 'apis', false),
  node('mcp-ops', 504, ROW.bottom, 'mcp', true),
  node('ops-api', 622, ROW.bottom, 'apis', false),
  // The model, on the middle row beside the two APIs: reached only through
  // agentgateway's /llm route. Its edge crosses mcp-observability's dashed drop
  // at a right angle — the one crossing on the stage, and a perpendicular one.
  {
    ...node('llm-provider', 622, ROW.mid, '', false),
    label: 'LLM provider',
    external: true,
  },
];

export const EDGES: [NodeId, NodeId][] = [
  ['web', 'agent-copilot'],
  ['agent-copilot', 'agentgateway'],
  ['agent-copilot', 'agent-specialist'],
  ['agent-specialist', 'agentgateway'],
  ['agentgateway', 'mcp-observability'],
  ['agentgateway', 'mcp-ops'],
  ['mcp-observability', 'obs-api'],
  ['mcp-ops', 'ops-api'],
  ['agentgateway', 'llm-provider'],
];

/**
 * The two right-hand rows ARE the two tiers, but nothing in the picture said so.
 * One faint label per row, centred over the mcp/api pair, stating the scope that
 * row requires. Derived from the row geometry so a layout change moves them.
 */
export const TIER_LABELS: readonly { tone: Tone; text: string; x: number; y: number }[] = [
  { tone: 'read', text: 'read tier · obs:read', x: (504 + 622) / 2, y: ROW.top - NH / 2 - 8 },
  {
    tone: 'privileged',
    text: 'write tier · ops:write · acr=mfa',
    x: (504 + 622) / 2,
    y: ROW.bottom + NH / 2 + 14,
  },
];

export const edgeId = (a: NodeId, b: NodeId) => `${a}|${b}`;

export function nodeById(id: string): TopoNode {
  const n = NODES.find((n) => n.id === id);
  if (!n) throw new Error(`unknown node ${id}`);
  return n;
}

export const spiffeIdOf = (n: TopoNode) => `spiffe://demo.curity.local/ns/${n.ns}/sa/${n.id}`;

/** Where the centre-to-centre line leaves a node's box (plus a hair of air). */
export function edgePoint(from: TopoNode, to: TopoNode): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const hx = from.w / 2 + 2;
  const hy = from.h / 2 + 2;
  const sx = dx === 0 ? Infinity : hx / Math.abs(dx);
  const sy = dy === 0 ? Infinity : hy / Math.abs(dy);
  const s = Math.min(sx, sy);
  return { x: from.x + dx * s, y: from.y + dy * s };
}

/** The polyline a workload's exchange travels down to Curity. */
export function linkPathOf(id: string): Point[] {
  const n = nodeById(id);
  if (n.route) return n.route;
  return [
    { x: n.x, y: n.y + n.h / 2 },
    { x: n.x, y: CURITY.y },
  ];
}

export type Step = {
  /** Which stop the packet is at once the step ends. */
  at: NodeId | 'curity';
  x: number;
  y: number;
  /** Travel time to get here (ms) and how long to linger afterwards. */
  ms: number;
  hold: number;
  /** Straight legs ease; a routed multi-leg drop moves at constant speed. */
  ease: 'ease-in-out' | 'linear';
  /** Multi-leg routes list the corners the packet passes on the way. */
  via: Point[];
  caption: string;
  lit: NodeId[];
  edges: string[];
  links: NodeId[];
  /**
   * Node, edge and link ids drawn amber. On the privileged journey this is
   * everything lit so far: alice's token carries ops:write + acr=mfa from the
   * step-up on, so the whole run is the write tier — the legend's rule, "amber =
   * privileged", has to hold on every leg, including the copilot's exchange and
   * the drop TO Curity, not just the return. On the read journey it is empty.
   */
  amber: string[];
  glow: boolean;
  tone: Tone;
  packet: boolean;
};

const pathLength = (pts: Point[]) =>
  pts.slice(1).reduce((a, p, i) => a + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0);

type Hop = {
  from: NodeId;
  to: NodeId;
  /** Exchange captions, when `from` re-mints before it moves on. */
  ask?: string;
  issued?: string;
  carry: string;
};

/** Builder that threads the cumulative picture state through the stops. */
class Script {
  steps: Step[] = [];
  private lit = new Set<NodeId>();
  private edges = new Set<string>();
  private links = new Set<NodeId>();

  constructor(private readonly tone: Tone) {}

  private push(p: Omit<Step, 'lit' | 'edges' | 'links' | 'amber' | 'tone'>) {
    const lit = [...this.lit];
    const edges = [...this.edges];
    const links = [...this.links];
    this.steps.push({
      ...p,
      lit,
      edges,
      links,
      // The tone is a property of the journey, not of a hop: colour everything
      // lit so far, so no leg of a privileged run is ever drawn lilac.
      amber: this.tone === 'privileged' ? [...lit, ...edges, ...links] : [],
      tone: this.tone,
    });
  }

  start(id: NodeId, caption: string, hold: number) {
    const n = nodeById(id);
    this.lit.add(id);
    this.push({
      at: id,
      x: n.x,
      y: n.y,
      ms: 1,
      hold,
      ease: 'ease-in-out',
      via: [],
      caption,
      glow: false,
      packet: true,
    });
  }

  /** Down to Curity and back, lighting the dashed link. */
  exchange(from: NodeId, ask: string, issued: string) {
    const pts = linkPathOf(from);
    const down = pts.slice(1);
    const up = [...pts].reverse().slice(1);
    const len = pathLength(pts);
    const ms = Math.round(Math.max(360, len * 3.2));
    const ease = pts.length > 2 ? 'linear' : 'ease-in-out';
    this.links.add(from);
    const end = down[down.length - 1];
    this.push({
      at: 'curity',
      x: end.x,
      y: end.y,
      ms,
      hold: 420,
      ease,
      via: down.slice(0, -1),
      caption: `${from} → Curity · ${ask}`,
      glow: true,
      packet: true,
    });
    const back = up[up.length - 1];
    this.push({
      at: from,
      x: back.x,
      y: back.y,
      ms: Math.round(ms * 0.85),
      hold: 260,
      ease,
      via: up.slice(0, -1),
      caption: `Curity → ${from} · ${issued}`,
      glow: false,
      packet: true,
    });
  }

  /** Along the solid edge to the next workload, which lights up on arrival. */
  travel(from: NodeId, to: NodeId, caption: string, hold = 300) {
    const a = nodeById(from);
    const b = nodeById(to);
    const ms = Math.round(Math.max(380, Math.hypot(b.x - a.x, b.y - a.y) * 2.4));
    this.edges.add(edgeId(from, to));
    this.lit.add(to);
    this.push({
      at: to,
      x: b.x,
      y: b.y,
      ms,
      hold,
      ease: 'ease-in-out',
      via: [],
      caption,
      glow: false,
      packet: true,
    });
  }

  /**
   * The governed model call, once per journey: `from` carries the `llm:invoke`
   * leaf through agentgateway's /llm route to the provider, and the completion
   * comes back the same way. The packet fades at the provider and reappears at
   * `from` rather than retracing two edges — the return leg carries no token
   * worth drawing. Pass `exchange` when the leaf still has to be minted; the
   * specialist mints it in the same trip as its ops:write token (see
   * buildJourney), because two identical back-to-back dips read as a stutter.
   */
  modelCall(from: NodeId, exchange?: { ask: string; issued: string }) {
    if (exchange) this.exchange(from, exchange.ask, exchange.issued);
    this.travel(
      from,
      'agentgateway',
      `${from} → agentgateway (/llm) · carrying the llm:invoke leaf token`,
      200,
    );
    this.travel(
      'agentgateway',
      'llm-provider',
      'agentgateway → LLM provider · the gateway injects the vendor key; the provider never sees a user token',
      520,
    );
    const here = nodeById('llm-provider');
    this.push({
      at: 'llm-provider',
      x: here.x,
      y: here.y,
      ms: 1,
      hold: 380,
      ease: 'linear',
      via: [],
      caption: 'the completion returns the same way',
      glow: false,
      packet: false,
    });
    const back = nodeById(from);
    this.push({
      at: from,
      x: back.x,
      y: back.y,
      ms: 1,
      hold: 160,
      ease: 'linear',
      via: [],
      caption: `${from} has the model's plan`,
      glow: false,
      packet: false,
    });
  }

  /** Linger at the last stop with a closing line, then let the packet fade. */
  finish(at: NodeId, caption: string) {
    const n = nodeById(at);
    this.push({
      at,
      x: n.x,
      y: n.y,
      ms: 300,
      hold: 1500,
      ease: 'ease-in-out',
      via: [],
      caption,
      glow: false,
      packet: false,
    });
  }

  run(hops: Hop[]) {
    for (const h of hops) {
      if (h.ask && h.issued) this.exchange(h.from, h.ask, h.issued);
      this.travel(h.from, h.to, h.carry);
    }
    return this;
  }
}

const USER_HOP: Hop = {
  from: 'web',
  to: 'agent-copilot',
  carry: 'web → agent-copilot · the request carries the user token',
};

const LLM_ASK = 'asks for aud=llm-gateway scope=llm:invoke';
const LLM_ISSUED = 'issued aud=llm-gateway scope=llm:invoke · no may_act: a leaf, nothing exchanges it onward';

const READ_HOPS: Hop[] = [
  {
    from: 'agent-copilot',
    to: 'agentgateway',
    ask: 'presents the user token + its SPIFFE SVID, asks for aud=mcp-gateway',
    issued: 'issued aud=mcp-gateway scope=obs:read · act: agent-copilot',
    carry: 'agent-copilot → agentgateway · carrying the token it was just issued',
  },
  {
    from: 'agentgateway',
    to: 'mcp-observability',
    ask: 'asks for aud=mcp-observability',
    issued: 'issued aud=mcp-observability scope=obs:read · act nests agentgateway',
    carry: 'agentgateway → mcp-observability · carrying the token it was just issued',
  },
  {
    from: 'mcp-observability',
    to: 'obs-api',
    ask: 'asks for aud=obs-api',
    issued: 'issued aud=obs-api scope=obs:read · act: 3 workloads deep',
    carry: 'mcp-observability → obs-api · carrying the token it was just issued',
  },
];

const A2A_HOP: Hop = {
  from: 'agent-copilot',
  to: 'agent-specialist',
  ask: 'asks for aud=agent-specialist',
  issued: 'issued aud=agent-specialist scope=ops:write obs:read · may_act: agent-specialist',
  carry: 'agent-copilot → agent-specialist · hands the goal over A2A with that token',
};

// The specialist's trip to Curity is its own beat: the role + acr gate fires
// HERE, before the model ever runs — so the model call is scripted after it. In
// the running system this is two exchanges (ops:write, then the llm:invoke
// leaf); the stage draws them as ONE dip with both in the caption, because two
// identical back-to-back dips looked like a stutter, not a second token.
const OPS_GATE = {
  ask: 'asks for aud=mcp-gateway scope=ops:write · role sre + acr=mfa required (RFC 9470) · then the aud=llm-gateway leaf',
  issued:
    'issued aud=mcp-gateway scope=ops:write acr=mfa · act: agent-specialist, agent-copilot — and aud=llm-gateway scope=llm:invoke, no may_act: a leaf',
  carry: 'agent-specialist → agentgateway · carrying the privileged token',
};

const PRIVILEGED_HOPS: Hop[] = [
  {
    from: 'agentgateway',
    to: 'mcp-ops',
    ask: 'asks for aud=mcp-ops',
    issued: 'issued aud=mcp-ops scope=ops:write acr=mfa · act nests agentgateway',
    carry: 'agentgateway → mcp-ops · carrying the token it was just issued',
  },
  {
    from: 'mcp-ops',
    to: 'ops-api',
    ask: 'asks for aud=ops-api',
    issued: 'issued aud=ops-api scope=ops:write acr=mfa · act: 4 workloads deep',
    carry: 'mcp-ops → ops-api · carrying the token it was just issued',
  },
];

export function buildJourney(kind: Tone): Step[] {
  const s = new Script(kind);
  if (kind === 'read') {
    s.start(
      'web',
      'alice signs in at Curity · web holds her user token (scope obs:read ops:write)',
      900,
    );
    s.run([USER_HOP]);
    // The copilot asks the model which tool to call before it calls one.
    s.modelCall('agent-copilot', { ask: LLM_ASK, issued: LLM_ISSUED });
    s.run(READ_HOPS);
    s.finish(
      'obs-api',
      'obs-api never exchanges · it verifies the act chain and reads the cluster',
    );
  } else {
    s.start(
      'web',
      'alice steps up with TOTP at Curity · a stronger factor before anything privileged',
      900,
    );
    s.run([USER_HOP, A2A_HOP]);
    // Gate first, model second: the specialist holds a privileged token before
    // the LLM plans anything, and only then carries it to the gateway.
    s.exchange('agent-specialist', OPS_GATE.ask, OPS_GATE.issued);
    s.modelCall('agent-specialist');
    s.travel('agent-specialist', 'agentgateway', OPS_GATE.carry);
    s.run(PRIVILEGED_HOPS);
    s.finish('ops-api', 'ops-api verifies the act chain + acr=mfa · then restarts the deployment');
  }
  return s.steps;
}

/** What the hero plays when nothing else is going on: read, then privileged. */
export const IDLE_LOOP: Step[] = [...buildJourney('read'), ...buildJourney('privileged')];
