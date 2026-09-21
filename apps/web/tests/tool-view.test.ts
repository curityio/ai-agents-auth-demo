/**
 * Pure rules for the tools card: a fixed, meaningful order per tier (reads as
 * list → describe → logs, writes least → most invasive) and the per-tier
 * verdict derived from the probe status.
 */
import { describe, it, expect } from 'vitest';
import { orderTools, tierVerdict } from '../src/lib/tool-view';

describe('orderTools', () => {
  it('orders read tools list → describe → logs regardless of server order', () => {
    const names = orderTools('observability', [
      { name: 'get_pod_logs' },
      { name: 'list_pods' },
      { name: 'get_deployment' },
    ]).map((t) => t.name);
    expect(names).toEqual(['list_pods', 'get_deployment', 'get_pod_logs']);
  });
  it('orders write tools least → most invasive', () => {
    const names = orderTools('ops', [
      { name: 'set_deployment_image' },
      { name: 'restart_deployment' },
      { name: 'scale_deployment' },
    ]).map((t) => t.name);
    expect(names).toEqual(['restart_deployment', 'scale_deployment', 'set_deployment_image']);
  });
  it('appends unknown tools after the known ones, alphabetically', () => {
    const names = orderTools('ops', [
      { name: 'zap' },
      { name: 'restart_deployment' },
      { name: 'alpha' },
    ]).map((t) => t.name);
    expect(names).toEqual(['restart_deployment', 'alpha', 'zap']);
  });
});

describe('tierVerdict', () => {
  it('reports what the gateway did for this token', () => {
    expect(tierVerdict({ status: 'ok', tools: [{ name: 'a' }, { name: 'b' }] })).toEqual({
      label: '2 tools listed for you',
      tone: 'ok',
    });
    expect(tierVerdict({ status: 'ok', tools: [] })).toEqual({
      label: 'nothing listed',
      tone: 'blocked',
    });
    expect(tierVerdict({ status: 'step-up', acrValues: 'mfa', scope: 'ops:write' })).toEqual({
      label: 'not listed · step-up required',
      tone: 'blocked',
    });
    expect(tierVerdict({ status: 'denied', error: 'invalid_scope', description: 'x' })).toEqual({
      label: 'not listed · denied',
      tone: 'denied',
    });
    expect(tierVerdict({ status: 'error', error: 'ECONNREFUSED', description: 'x' })).toEqual({
      label: 'could not probe',
      tone: 'unknown',
    });
  });
});
