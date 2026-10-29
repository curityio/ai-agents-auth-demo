import { createHash } from 'node:crypto';
import { trace } from '@opentelemetry/api';

/*
 * HTTP wire log — a DEMO aid. Every outbound `fetch` this process makes is
 * printed as one box-drawn block: a headline saying what the call IS (token
 * exchange, MCP method, LLM chat, A2A), then method + URL, the headers the app
 * set, the body, and the response. Nothing is redacted, on purpose: the point
 * is to show the real request to an audience.
 *
 *   HTTP_WIRE_LOG=on    readable: JWTs shortened with their claims listed one per
 *                       line, only protocol-relevant response headers, and the
 *                       big bodies (AS metadata, LLM prompts) summarised.
 *   HTTP_WIRE_LOG=full  everything as sent: raw JWTs, every header, every field.
 *
 * It is the evidence under the OBO log (`packages/auth-curity/src/obo-log.ts`),
 * not a replacement for it, so it has its own switch. Unset means off; the demo
 * manifests (`k8s/workloads/*.yaml`) set it to `on`.
 *
 * Only outbound calls are logged — one hop's outbound request is the next hop's
 * inbound one, and both carry the same trace id. One hook covers every Node
 * service because all of them load this package via `node --import` and send
 * every hop through the global fetch. Not covered: @kubernetes/client-node
 * (uses node:http) and the Next.js BFF (does not load this package).
 */

const JWT_RE = /eyJ[\w-]*\.eyJ[\w-]*\.[\w-]*/g;

export type WireMode = 'pretty' | 'full';

/** `full` mode: response headers that say nothing about identity or the protocol. */
const NOISY_RESPONSE_HEADERS = new Set([
  'date',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'vary',
  'etag',
  'x-powered-by',
  'cache-control',
  'pragma',
  'expires',
]);

/**
 * `pretty` mode: the ONLY response headers shown (plus `mcp-*`). An allowlist,
 * because the noise is open-ended — browser-security headers from Curity, envoy
 * plumbing from the mesh, fifteen `azureai-*`/`x-ms-*` headers from the LLM.
 */
const SHOWN_RESPONSE_HEADERS = new Set([
  'content-type',
  'www-authenticate',
  'dpop-nonce',
  'location',
  'retry-after',
]);

/** Claims listed first, in this order; the rest are named on one `other` line. */
const KEY_CLAIMS = ['sub', 'aud', 'scope', 'acr', 'roles', 'client_id', 'act', 'may_act', 'cnf', 'iss'];
const TIME_CLAIMS = ['exp', 'iat', 'nbf'];

/** The AS-metadata fields the agents actually use; the rest are counted. */
const AS_METADATA_FIELDS = [
  'issuer',
  'token_endpoint',
  'jwks_uri',
  'grant_types_supported',
  'token_endpoint_auth_methods_supported',
  'client_id_metadata_document_supported',
  'dpop_signing_alg_values_supported',
];

const SYSTEM_PROMPT_LINES = 4;
const TOOL_RESULT_CHARS = 300;

export interface WireRecord {
  service: string;
  at: string;
  /** Position of this call among the calls this process made in the same trace. */
  seq?: number;
  traceId?: string;
  spanId?: string;
  method: string;
  url: string;
  requestHeaders: [string, string][];
  requestBody?: string;
  /** Time to response headers. */
  ms: number;
  status?: number;
  statusText?: string;
  responseHeaders?: [string, string][];
  responseBody?: string;
  /** Set when fetch itself rejected (DNS, TLS, refused, aborted). */
  error?: string;
}

export interface WireLogOptions {
  service: string;
  mode: WireMode;
  /** Body characters to print before truncating; 0 = no limit. */
  maxBody: number;
  write: (block: string) => void;
  /** Where the trace ids come from; the active span unless a test injects one. */
  spanContext?: () => { traceId: string; spanId: string } | undefined;
}

type Json = Record<string, unknown>;

export interface FormatOptions {
  mode: WireMode;
  maxBody: number;
  /**
   * `pretty` only: the JWTs already printed in this trace → the `#n` of the block
   * that printed them. A token is expanded once per trace and referenced after
   * that — the agent's gateway token rides on every MCP request of a question.
   * Updated in place; omit it and every token is expanded.
   */
  seenTokens?: Map<string, number>;
}

