'use client';

/**
 * The hero stage: the landscape topology with one packet walking the idle
 * loop (a read request, then a privileged one). Nothing here is live — the
 * panels below are the proof — but the player only knows how to play a
 * `Step[]`, so a real token chain can drive it later. The script's captions
 * are not shown: at this pace they flip too fast to read; the legend is enough.
 *
 * Motion is a CSS transform transition per leg; the player just schedules the
 * next leg. Hovering pauses, so a presenter can hold a frame or click a node.
 */
import { useEffect, useRef, useState } from 'react';
import {
  CURITY,
  EDGES,
  IDLE_LOOP,
  NODES,
  VIEW,
  edgeId,
  edgePoint,
  linkPathOf,
  nodeById,
  spiffeIdOf,
  type Point,
  type Step,
  type Tone,
  type TopoNode,
} from '@/lib/hero-journey';

const LILAC = 'hsl(263 100% 83%)';
const AMBER = 'hsl(32 90% 59%)';
const toneColor = (t: Tone) => (t === 'privileged' ? AMBER : LILAC);

type Pos = Point & { ms: number; ease: Step['ease'] };

function usePlayer(steps: Step[]) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [pos, setPos] = useState<Pos>({ x: steps[0].x, y: steps[0].y, ms: 0, ease: 'linear' });
  const last = useRef<Point>({ x: steps[0].x, y: steps[0].y });

  useEffect(() => {
    if (paused) return;
    const step = steps[i];
    const legs: Point[] = [...step.via, { x: step.x, y: step.y }];
    const lens = legs.map((p, k) => {
      const q = k === 0 ? last.current : legs[k - 1];
      return Math.hypot(p.x - q.x, p.y - q.y);
    });
    const total = lens.reduce((a, b) => a + b, 0) || 1;
    const timers: number[] = [];
    let at = 0;
    legs.forEach((p, k) => {
      const ms = Math.round((step.ms * lens[k]) / total);
      timers.push(
        window.setTimeout(() => {
          last.current = p;
          setPos({ ...p, ms, ease: step.ease });
        }, at),
      );
      at += ms;
    });
    timers.push(window.setTimeout(() => setI((i + 1) % steps.length), step.ms + step.hold));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [i, paused, steps]);

  return { step: steps[i], pos, setPaused };
}

const targetOf = (n: TopoNode) => (n.ns === 'apis' ? '#tools' : '#identities');
const tipOf = (n: TopoNode) =>
  n.exchanges ? spiffeIdOf(n) : `${n.id} · verifies what arrives, never exchanges`;

