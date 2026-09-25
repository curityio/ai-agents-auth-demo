'use client';

/**
 * The hero stage: the landscape topology with one packet walking the idle
 * loop (a read request, then a privileged one). Nothing here is live — the
 * panels below are the proof — but the player only knows how to play a
 * `Step[]`, so a real token chain can drive it later. The script's captions
 * are not shown: at this pace they flip too fast to read; the legend is enough.
 *
 * Motion is a CSS transform transition per leg; the player just schedules the
 * next leg. Only the button beside the legend pauses it — hovering does not,
 * so pointing at the picture while presenting never freezes it.
 */
import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import {
  CURITY,
  EDGES,
  IDLE_LOOP,
  NODES,
  TIER_LABELS,
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

/**
 * The Curity bar is a stacked lockup: the mark and the wordmark on one centred
 * row, the subtitle centred beneath. The row is centred by estimate — the
 * wordmark's width depends on the font — but the gap between mark and word is
 * exact, which is what the eye checks. The mark is the glyph from
 * `public/curity-logo-landscape-white.svg` with its wordmark stripped (the bar
 * sets "CURITY" itself), inlined because an `<image>` cannot crop an external SVG.
 */
const MARK = { w: 56, h: 36.33 } as const;
const LOCKUP = { markH: 15, gap: 8, wordW: 60, baseline: 18, capH: 8.6 } as const;
const LOCKUP_MARK_W = (LOCKUP.markH * MARK.w) / MARK.h;
const LOCKUP_X = CURITY.x + (CURITY.w - (LOCKUP_MARK_W + LOCKUP.gap + LOCKUP.wordW)) / 2;
const LOCKUP_WORD_X = LOCKUP_X + LOCKUP_MARK_W + LOCKUP.gap;
// Centre the mark on the wordmark's cap height, not on the bar.
const LOCKUP_MARK_Y = CURITY.y + LOCKUP.baseline - LOCKUP.capH / 2 - LOCKUP.markH / 2;

function CurityMark({ x, y, height }: { x: number; y: number; height: number }) {
  return (
    <svg
      data-curity-mark
      aria-hidden="true"
      x={x}
      y={y}
      width={(height * MARK.w) / MARK.h}
      height={height}
      viewBox={`0 0 ${MARK.w} ${MARK.h}`}
    >
      <path
        fill="white"
        transform="translate(-3.16 -3.75)"
        d="m53.06 26.79-.56.57a15.93 15.93 0 0 1-10.93 5 10 10 0 0 1-10.34-10.4c0-6 4.24-10.39 10.09-10.39a16.67 16.67 0 0 1 10.22 4l.56.49 5.61-5.86-.63-.54a25.78 25.78 0 0 0-16.36-5.91 18.44 18.44 0 0 0-15.37 7.68H15l-.6 5.09h8.5a17.9 17.9 0 0 0-.59 2.86H9.61L9 24.46h13.31a18.56 18.56 0 0 0 .57 2.86H3.77l-.61 5.09H25.3c3.29 4.74 8.9 7.68 15.67 7.68a25.41 25.41 0 0 0 17.19-6.93l.59-.56Z"
      />
      <path fill="white" d="M5.01 15.62H1.26l-.6 5.09H4.4l.61-5.09z" />
    </svg>
  );
}

type Pos = Point & { ms: number; ease: Step['ease'] };

function usePlayer(steps: Step[], paused: boolean) {
  const [i, setI] = useState(0);
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

  return { step: steps[i], pos };
}

const targetOf = (n: TopoNode) =>
  n.external ? '#chain' : n.ns === 'apis' ? '#tools' : '#identities';
const tipOf = (n: TopoNode) =>
  n.external
    ? `${n.label ?? n.id} · outside the trust domain: reached only through agentgateway's /llm route with an aud=llm-gateway leaf token. The vendor API key exists solely at the gateway.`
    : n.exchanges
      ? spiffeIdOf(n)
      : `${n.id} · verifies what arrives, never exchanges`;

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

export function HeroStage({
  signedIn,
  footer,
  initiallyPaused = false,
}: {
  signedIn: boolean;
  footer?: React.ReactNode;
  /** Start stopped — tests use it; the button toggles it at runtime. */
  initiallyPaused?: boolean;
}) {
  const [stopped, setStopped] = useState(initiallyPaused);
  // Honour prefers-reduced-motion by starting stopped. Decided after mount, not
  // in the initialiser: the server cannot know the preference, and a mismatch
  // would flip the button between server and client markup. The button still
  // plays it on request.
  useEffect(() => {
    if (typeof window === 'undefined' || !('matchMedia' in window)) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setStopped(true);
  }, []);
  const { step, pos } = usePlayer(IDLE_LOOP, stopped);
  const lit = new Set<string>(step.lit);
  const edges = new Set(step.edges);
  const links = new Set<string>(step.links);
  const amber = new Set<string>(step.amber);

  return (
    <div data-hero-stage {...(stopped ? { 'data-paused': true } : {})}>
      <svg
        viewBox={`0 0 ${VIEW.w} ${VIEW.h}`}
        className="w-full"
        role="img"
        aria-labelledby="hero-stage-title"
      >
        <title id="hero-stage-title">
          How a request travels: left to right from web through the agents and the gateway to the
          tool servers and APIs, with a side trip through the gateway to the LLM provider, which
          sits outside the trust domain. Curity sits below the path; each workload drops down to it
          to exchange the token before its next hop.
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

        {/* control plane: the exchange side trips. An exchange belongs to the
            request that triggered it, so a lit link takes that request's tier
            colour (lilac read, amber privileged) — the dash pattern alone says
            "exchange". Amber must not mean two things on one stage. */}
        {NODES.filter((n) => n.exchanges).map((n) => {
          const on = links.has(n.id);
          const color = amber.has(n.id) ? AMBER : LILAC;
          return (
            <polyline
              key={n.id}
              data-link={n.id}
              fill="none"
              points={linkPathOf(n.id)
                .map((p) => `${p.x},${p.y}`)
                .join(' ')}
              stroke={on ? color : 'hsl(0 0% 100% / 0.22)'}
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

        {/* the two tiers, named: the rows carry the scope split */}
        {TIER_LABELS.map((l) => (
          <text
            key={l.tone}
            data-tier-label={l.tone}
            x={l.x}
            y={l.y}
            textAnchor="middle"
            fontSize={7.5}
            letterSpacing="0.04em"
            fontFamily="var(--font-mono), ui-monospace, monospace"
            fill={l.tone === 'privileged' ? 'hsl(32 90% 59% / 0.75)' : 'hsl(263 100% 83% / 0.7)'}
          >
            {l.text}
          </text>
        ))}

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
            <CurityMark x={LOCKUP_X} y={LOCKUP_MARK_Y} height={LOCKUP.markH} />
            <text
              x={LOCKUP_WORD_X}
              y={CURITY.y + LOCKUP.baseline}
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
                  {...(n.external ? { strokeDasharray: '4 3' } : {})}
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
                  {n.label ?? n.id}
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

      {/* Two rows on purpose: the capability chips, then the legend with the
          pause button. Five chips no longer share a row with the legend, and a
          wrap-dependent layout left one chip stranded under the others. */}
      <div className="mt-4 flex flex-col gap-3">
        {footer}
        <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-2">
          <p className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-white/60">
            {/* The packet's colour is the tier — the legend has to say so. */}
            <span className="inline-flex items-center gap-2">
              <i
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: LILAC }}
              />
              read · inspect:read
            </span>
            <span className="inline-flex items-center gap-2">
              <i
                className="inline-block h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: AMBER }}
              />
              privileged · ops:write, acr=mfa
            </span>
            <span className="inline-flex items-center gap-2">
              <i className="inline-block h-0 w-6 border-t-[1.5px]" style={{ borderColor: LILAC }} />
              request, carrying the token it was issued
            </span>
            <span className="inline-flex items-center gap-2">
              {/* Neutral on purpose: the exchange takes the tier colour of its request. */}
              <i
                data-legend-exchange
                className="inline-block h-0 w-6 border-t border-dashed border-white/60"
              />
              token exchange · RFC 8693
            </span>
          </p>
          <button
            type="button"
            data-hero-toggle
            aria-label={stopped ? 'Play animation' : 'Pause animation'}
            aria-pressed={stopped}
            title={stopped ? 'Play the animation' : 'Pause the animation'}
            onClick={() => setStopped((v) => !v)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/25 bg-white/10 text-white/80 backdrop-blur transition-colors hover:bg-white/20 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            {stopped ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    </div>
  );
}
