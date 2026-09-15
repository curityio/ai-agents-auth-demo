import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { jsonSchema, tool, type FlexibleSchema, type ToolSet } from 'ai';
import { oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';

export interface McpToolset {
  /** AI-SDK-shaped tools, one per discovered MCP tool. */
  tools: ToolSet;
  /**
   * The server's `tools/list` entries as advertised (name, description, `_meta`).
   * The AI SDK's tool object has nowhere to carry `_meta`, and that is where
   * mcp-ops publishes per-tool required roles — see `requiredRolesOf`.
   */
  listed: ListedTool[];
  /** Close the underlying transport once a chat turn finishes. */
  close: () => Promise<void>;
}

export interface ListedTool {
  name: string;
  description?: string;
  /** The tool's `_meta` from `tools/list`, verbatim. */
  meta?: Record<string, unknown>;
}

/**
 * `_meta` key under which an MCP server publishes the roles a caller needs to
 * CALL a tool that the gateway nevertheless LISTS. Must match
 * `REQUIRED_ROLES_META` in apps/mcp-ops/src/mcp.ts (pinned by tests on both
 * sides). Reverse-DNS prefixed per the MCP `_meta` convention.
 */
export const MCP_TOOL_META_REQUIRED_ROLES = 'io.curity.demo/required-roles';

export function toListedTool(t: { name: string; description?: string; _meta?: Record<string, unknown> }): ListedTool {
  return {
    name: t.name,
    ...(typeof t.description === 'string' ? { description: t.description } : {}),
    ...(t._meta ? { meta: t._meta } : {}),
  };
}

/** The tool's published required roles, or undefined when it publishes none (or something unreadable). */
export function requiredRolesOf(t: ListedTool): string[] | undefined {
  const v = t.meta?.[MCP_TOOL_META_REQUIRED_ROLES];
  return Array.isArray(v) && v.every((r) => typeof r === 'string') ? (v as string[]) : undefined;
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
    tools[t.name] = tool({
      description: t.description ?? `MCP tool: ${t.name}`,
      inputSchema: mcpInputSchema(t.inputSchema),
      execute: async (args: Record<string, unknown>) => {
        let result;
        try {
          result = await client.callTool({ name: t.name, arguments: args });
        } catch (e: unknown) {
          // A policy denial at the gateway arrives as a TRANSPORT error (plain
          // HTTP 403), not an MCP tool result — agentgateway's `authorization`
          // rules cannot put a message in the response body. Left to throw, the AI
          // SDK reports only "tool call failed" and the model invents an
          // explanation: observed output was "I do not have permissions… run
          // kubectl yourself", which is vague AND wrong about who lacked
          // permission. Turn it into a factual tool result instead.
          //
          // Deliberately NO instructions to the model in this payload: tool output
          // is untrusted data, and a system that obeys imperatives smuggled through
          // it is the prompt-injection hole this whole demo argues against. How to
          // relay a refusal belongs in the agent's system prompt — see
          // apps/agent-specialist/src/system-prompt.ts.
          //
          // Denials raised by the MCP server itself (e.g. mcp-ops's role gate)
          // already come back as isError results and never reach this branch.
          const msg = e instanceof Error ? e.message : String(e);
          const denied = /\b403\b|forbidden|authorization failed/i.test(msg);
          if (!denied) throw e;
          return JSON.stringify({
            error: 'forbidden',
            tool: t.name,
            message:
              `Authorization policy refused the '${t.name}' call for this user (HTTP 403 at the gateway). ` +
              `The user is not authorized to invoke this tool.`,
          });
        }
        const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
        return content
          .map((c) => (c.type === 'text' ? (c.text ?? '') : JSON.stringify(c)))
          .join('\n');
      },
    });
  }

  return {
    tools,
    listed: listed.tools.map(toListedTool),
    close: async () => {
      try {
        await client.close();
      } catch {
        // best effort
      }
    },
  };
}

const EMPTY_OBJECT_SCHEMA = { type: 'object', properties: {} } as const;

/**
 * Adapt an MCP tool's advertised `inputSchema` for the AI SDK's `inputSchema`.
 *
 * The server's JSON Schema is passed through **verbatim**. This replaced a
 * hand-written JSON-Schema→Zod converter that handled "object of primitives"
 * only, and silently dropped everything else: enums, arrays and nested objects
 * collapsed to `z.unknown()`, and all constraints were lost — `replicas`
 * (`integer`, 0–20 on mcp-ops) reached the model as a bare number, so it could
 * propose 50 replicas and only discover the limit from a server-side rejection.
 * Reshaping the document here also meant maintaining a second, drifting
 * definition of a contract the server already publishes.
 *
 * **Trade-off, deliberate:** `jsonSchema()` performs no validation unless given a
 * `validate` function, so the model's arguments are no longer checked
 * client-side. That check was never the security boundary — `mcp-observability`
 * and `mcp-ops` validate their own inputs with zod 4 on every call, and the
 * gateway's `Mcp-Param-Namespace` authz rule fails closed on anything it cannot
 * read. What changes is where a malformed call is caught: the server returns an
 * error result the model can act on, instead of the SDK rejecting locally. Since
 * the model now sees the real constraints, it should produce fewer such calls.
 *
 * Sending the schema unconstrained is safe because tool definitions go out
 * **non-strict**: `@ai-sdk/openai-compatible` sets `strict` on a tool only when the
 * tool asks for it, and its `strictJsonSchema: true` default applies to
 * `response_format`, which we never use. Under strict function calling OpenAI
 * rejects keywords like `minimum`; non-strict treats them as advice to the model.
 * Setting a tool's `strict` here would therefore need the schema narrowed first.
 *
 * MCP permits a tool with no inputs, but the AI SDK still wants an object schema,
 * hence the fallback.
 */
export function mcpInputSchema(schema: unknown): FlexibleSchema<Record<string, unknown>> {
  const s = schema as { type?: string; properties?: Record<string, unknown> } | undefined | null;
  if (!s || s.type !== 'object' || !s.properties) {
    return jsonSchema<Record<string, unknown>>({ ...EMPTY_OBJECT_SCHEMA });
  }
  return jsonSchema<Record<string, unknown>>(s as Parameters<typeof jsonSchema>[0]);
}