/** Formatter (exported for testing); its only side effect is recording into `seenTokens`. */
export function formatWireLog(r: WireRecord, opts: FormatOptions): string {
  const ctx: LineCtx = { full: opts.mode === 'full', atSec: Date.parse(r.at) / 1000, seq: r.seq, seen: opts.seenTokens };
  const full = ctx.full;
  const out: string[] = [`┌─ ${r.seq ? `#${r.seq} ` : ''}${r.at} [${r.service}] ${headline(r)}`];
  out.push(`│ ${r.method} ${r.url}`);
  if (r.traceId) out.push(`│ trace ${r.spanId ? `${r.traceId} ▸ ${r.spanId}` : r.traceId}`);
  const push = (line: string) => pushLine(out, line, ctx);

  for (const [k, v] of r.requestHeaders) push(`${k}: ${v}`);
  if (r.requestBody) {
    out.push('│');
    renderBody(r.requestBody, contentType(r.requestHeaders), r.url, full, opts.maxBody).forEach(push);
  }

  if (r.error) {
    out.push(`├─ ◀ FAILED (${r.ms} ms): ${r.error}`);
  } else {
    out.push(`├─ ◀ ${r.status} ${r.statusText ?? ''}`.trimEnd() + ` (${r.ms} ms)`);
    const headers = r.responseHeaders ?? [];
    for (const [k, v] of headers.filter(([k]) => showResponseHeader(k, full))) push(`${k}: ${v}`);
    if (r.responseBody?.trim()) {
      out.push('│');
      renderBody(r.responseBody, contentType(headers), r.url, full, opts.maxBody).forEach(push);
    }
  }
  out.push('└─');
  return out.join('\n');
}

// ── headline ────────────────────────────────────────────────────────────────

/** What the call IS, from the request alone — so blocks can be told apart at a glance. */
function headline(r: WireRecord): string {
  const header = (name: string) => r.requestHeaders.find(([k]) => k === name)?.[1];
  let path = r.url;
  let search = '';
  try {
    const u = new URL(r.url);
    path = u.pathname;
    search = u.search;
  } catch {
    // not an absolute URL — use it as is
  }

  if (contentType(r.requestHeaders)?.includes('form-urlencoded') && r.requestBody) {
    const form = new URLSearchParams(r.requestBody);
    const grant = form.get('grant_type');
    if (grant?.endsWith(':token-exchange')) {
      const dpop = header('dpop') ? '  (DPoP-bound)' : '';
      return `token-exchange  aud=${form.get('audience') ?? '?'} scope=${form.get('scope') ?? '?'}${dpop}`;
    }
    if (grant) return `token  grant_type=${grant}`;
  }
  if (path.includes('/.well-known/oauth-protected-resource')) {
    return 'discovery  protected-resource metadata (RFC 9728)';
  }
  if (/\/\.well-known\/(oauth-authorization-server|openid-configuration)/.test(path)) {
    return 'discovery  authorization-server metadata (RFC 8414)';
  }

  const body = tryJson(r.requestBody);
  if (isObj(body) && Array.isArray(body.messages) && path.endsWith('/chat/completions')) {
    const tools = Array.isArray(body.tools) ? body.tools.length : 0;
    return `LLM chat  ${body.messages.length} messages, ${tools} tools`;
  }
  if (isObj(body) && body.jsonrpc && typeof body.method === 'string') {
    const params = isObj(body.params) ? body.params : {};
    if (header('mcp-protocol-version')) {
      let s = `MCP ${body.method}`;
      if (body.method === 'tools/call') s += ` ${String(params.name)} ${JSON.stringify(params.arguments ?? {})}`;
      if (!header('authorization')) s += '  (no token: discovery probe)';
      return s;
    }
    const message = isObj(params.message) ? params.message : {};
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const text = parts.find((p): p is Json => isObj(p) && typeof p.text === 'string')?.text as string | undefined;
    return `A2A ${body.method}${text ? `  "${clip(text.replace(/\s+/g, ' '), 60)}"` : ''}`;
  }
  return `${r.method} ${path}${search}`;
}

// ── lines and JWTs ──────────────────────────────────────────────────────────

interface LineCtx {
  full: boolean;
  atSec: number;
  seq?: number;
  seen?: Map<string, number>;
}

/**
 * One line, followed by every JWT in it decoded. `pretty` shortens the JWTs and
 * expands each one only the first time this trace shows it; DPoP proofs and
 * client assertions are fresh per request, so they are never referenced back.
 */
function pushLine(out: string[], line: string, c: LineCtx): void {
  if (c.full) {
    out.push(`│ ${line}`);
    for (const jwt of line.match(JWT_RE) ?? []) out.push(...jwtLines(jwt, true, c.atSec));
    return;
  }
  const expand: string[] = [];
  const shown = line.replace(JWT_RE, (jwt) => {
    const first = c.seq ? c.seen?.get(jwt) : undefined;
    if (first === undefined) {
      if (c.seq) c.seen?.set(jwt, c.seq);
      expand.push(jwt);
      return shortJwt(jwt);
    }
    return `${shortJwt(jwt)} (same token as ${first === c.seq ? 'above' : `#${first}`})`;
  });
  out.push(`│ ${shown}`);
  for (const jwt of expand) out.push(...jwtLines(jwt, false, c.atSec));
}

function shortJwt(jwt: string): string {
  return `${jwt.slice(0, 8)}…${jwt.slice(-6)} (${jwt.length} chars)`;
}

function decodeJwt(jwt: string): { header: Json; payload: Json } | undefined {
  try {
    const [h, p] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString()) as unknown;
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString()) as unknown;
    return isObj(header) && isObj(payload) ? { header, payload } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `full`: the payload as one JSON line (plus the header for a DPoP proof, which
 * carries the key). `pretty`: one claim per line, the identity claims first.
 */
function jwtLines(jwt: string, full: boolean, atSec: number): string[] {
  const d = decodeJwt(jwt);
  if (!d) return [];
  const isProof = d.header.typ === 'dpop+jwt';
  if (full) {
    return [`│     ⇢ ${isProof ? `${JSON.stringify(d.header)} ` : ''}${JSON.stringify(d.payload)}`];
  }
  const rows = isProof ? proofRows(d.header, d.payload, atSec) : claimRows(d.payload, atSec);
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `│     ${k.padEnd(width)}  ${v}`);
}

