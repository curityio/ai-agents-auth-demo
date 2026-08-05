import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';

export interface McpToolset {
  /** AI-SDK-shaped tools, one per discovered MCP tool. */
  tools: ToolSet;
  /** Close the underlying transport once a chat turn finishes. */
  close: () => Promise<void>;
}

/**
 * Connect to an MCP Streamable HTTP server using the caller's bearer token,
 * discover its tools, and expose them as AI-SDK tools.
 *
 * `clientName` names the MCP client + the oboLog `service`. `label` is used in
 * the call log headline (e.g. the target server name). `fetchImpl` lets a
 * caller intercept the raw HTTP response — used by agent-specialist to turn an
 * RFC 9470 401 into a typed StepUpRequiredError before the SDK discards headers.
 */
export async function openMcpToolset(opts: {
  url: string;
  bearerToken: string;
  clientName: string;
  label: string;
  fetchImpl?: typeof fetch;
}): Promise<McpToolset> {
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    requestInit: {
      headers: { authorization: `Bearer ${opts.bearerToken}` },
    },
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });
  const tok = summarizeJwt(opts.bearerToken);
  const client = new Client(
    { name: opts.clientName, version: '0.0.1' },
    {
      // Pinned, NOT `auto`. `auto` would fall back to the 2025 handshake if any
      // hop stopped offering 2026-07-28 — and that fallback is silent: the demo
      // would keep working one revision older, without `Mcp-Name`, which is the
      // header the gateway's per-tool authz rules key on. Pinning turns that
      // degradation into a loud connect failure instead of a quiet authz gap.
      versionNegotiation: { mode: { pin: '2026-07-28' } },
      // Response caching (SEP-2549) is keyed by [serverIdentity, cachePartition].
      // Our `tools/list` is identity-dependent — agentgateway filters it by the
      // caller's tier scope — so partition by subject. Today nothing is actually
      // served from cache (no server sends `ttlMs`, and `tools/call` is never
      // cacheable), but this keeps the boundary right if that ever changes.
      cachePartition: tok.sub ?? '',
    },
  );
  await client.connect(transport);

  oboLog({
    service: opts.clientName,
    kind: 'CALL',
    headline: `→ MCP ${opts.label}`,
    fields: {
      url: opts.url,
      'token aud': tok.aud,
      'token scope': tok.scope,
      'token act': tok.act,
    },
  });

  const listed = await client.listTools();

  const tools: ToolSet = {};
  for (const t of listed.tools) {
    const parameters = jsonSchemaToZod(t.inputSchema);
    tools[t.name] = tool({
      description: t.description ?? `MCP tool: ${t.name}`,
      parameters,
      execute: async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: t.name, arguments: args });
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        return content
          .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
          .join('\n');
      },
    });
  }

  return {
    tools,
    close: async () => {
      try {
        await client.close();
      } catch {
        // best effort
      }
    },
  };
}

/**
 * Minimal JSON-Schema → Zod converter for the property shapes MCP tools emit.
 * Object-of-primitives only.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const s = schema as { type?: string; properties?: Record<string, unknown>; required?: string[] };
  if (!s || s.type !== 'object' || !s.properties) return z.object({});
  const shape: Record<string, z.ZodTypeAny> = {};
  const required = new Set(s.required ?? []);
  for (const [key, value] of Object.entries(s.properties)) {
    const v = value as { type?: string; description?: string };
    let zType: z.ZodTypeAny;
    switch (v.type) {
      case 'string':
        zType = z.string();
        break;
      case 'number':
      case 'integer':
        zType = z.number();
        break;
      case 'boolean':
        zType = z.boolean();
        break;
      default:
        zType = z.unknown();
    }
    if (v.description) zType = zType.describe(v.description);
    if (!required.has(key)) zType = zType.optional();
    shape[key] = zType;
  }
  return z.object(shape);
}
