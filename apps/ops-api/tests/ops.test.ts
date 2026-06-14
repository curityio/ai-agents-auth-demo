import { describe, it, expect } from 'vitest';
import { buildSetImageBody, buildScaleBody } from '../src/ops.js';

describe('ops patch bodies', () => {
  it('builds a container-image strategic-merge patch', () => {
    const body = buildSetImageBody('api-gateway', 'ghcr.io/demo/api-gateway:v1.2');
    expect(body).toEqual({
      spec: {
        template: {
          spec: {
            containers: [{ name: 'api-gateway', image: 'ghcr.io/demo/api-gateway:v1.2' }],
          },
        },
      },
    });
  });

  it('builds a replicas patch', () => {
    expect(buildScaleBody(3)).toEqual({ spec: { replicas: 3 } });
  });
});