function claimRows(p: Json, atSec: number): [string, string][] {
  const rows: [string, string][] = [];
  for (const k of KEY_CLAIMS) if (p[k] !== undefined) rows.push([k, claimValue(k, p[k])]);
  for (const k of TIME_CLAIMS) if (typeof p[k] === 'number') rows.push([k, clock(p[k] as number, atSec)]);
  const other = Object.keys(p).filter((k) => !KEY_CLAIMS.includes(k) && !TIME_CLAIMS.includes(k));
  if (other.length) rows.push(['other', other.join(', ')]);
  return rows;
}

/** A DPoP proof: what it binds to, and the thumbprint of its key — which is the token's `cnf.jkt`. */
function proofRows(h: Json, p: Json, atSec: number): [string, string][] {
  const rows: [string, string][] = [];
  for (const k of ['htm', 'htu', 'nonce', 'ath', 'jti']) if (p[k] !== undefined) rows.push([k, String(p[k])]);
  if (typeof p.iat === 'number') rows.push(['iat', clock(p.iat, atSec)]);
  const jkt = isObj(h.jwk) ? thumbprint(h.jwk) : undefined;
  rows.push(['key', `${jkt ? `jkt=${jkt}` : 'jwk'} (${String(h.alg)})`]);
  return rows;
}

function claimValue(k: string, v: unknown): string {
  if (k === 'act') return flattenAct(v) ?? JSON.stringify(v);
  if (k === 'may_act' && isObj(v) && v.sub != null) return shortSpiffe(String(v.sub));
  if (k === 'cnf' && isObj(v) && v.jkt != null) return `jkt=${String(v.jkt)}`;
  if (Array.isArray(v)) return v.map(String).join(', ');
  return typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
}

