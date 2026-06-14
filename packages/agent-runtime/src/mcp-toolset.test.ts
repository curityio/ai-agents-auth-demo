import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod } from './mcp-toolset.js';

describe('jsonSchemaToZod', () => {
  it('maps an object of primitives with required/optional', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'deployment name' },
        replicas: { type: 'integer' },
        force: { type: 'boolean' },
      },
      required: ['name'],
    };
    const zod = jsonSchemaToZod(schema);
    expect(zod.safeParse({ name: 'api-gateway' }).success).toBe(true);
    expect(zod.safeParse({ replicas: 3 }).success).toBe(false); // name missing
    expect(zod.safeParse({ name: 'x', replicas: 'two' }).success).toBe(false);
  });

  it('returns an empty object schema for non-object input', () => {
    expect(jsonSchemaToZod(undefined).safeParse({}).success).toBe(true);
  });
});
