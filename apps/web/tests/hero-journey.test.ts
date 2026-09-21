/**
 * The hero's idle animation is a step script, not a hand-timed keyframe:
 * `buildJourney` turns the topology into the ordered stops one request makes
 * (workload → Curity → workload → next workload …), so the same engine can
 * later replay a real token chain. These tests pin the shape of that script.
 */
import { describe, it, expect } from 'vitest';
import {
  NODES,
  CURITY,
  buildJourney,
  nodeById,
  linkPathOf,
  IDLE_LOOP,
} from '../src/lib/hero-journey';

const box = (id: string) => {
  const n = nodeById(id);
  return {
    left: n.x - n.w / 2,
    right: n.x + n.w / 2,
    top: n.y - n.h / 2,
    bottom: n.y + n.h / 2,
  };
};

describe('topology', () => {
  it('routes the mcp-observability exchange around mcp-ops, not through it', () => {
    const ops = box('mcp-ops');
    const pts = linkPathOf('mcp-observability');
    expect(pts.length).toBeGreaterThan(2);
    for (const p of pts) {
      const inside = p.x > ops.left && p.x < ops.right && p.y > ops.top && p.y < ops.bottom;
      expect(inside, `${p.x},${p.y} crosses mcp-ops`).toBe(false);
    }
    expect(pts[pts.length - 1].y).toBe(CURITY.y);
  });
  it('keeps the top-left quadrant free for the hero copy', () => {
    // pill + two-line headline + two-line lede ≈ 155px ≈ 118 units at the lg width
    for (const n of NODES) {
      const b = box(n.id);
      const inBand = b.left < 440 && b.top < 128;
      expect(inBand, `${n.id} sits under the hero copy`).toBe(false);
    }
  });
});

describe('buildJourney', () => {
  const read = buildJourney('read');
  const priv = buildJourney('privileged');
  const visited = (steps: ReturnType<typeof buildJourney>) =>
    steps
      .map((s) => s.at)
      .filter((a) => a !== 'curity')
      .filter((a, i, all) => all[i - 1] !== a);

  it('read: walks the read tier only, in chain order', () => {
    expect(visited(read)).toEqual([
      'web',
      'agent-copilot',
      'agentgateway',
      'mcp-observability',
      'obs-api',
    ]);
    expect(read.some((s) => s.lit.includes('agent-specialist'))).toBe(false);
  });
  it('privileged: goes through the specialist to mcp-ops and ops-api', () => {
    expect(visited(priv)).toEqual([
      'web',
      'agent-copilot',
      'agent-specialist',
      'agentgateway',
      'mcp-ops',
      'ops-api',
    ]);
  });
  it('every workload that exchanges makes a round trip to Curity before moving on', () => {
    for (const steps of [read, priv]) {
      for (const from of ['agent-copilot', 'agentgateway']) {
        const i = steps.findIndex((s) => s.at === from);
        expect(steps[i + 1].at).toBe('curity');
        expect(steps[i + 2].at).toBe(from);
        expect(steps[i + 1].caption).toMatch(new RegExp(`^${from} → Curity`));
        expect(steps[i + 2].caption).toMatch(new RegExp(`^Curity → ${from}`));
      }
    }
    // the APIs never exchange: the packet stops there
    expect(read[read.length - 1].at).toBe('obs-api');
    expect(priv[priv.length - 1].at).toBe('ops-api');
  });
  it('the privileged journey carries the MFA gate and amber tone from the specialist on', () => {
    const gate = priv.find((s) => s.caption.includes('acr=mfa'));
    expect(gate?.at).toBe('curity');
    const after = priv.slice(priv.indexOf(gate!) + 1);
    expect(after.every((s) => s.tone === 'privileged')).toBe(true);
    expect(read.every((s) => s.tone === 'read')).toBe(true);
  });
  it('lights nodes cumulatively and glows Curity only while the packet is there', () => {
    for (const steps of [read, priv]) {
      for (let i = 1; i < steps.length; i++) {
        for (const id of steps[i - 1].lit) expect(steps[i].lit).toContain(id);
        expect(steps[i].glow).toBe(steps[i].at === 'curity');
      }
      for (const s of steps) {
        expect(s.caption.length).toBeGreaterThan(0);
        expect(s.ms).toBeGreaterThan(0);
        expect(s.x).toBeTypeOf('number');
        expect(s.y).toBeTypeOf('number');
      }
    }
  });
  it('IDLE_LOOP plays read then privileged and fits in about twenty seconds', () => {
    expect(IDLE_LOOP[0].at).toBe('web');
    const total = IDLE_LOOP.reduce((a, s) => a + s.ms + s.hold, 0);
    expect(total).toBeGreaterThan(12_000);
    expect(total).toBeLessThan(26_000);
    // one arrival each; the closing linger repeats the stop with the packet gone
    expect(IDLE_LOOP.filter((s) => s.at === 'ops-api' && s.packet).length).toBe(1);
    expect(IDLE_LOOP.filter((s) => s.at === 'obs-api' && s.packet).length).toBe(1);
  });
});
