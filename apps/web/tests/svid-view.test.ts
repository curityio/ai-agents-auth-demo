/**
 * View model for the Workload identities panel: the pure rules that turn the
 * `/api/spiffe-identities` payload into what the cards show — namespace from
 * the SPIFFE ID, facts shared by every SVID hoisted out of the cards, live
 * lifetime, and which SVIDs rotated between two refreshes.
 */
import { describe, it, expect } from 'vitest';
import {
  lifetime,
  rotatedWorkloads,
  sharedFacts,
  svidNamespace,
  type SvidView,
} from '../src/lib/svid-view';

const ISS = 'https://oidc-discovery.demo.curity.local';
const AUD = 'https://curity.localtest.me/oauth/v2/oauth-token';
const svid = (
  workload: string,
  ns: string,
  iat: number,
  extra: Partial<SvidView> = {},
): SvidView => ({
  workload,
  sub: `spiffe://demo.curity.local/ns/${ns}/sa/${workload}`,
  aud: [AUD],
  iss: ISS,
  iat,
  exp: iat + 300,
  ttl_seconds: 300,
  ...extra,
});

describe('svidNamespace', () => {
  it('reads the namespace out of a SPIFFE ID', () => {
    expect(svidNamespace('spiffe://demo.curity.local/ns/mcp/sa/agentgateway')).toBe('mcp');
  });
  it('is undefined for anything else', () => {
    expect(svidNamespace(undefined)).toBeUndefined();
    expect(svidNamespace('alice')).toBeUndefined();
  });
});

describe('sharedFacts', () => {
  it('hoists iss and aud when every SVID agrees', () => {
    expect(sharedFacts([svid('web', 'web', 1), svid('agent-copilot', 'agents', 2)])).toEqual({
      iss: ISS,
      aud: [AUD],
    });
  });
  it('ignores cards that errored', () => {
    expect(sharedFacts([svid('web', 'web', 1), { workload: 'mcp-ops', error: '503' }])).toEqual({
      iss: ISS,
      aud: [AUD],
    });
  });
  it('hoists nothing when they disagree, so the cards show their own', () => {
    expect(
      sharedFacts([svid('web', 'web', 1), svid('x', 'x', 1, { iss: 'https://other' })]),
    ).toBeUndefined();
  });
  it('is undefined with no usable SVID', () => {
    expect(sharedFacts([{ workload: 'web', error: 'x' }])).toBeUndefined();
  });
});

describe('lifetime', () => {
  it('reports remaining seconds and the fraction of the lifetime left', () => {
    expect(lifetime({ iat: 1000, exp: 1300 }, 1100 * 1000)).toEqual({
      remaining: 200,
      total: 300,
      fraction: 200 / 300,
      level: 'ok',
    });
  });
  it('goes low under a minute and expired at zero', () => {
    expect(lifetime({ iat: 1000, exp: 1300 }, 1250 * 1000)?.level).toBe('low');
    expect(lifetime({ iat: 1000, exp: 1300 }, 1301 * 1000)).toMatchObject({
      remaining: 0,
      fraction: 0,
      level: 'expired',
    });
  });
  it('is undefined without an exp', () => {
    expect(lifetime({ iat: 1 }, 0)).toBeUndefined();
  });
});

describe('rotatedWorkloads', () => {
  it('names the workloads whose SVID was issued after the previous view', () => {
    const before = [svid('web', 'web', 100), svid('agent-copilot', 'agents', 100)];
    const after = [svid('web', 'web', 100), svid('agent-copilot', 'agents', 160)];
    expect(rotatedWorkloads(before, after)).toEqual(new Set(['agent-copilot']));
  });
  it('is empty on the first load or when nothing changed', () => {
    const now = [svid('web', 'web', 100)];
    expect(rotatedWorkloads(null, now)).toEqual(new Set());
    expect(rotatedWorkloads(now, now)).toEqual(new Set());
  });
});