function Jump({
  href,
  enabled,
  children,
}: {
  href: string;
  enabled: boolean;
  children: React.ReactNode;
}) {
  return enabled ? (
    <a href={href} className="cursor-pointer [&:hover_rect]:stroke-white">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

export function HeroStage({ signedIn, footer }: { signedIn: boolean; footer?: React.ReactNode }) {
  const { step, pos, setPaused } = usePlayer(IDLE_LOOP);
  const lit = new Set<string>(step.lit);
  const edges = new Set(step.edges);
  const links = new Set<string>(step.links);
  const amber = new Set<string>(step.amber);

  return (
    <div
      data-hero-stage
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
    >
      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        className="w-full"
        role="img"
        aria-labelledby="hero-stage-title"
      >
        <title id="hero-stage-title">
          How a request travels: left to right from web through the agents and the gateway to the
          tool servers and APIs. Curity sits below the path; each workload drops down to it to
          exchange the token before its next hop.
        </title>
        <defs>
          <marker
            id="hero-arrow"
            viewBox="0 0 8 8"
            refX="7"
            refY="4"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0,0.8 L7.2,4 L0,7.2 z" fill="hsl(0 0% 100% / 0.4)" />
          </marker>
          <filter id="hero-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" />
          </filter>
        </defs>

        {/* control plane: the exchange side trips */}
        {NODES.filter((n) => n.exchanges).map((n) => {
          const on = links.has(n.id);
          return (
            <polyline
              key={n.id}
              data-link={n.id}
              fill="none"
              points={linkPathOf(n.id)
                .map((p) => `${p.x},${p.y}`)
                .join(' ')}
              stroke={on ? AMBER : 'hsl(0 0% 100% / 0.22)'}
              strokeWidth={on ? 1.4 : 1}
              strokeDasharray="3 4"
              style={{ transition: 'stroke .3s' }}
            />
          );
        })}

        {/* data plane: the request itself */}
        {EDGES.map(([a, b]) => {
          const id = edgeId(a, b);
          const p1 = edgePoint(nodeById(a), nodeById(b));
          const p2 = edgePoint(nodeById(b), nodeById(a));
          const on = edges.has(id);
          const color = amber.has(id) ? AMBER : LILAC;
          return (
            <line
              key={id}
              data-edge={id}
              x1={p1.x}
              y1={p1.y}
              x2={p2.x}
              y2={p2.y}
              stroke={on ? color : 'hsl(0 0% 100% / 0.28)'}
              strokeWidth={1.5}
              markerEnd="url(#hero-arrow)"
              style={{ transition: 'stroke .3s' }}
            />
          );
        })}

        {/* the authorization server: off the request path, at the bottom */}
        <Jump href="#chain" enabled={signedIn}>
          <g data-curity>
            <title>Curity Identity Server · every token in the chain is minted here</title>
            <rect
              x={CURITY.x}
              y={CURITY.y}
              width={CURITY.w}
              height={CURITY.h}
              rx={11}
              fill={step.glow ? 'hsl(263 100% 83% / 0.22)' : 'hsl(263 100% 83% / 0.10)'}
              stroke={LILAC}
              strokeWidth={step.glow ? 1.8 : 1.2}
              style={{ transition: 'fill .3s, stroke-width .3s' }}
            />
            <text
              x={CURITY.x + CURITY.w / 2}
              y={CURITY.y + 18}
              textAnchor="middle"
              fill="white"
              fontSize={12}
              fontWeight={700}
              letterSpacing="0.14em"
            >
              CURITY
            </text>
            <text
              x={CURITY.x + CURITY.w / 2}
              y={CURITY.y + 31}
              textAnchor="middle"
              fill={LILAC}
              fontSize={8}
              fontFamily="var(--font-mono), ui-monospace, monospace"
            >
              authorization server · sole token issuer · consulted at every hop
            </text>
          </g>
        </Jump>

        {NODES.map((n) => {
          const on = lit.has(n.id);
          const color = amber.has(n.id) ? AMBER : LILAC;
          return (
            <Jump key={n.id} href={targetOf(n)} enabled={signedIn}>
              <g data-node={n.id} data-lit={on || undefined}>
                <title>{tipOf(n)}</title>
                <rect
                  x={n.x - n.w / 2}
                  y={n.y - n.h / 2}
                  width={n.w}
                  height={n.h}
                  rx={8}
                  fill={on ? color.replace(')', ' / 0.18)') : 'hsl(0 0% 100% / 0.06)'}
                  stroke={on ? color : 'hsl(0 0% 100% / 0.25)'}
                  strokeWidth={on ? 1.3 : 1}
                  style={{ transition: 'fill .3s, stroke .3s' }}
                />
                <text
                  x={n.x}
                  y={n.y + 3.2}
                  textAnchor="middle"
                  fontSize={8.5}
                  fontFamily="var(--font-mono), ui-monospace, monospace"
                  fill={on ? 'white' : 'hsl(0 0% 100% / 0.65)'}
                  style={{ transition: 'fill .3s' }}
                >
                  {n.id}
                </text>
              </g>
            </Jump>
          );
        })}

        {/* the packet: one request, carrying whatever token it was last issued */}
        <g
          data-packet
          style={{
            transform: `translate(${pos.x}px, ${pos.y}px)`,
            transition: `transform ${pos.ms}ms ${pos.ease}, opacity .35s`,
            opacity: step.packet ? 1 : 0,
          }}
        >
          <circle r={9} fill={toneColor(step.tone)} opacity={0.45} filter="url(#hero-glow)" />
          <circle r={4.5} fill={toneColor(step.tone)} />
        </g>
      </svg>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        {footer}
        <p className="ml-auto flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-white/60">
          <span className="inline-flex items-center gap-2">
            <i className="inline-block h-0 w-6 border-t-[1.5px]" style={{ borderColor: LILAC }} />
            request, carrying the token it was issued
          </span>
          <span className="inline-flex items-center gap-2">
            <i
              className="inline-block h-0 w-6 border-t border-dashed"
              style={{ borderColor: AMBER }}
            />
            token exchange · RFC 8693
          </span>
        </p>
      </div>
    </div>
  );
}
