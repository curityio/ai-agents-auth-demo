import { describe, it, expect } from 'vitest';
import { asSchema } from 'ai';
import { mcpInputSchema, toListedTool, requiredRolesOf } from './mcp-toolset.js';

/**
 * The JSON Schema mcp-ops actually advertises for `scale_deployment`, copied
 * verbatim from `z.toJSONSchema()` over that tool's zod 4 `inputSchema` — including
 * `$schema` and `additionalProperties`, which also now reach the model.
 *
 * Safe to send unconstrained: `@ai-sdk/openai-compatible` only sets `strict` on a
 * tool when the tool itself asks for it (its `strictJsonSchema: true` default
 * applies to `response_format`, which we never use). So these go out as non-strict
 * function definitions, where keywords like `minimum` that OpenAI's strict mode
 * rejects are simply advisory to the model.
 */
const SCALE_DEPLOYMENT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1, description: 'Deployment name' },
    replicas: {
      type: 'integer',
      minimum: 0,
      maximum: 20,
      description: 'Desired replica count (0–20)',
    },
    namespace: {
      description: "Namespace. Defaults to 'prod'.",
      'x-mcp-header': 'Namespace',
      type: 'string',
    },
    reason: { description: 'Human-readable reason.', type: 'string', maxLength: 512 },
  },
  required: ['name', 'replicas'],
  additionalProperties: false,
};

describe('mcpInputSchema', () => {
  // The old jsonSchemaToZod hand-converted "object of primitives" only, so an
  // integer with bounds became a bare z.number(): the model was never told that
  // replicas must be 0–20, and learned it from a server-side rejection instead.
  it('preserves numeric bounds and the integer type that the zod conversion dropped', async () => {
    const converted = await asSchema(mcpInputSchema(SCALE_DEPLOYMENT_SCHEMA)).jsonSchema;
    const replicas = (converted as { properties: Record<string, Record<string, unknown>> })
      .properties.replicas;
    expect(replicas.type).toBe('integer');
    expect(replicas.minimum).toBe(0);
    expect(replicas.maximum).toBe(20);
  });

  it('preserves string length constraints', async () => {
    const converted = (await asSchema(mcpInputSchema(SCALE_DEPLOYMENT_SCHEMA))
      .jsonSchema) as { properties: Record<string, Record<string, unknown>> };
    expect(converted.properties.name.minLength).toBe(1);
    expect(converted.properties.reason.maxLength).toBe(512);
  });

  it('carries the whole contract through verbatim, including required and x-mcp-header', async () => {
    // Passing the server's document through unchanged is the point: anything this
    // code reshapes is a second, drifting definition of the same tool.
    const converted = await asSchema(mcpInputSchema(SCALE_DEPLOYMENT_SCHEMA)).jsonSchema;
    expect(converted).toEqual(SCALE_DEPLOYMENT_SCHEMA);
  });

  it('preserves enums, arrays and nested objects', async () => {
    // None of these survived the old converter — each collapsed to z.unknown().
    const rich = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['rolling', 'recreate'] },
        labels: { type: 'array', items: { type: 'string' } },
        target: {
          type: 'object',
          properties: { kind: { type: 'string' }, name: { type: 'string' } },
          required: ['kind'],
        },
      },
      required: ['mode'],
    };
    const converted = await asSchema(mcpInputSchema(rich)).jsonSchema;
    expect(converted).toEqual(rich);
  });

  it('falls back to an empty object schema for a non-object or missing schema', async () => {
    // MCP allows a tool with no inputs; the AI SDK still needs an object schema.
    for (const input of [undefined, null, 'nonsense', { type: 'string' }, { type: 'object' }]) {
      const converted = await asSchema(mcpInputSchema(input)).jsonSchema;
      expect(converted).toEqual({ type: 'object', properties: {} });
    }
  });
});

describe('toListedTool / requiredRolesOf', () => {
  // `openMcpToolset` exposes the raw tools/list entries as `listed` next to the
  // AI-SDK `tools`, because the AI SDK's tool object has nowhere to carry the
  // server's `_meta` — and that is where mcp-ops publishes per-tool required roles.
  it('keeps name, description and _meta from the server entry', () => {
    const t = toListedTool({
      name: 'set_deployment_image',
      description: 'Set image',
      inputSchema: { type: 'object', properties: {} },
      _meta: { 'io.curity.demo/required-roles': ['sre'] },
    });
    expect(t).toEqual({
      name: 'set_deployment_image',
      description: 'Set image',
      meta: { 'io.curity.demo/required-roles': ['sre'] },
    });
  });

  it('omits description and meta when the server sent none', () => {
    expect(toListedTool({ name: 'list_pods', inputSchema: { type: 'object' } })).toEqual({ name: 'list_pods' });
  });

  it('reads the required-roles meta as a string list, and undefined when absent or malformed', () => {
    expect(requiredRolesOf({ name: 'x', meta: { 'io.curity.demo/required-roles': ['sre', 'oncall'] } })).toEqual(['sre', 'oncall']);
    expect(requiredRolesOf({ name: 'x' })).toBeUndefined();
    expect(requiredRolesOf({ name: 'x', meta: { 'io.curity.demo/required-roles': 'sre' } })).toBeUndefined();
  });
});