/** Nested RFC 8693 `act` → `oldest ▸ … ▸ newest`, SPIFFE IDs shortened to their SA. */
function flattenAct(act: unknown): string | undefined {
  const chain: string[] = [];
  for (let cur = act, guard = 0; isObj(cur) && guard < 16; cur = cur.act, guard++) {
    if (cur.sub != null) chain.push(shortSpiffe(String(cur.sub)));
  }
  return chain.length ? chain.reverse().join(' ▸ ') : undefined;
}

function shortSpiffe(s: string): string {
  return /\/sa\/([^/]+)$/.exec(s)?.[1] ?? s;
}

/** `20:57:58Z (in 596s)`, relative to when the request was sent. */
function clock(sec: number, atSec: number): string {
  const t = `${new Date(sec * 1000).toISOString().slice(11, 19)}Z`;
  if (!Number.isFinite(atSec)) return t;
  const d = Math.round(sec - atSec);
  return `${t} (${d >= 0 ? `in ${d}s` : `${-d}s ago`})`;
}

/** RFC 7638 JWK thumbprint: SHA-256 of the required members in lexicographic order. */
function thumbprint(jwk: Json): string | undefined {
  const required =
    jwk.kty === 'EC' ? ['crv', 'kty', 'x', 'y'] : jwk.kty === 'RSA' ? ['e', 'kty', 'n'] : jwk.kty === 'OKP' ? ['crv', 'kty', 'x'] : undefined;
  if (!required) return undefined;
  const canonical = JSON.stringify(Object.fromEntries(required.map((k) => [k, jwk[k]])));
  return createHash('sha256').update(canonical).digest('base64url');
}

// ── bodies ──────────────────────────────────────────────────────────────────

function renderBody(body: string, ct: string | undefined, url: string, full: boolean, maxBody: number): string[] {
  let lines: string[];
  if (ct?.includes('form-urlencoded')) {
    lines = [...new URLSearchParams(body)].map(([k, v]) => `${k}=${v}`);
  } else if (ct?.includes('event-stream') && !full) {
    lines = renderSse(body);
  } else if (ct?.includes('json') && tryJson(body) !== undefined) {
    const v = tryJson(body);
    lines = full ? prettyJson(v) : summarizeJson(v, url);
  } else {
    lines = body.split('\n');
  }
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();

  const text = lines.join('\n');
  if (maxBody > 0 && text.length > maxBody) {
    return `${text.slice(0, maxBody)}\n… (${text.length - maxBody} more chars; raise HTTP_WIRE_LOG_MAX_BODY)`.split('\n');
  }
  return lines;
}

/** SSE: each `data:` payload rendered like any other JSON body; blank separators dropped. */
function renderSse(body: string): string[] {
  const lines: string[] = [];
  for (const l of body.split('\n')) {
    if (!l.trim()) continue;
    const data = l.startsWith('data:') ? tryJson(l.slice(5).trim()) : undefined;
    if (data === undefined) {
      lines.push(l);
      continue;
    }
    lines.push('data:', ...summarizeJson(data, '').map((x) => `  ${x}`));
  }
  return lines;
}

function summarizeJson(v: unknown, url: string): string[] {
  if (!isObj(v)) return prettyJson(v);
  if (/\/\.well-known\/(oauth-authorization-server|openid-configuration)/.test(url)) return asMetadata(v);
  if (Array.isArray(v.messages)) return llmRequest(v);
  if (Array.isArray(v.choices)) return llmResponse(v);
  return jsonRpc(v);
}

function asMetadata(v: Json): string[] {
  const shown = AS_METADATA_FIELDS.filter((k) => v[k] !== undefined);
  const rows = aligned(shown.map((k) => [k, claimValue(k, v[k])]));
  const more = Object.keys(v).length - shown.length;
  return more > 0 ? [...rows, `… ${more} more fields (HTTP_WIRE_LOG=full shows them)`] : rows;
}

