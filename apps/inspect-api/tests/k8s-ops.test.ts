import { describe, expect, it } from 'vitest';
import { toPodSummary, toDeploymentSummary } from '../src/k8s-ops.js';
import type { V1Pod } from '@kubernetes/client-node';

describe('toPodSummary', () => {
  it('maps a running pod with restart counts and image', () => {
    const startedMs = Date.now() - 60_000;
    const pod = {
      metadata: { name: 'api-gateway-abc', namespace: 'prod' },
      spec: { containers: [{ image: 'api-gateway:1.4.2' }] },
      status: {
        phase: 'Running',
        startTime: new Date(startedMs).toISOString(),
        containerStatuses: [{ restartCount: 3 }, { restartCount: 1 }],
      },
    } as unknown as V1Pod;

    const s = toPodSummary(pod);
    expect(s.name).toBe('api-gateway-abc');
    expect(s.namespace).toBe('prod');
    expect(s.status).toBe('Running');
    expect(s.restarts).toBe(4);
    expect(s.image).toBe('api-gateway:1.4.2');
    expect(s.ageSeconds).toBeGreaterThanOrEqual(59);
    expect(s.ageSeconds).toBeLessThan(120);
  });

  it('tolerates missing fields', () => {
    const s = toPodSummary({} as V1Pod);
    expect(s.name).toBe('');
    expect(s.status).toBe('Unknown');
    expect(s.restarts).toBe(0);
    expect(s.image).toBe('');
    expect(s.ageSeconds).toBe(0);
  });
});

describe('toDeploymentSummary', () => {
  it('extracts image, replicas, ready/updated counts', () => {
    const summary = toDeploymentSummary({
      metadata: { name: 'api-gateway', namespace: 'prod', generation: 7 },
      spec: { replicas: 3, template: { spec: { containers: [{ name: 'api-gateway', image: 'demo/api:v1.4' }] } } },
      status: { readyReplicas: 2, updatedReplicas: 3, availableReplicas: 2, observedGeneration: 7 },
    } as never);
    expect(summary).toEqual({
      name: 'api-gateway',
      namespace: 'prod',
      image: 'demo/api:v1.4',
      replicas: 3,
      readyReplicas: 2,
      updatedReplicas: 3,
      generation: 7,
      observedGeneration: 7,
    });
  });
});