function llmRequest(v: Json): string[] {
  const tools = (Array.isArray(v.tools) ? v.tools : []).map((t) =>
    isObj(t) && isObj(t.function) ? String(t.function.name) : '?',
  );
  const options = Object.keys(v).filter((k) => !['model', 'messages', 'tools'].includes(k) && typeof v[k] !== 'object');
  const lines = aligned([
    ['model', String(v.model)],
    ...(tools.length ? [['tools', tools.join(', ')] as [string, string]] : []),
    ...options.map((k): [string, string] => [k, String(v[k])]),
  ]);
  for (const m of v.messages as unknown[]) {
    if (!isObj(m)) continue;
    lines.push(`── ${String(m.role)}`);
    let text = messageText(m.content);
    if (m.role === 'tool') text = compactToolResult(text);
    let body = text ? text.split('\n') : [];
    if (m.role === 'system' && body.length > SYSTEM_PROMPT_LINES) {
      body = [...body.slice(0, SYSTEM_PROMPT_LINES), `… (${body.length - SYSTEM_PROMPT_LINES} more lines)`];
    }
    lines.push(...body.map((l) => `  ${l}`), ...toolCalls(m.tool_calls));
  }
  return lines;
}

function llmResponse(v: Json): string[] {
  const choice = isObj((v.choices as unknown[])[0]) ? ((v.choices as unknown[])[0] as Json) : {};
  const usage = isObj(v.usage) ? v.usage : {};
  const lines = aligned([
    ['model', String(v.model)],
    ['finish', String(choice.finish_reason)],
    ['usage', `${String(usage.prompt_tokens)} prompt → ${String(usage.completion_tokens)} completion tokens`],
  ]);
  const message = isObj(choice.message) ? choice.message : {};
  const text = messageText(message.content);
  lines.push('── assistant', ...(text ? text.split('\n').map((l) => `  ${l}`) : []), ...toolCalls(message.tool_calls));
  return lines;
}

/** JSON-RPC; an MCP tool result's `content[].text` is printed as text, not as an escaped string. */
function jsonRpc(v: Json): string[] {
  const result = isObj(v.result) ? v.result : undefined;
  if (!result || !Array.isArray(result.content)) return prettyJson(v);
  const { content, ...rest } = result;
  const lines = prettyJson({ ...v, result: rest });
  (content as unknown[]).forEach((item, i) => {
    if (isObj(item) && typeof item.text === 'string') {
      const inner = tryJson(item.text);
      lines.push(`content[${i}] text:`, ...(inner !== undefined ? prettyJson(inner) : item.text.split('\n')).map((l) => `  ${l}`));
    } else {
      lines.push(`content[${i}]: ${JSON.stringify(item)}`);
    }
  });
  return lines;
}

function toolCalls(calls: unknown): string[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((c) => {
    const fn = isObj(c) && isObj(c.function) ? c.function : {};
    return `  → tool_call ${String(fn.name)} ${String(fn.arguments ?? '')}`;
  });
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (isObj(p) && typeof p.text === 'string' ? p.text : `[${isObj(p) ? String(p.type) : '?'}]`)).join('\n');
}

/** A tool result repeats what the `tools/call` block already showed — one clipped line is enough. */
function compactToolResult(text: string): string {
  const v = tryJson(text);
  return clip(v !== undefined ? JSON.stringify(v) : text.replace(/\s+/g, ' '), TOOL_RESULT_CHARS);
}

// ── small helpers ───────────────────────────────────────────────────────────

function aligned(rows: [string, string][]): string[] {
  const width = rows.reduce((w, [k]) => Math.max(w, k.length), 0);
  return rows.map(([k, v]) => `${k.padEnd(width)}  ${v}`);
}

function prettyJson(v: unknown): string[] {
  return JSON.stringify(v, null, 2).split('\n');
}

function tryJson(s: string | undefined): unknown {
  if (s === undefined) return undefined;
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s;
}

function contentType(headers: [string, string][]): string | undefined {
  return headers.find(([k]) => k === 'content-type')?.[1];
}

function showResponseHeader(k: string, full: boolean): boolean {
  return full ? !NOISY_RESPONSE_HEADERS.has(k) : SHOWN_RESPONSE_HEADERS.has(k) || k.startsWith('mcp-');
}

// ── the fetch hook ──────────────────────────────────────────────────────────

/** Text of a fetch request body, without consuming what fetch will send. */
async function requestBodyText(input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<string | undefined> {
  const body = init?.body;
  if (body == null) return input instanceof Request ? input.clone().text() : undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return Buffer.from(body as ArrayBuffer).toString();
  }
  return `‹${body.constructor?.name ?? 'stream'} body not shown›`;
}

/**
 * Wrap a fetch so each call is logged once its response body has arrived. The
 * caller gets the ORIGINAL response, untouched; the log reads a clone, so a
 * streamed (SSE) MCP reply is never held up or consumed. Logging can never
 * fail the request: every error inside it is swallowed.
 *
 * A block prints when its response is complete, which can be after an OBO line
 * the call caused; `#n` (assigned when the request is SENT, per trace) keeps the
 * order readable.
 */
export function wrapFetch(original: typeof fetch, opts: WireLogOptions): typeof fetch {
  const spanContext = opts.spanContext ?? (() => trace.getActiveSpan()?.spanContext());
  // Per trace: the last `#n` handed out and the tokens already expanded.
  // ponytail: bounded by evicting the oldest trace; a trace longer-lived than 256 newer ones restarts at #1.
  const traces = new Map<string, { seq: number; tokens: Map<string, number> }>();
  const nextSeq = (traceId: string | undefined): number | undefined => {
    if (!traceId) return undefined;
    const t = traces.get(traceId) ?? { seq: 0, tokens: new Map<string, number>() };
    t.seq++;
    traces.delete(traceId);
    traces.set(traceId, t);
    if (traces.size > 256) traces.delete(traces.keys().next().value!);
    return t.seq;
  };

  return async function wireLoggedFetch(input, init) {
    const started = Date.now();
    const ctx = spanContext();
    const req = input instanceof Request ? input : undefined;
    const base = {
      service: opts.service,
      at: new Date(started).toISOString(),
      seq: nextSeq(ctx?.traceId),
      traceId: ctx?.traceId,
      spanId: ctx?.spanId,
      method: (init?.method ?? req?.method ?? 'GET').toUpperCase(),
      url: req ? req.url : String(input),
      requestHeaders: [...new Headers(init?.headers ?? req?.headers).entries()],
    };
    const bodyP = requestBodyText(input, init).catch(() => undefined);
    const emit = (r: WireRecord) => {
      try {
        const seenTokens = r.traceId ? traces.get(r.traceId)?.tokens : undefined;
        opts.write(formatWireLog(r, { ...opts, seenTokens }));
      } catch {
        // never let the demo log break a request
      }
    };

    let res: Response;
    try {
      res = await original(input, init);
    } catch (e) {
      void bodyP.then((requestBody) =>
        emit({ ...base, requestBody, ms: Date.now() - started, error: (e as Error)?.message ?? String(e) }),
      );
      throw e;
    }
    const ms = Date.now() - started;
    const clone = res.clone();
    void Promise.all([bodyP, clone.text().catch(() => '‹response body unreadable›')]).then(
      ([requestBody, responseBody]) =>
        emit({
          ...base,
          requestBody,
          ms,
          status: res.status,
          statusText: res.statusText,
          responseHeaders: [...res.headers.entries()],
          responseBody,
        }),
    );
    return res;
  };
}

/** Install the wrapper on `globalThis.fetch`: HTTP_WIRE_LOG=on (readable) or =full (raw). */
export function installWireLog(env: NodeJS.ProcessEnv = process.env): boolean {
  const mode = env.HTTP_WIRE_LOG === 'on' ? 'pretty' : env.HTTP_WIRE_LOG === 'full' ? 'full' : undefined;
  if (!mode) return false;
  const maxBody = Number(env.HTTP_WIRE_LOG_MAX_BODY ?? 6000);
  globalThis.fetch = wrapFetch(globalThis.fetch, {
    service: env.OTEL_SERVICE_NAME ?? 'unknown',
    mode,
    maxBody: Number.isFinite(maxBody) ? maxBody : 6000,
    write: (block) => console.log(block),
  });
  return true;
}
