import { v4 as uuid } from 'uuid';
import { decodeJwt } from 'jose';
import { JsonRpcTransport, createAuthenticatingFetchWithRetry, Client } from '@a2a-js/sdk/client';
import type { AgentCard, Message, Task } from '@a2a-js/sdk';
import { createBearerAuthHandler, isStepUpPayload, type StepUpFields } from '@ai-agents-demo/a2a-helpers';
import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { resolveAuthorizationServer } from '@ai-agents-demo/agent-runtime';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { TokenExchangeCache } from './token-exchange-cache.js';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

// Separate cache from the mcp-inspect path because (sub, scope, audience)
// is the cache key and these differ (`audience=agent-specialist`,
// `scope=ops:write`). Sharing the map would just be a label change for the
// same TTL semantics.
const specialistExchangeCache = new TokenExchangeCache({ ttlMs: 60_000 });

/** Best-effort `jti` extraction from an already-verified JWT (no throw). */
function jtiOf(token: string): string | undefined {
  try {
    const jti = decodeJwt(token).jti;
    return typeof jti === 'string' ? jti : undefined;
  } catch {
    return undefined;
  }
}

let lastExchange:
  | { sub: string; accessToken: string; at: number; subjectJti?: string }
  | undefined;
export function peekLastSpecialistExchange():
  | { sub: string; accessToken: string; at: number; subjectJti?: string }
  | undefined {
  return lastExchange ? { ...lastExchange } : undefined;
}

/**
 * Mint a Bearer for `audience=agent-specialist` with the right scopes.
 * The procedure puts our SPIFFE ID on the issued token's `act` — so when
 * specialist re-exchanges, its result will nest us underneath. We ask for
 * `inspect:read ops:write`; the procedure narrows; the specialist also re-checks
 * its inbound scope before forwarding.
 */
export async function obtainSpecialistToken(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  subjectAcr: string;
  /**
   * Whether this call should be recorded as the process's "most recent
   * exchange" for the debug /last-token route. Defaults to true. The tools/list
   * PROBE passes false: it mints the same tokens a real flow would, but it is
   * not a flow, and recording it made the OBO-chain view flip to a branch the
   * user never exercised.
   */
  recordLastExchange?: boolean;
}): Promise<string> {
  const { cfg, subjectToken, subjectSub, subjectAcr } = opts;
  const record = opts.recordLastExchange !== false;
  const key = {
    sub: subjectSub,
    scope: cfg.specialistScope,
    audience: cfg.specialistAudience,
    acr: subjectAcr,
  };
  const cached = specialistExchangeCache.get(key);
  if (cached) {
    // Refresh the "last used" marker even on a cache hit so the OBO-chain
    // assembler can tell which path was exercised most recently.
    if (record) lastExchange = {
      sub: subjectSub,
      accessToken: cached.accessToken,
      at: Date.now(),
      subjectJti: jtiOf(subjectToken),
    };
    return cached.accessToken;
  }

  const svid = await svidSource.getSvid(SVID_AUDIENCE);
  if (!svid) {
    throw new CurityAuthError(
      `SPIFFE JWT-SVID not available at ${SVID_FILE}`,
      'invalid_actor',
    );
  }

  const identity = await getCimdIdentity(cfg);
  // No MCP server to discover from on this hop, so the AS is the configured
  // issuer — but the token endpoint is still READ from its RFC 8414 metadata,
  // never configured.
  const as = await resolveAuthorizationServer(cfg.curityIssuer);
  const result = await exchangeToken({
    tokenEndpoint: as.tokenEndpoint,
    clientId: cfg.agentClientId,
    clientAuth: {
      method: 'private_key_jwt',
      privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
      kid: identity.kid,
      assertionAudience: as.tokenEndpoint,
    },
    subjectToken,
    actorToken: svid.jwt,
    audience: cfg.specialistAudience,
    scope: cfg.specialistScope,
  });

  specialistExchangeCache.set(key, {
    accessToken: result.accessToken,
    expiresInSec: result.expiresInSec,
    scope: result.scope,
  }, cfg.exchangeCacheTtlMs);
  if (record) lastExchange = {
    sub: subjectSub,
    accessToken: result.accessToken,
    at: Date.now(),
    subjectJti: jtiOf(subjectToken),
  };
  return result.accessToken;
}

export function invalidateSpecialistTokenCache(opts: {
  cfg: Config;
  subjectSub: string;
  subjectAcr: string;
}): void {
  specialistExchangeCache.invalidate({
    sub: opts.subjectSub,
    scope: opts.cfg.specialistScope,
    audience: opts.cfg.specialistAudience,
    acr: opts.subjectAcr,
  });
}

export interface SpecialistResponse {
  ok: boolean;
  status: 'completed' | 'failed' | 'working' | 'submitted' | 'unknown' | 'step-up';
  text?: string;
  /** Parsed JSON body the specialist returned, if any. */
  result?: unknown;
  /** Present when status === 'step-up'. */
  stepUp?: StepUpFields;
}

/**
 * Build the user-facing answer for a privileged (A2A) run from the specialist's
 * response. The specialist is an LLM agent: on success it returns a natural-
 * language `summary` describing what it actually did — including when it was
 * DENIED a tool (e.g. an oncall user attempting set_deployment_image). We surface
 * that summary verbatim rather than a hardcoded "Restart completed", which would
 * (a) misreport the action type and (b) claim success even when the goal was
 * denied or unmet (`ok` only means the A2A task finished, not that it succeeded).
 */
export function buildPrivilegedAnswer(resp: SpecialistResponse, deployment: string): string {
  if (!resp.ok) {
    return `Remediation on '${deployment}' failed: ${resp.text ?? 'unknown error'}`;
  }
  const summary =
    resp.result && typeof (resp.result as { summary?: unknown }).summary === 'string'
      ? ((resp.result as { summary: string }).summary).trim()
      : '';
  if (summary) return summary;
  // No prose from the LLM (e.g. it stopped on tool-calls at the step limit) —
  // stay neutral rather than falsely asserting a specific action completed.
  return `Remediation on '${deployment}' finished, but the specialist returned no summary.`;
}

/**
 * Send a single message via A2A JSON-RPC to agent-specialist. We don't stream
 * because the specialist publishes a final status-update; the message-send
 * response carries it directly.
 */
/**
 * Build a minimal AgentCard *locally* rather than fetching specialist's
 * advertised card. The Client constructor needs an AgentCard reference for
 * its public `getAgentCard()` getter; for the one JSON-RPC call we make,
 * none of the card's content actually changes wire behavior. Skipping the
 * fetch saves a round-trip per request and avoids a bootstrap dependency.
 */
function minimalSpecialistCard(endpoint: string): AgentCard {
  return {
    name: 'agent-specialist',
    description: 'minimal local card for client-only use',
    url: endpoint,
    version: '0.0.1',
    protocolVersion: '0.3',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [],
  };
}

export async function callSpecialist(opts: {
  cfg: Config;
  bearer: string;
  request: { goal: string; deployment?: string; namespace?: string; reason?: string };
  /**
   * Optional DI seam for testing. When provided, replaces the real
   * Client.sendMessage call so tests can inject fake A2A responses without
   * making network requests.
   */
  _sendMessage?: (params: {
    message: Message;
    configuration: { acceptedOutputModes: string[]; blocking: boolean };
  }) => Promise<Message | Task>;
}): Promise<SpecialistResponse> {
  // Forward the user's natural-language goal as a leading TEXT part so the
  // specialist's LLM sees the actual sentence, plus a DATA part with any
  // structured hints copilot's intent detector extracted. The specialist's
  // goalFromMessage joins text+data with text leading.
  const userMsg: Message = {
    kind: 'message',
    messageId: uuid(),
    role: 'user',
    parts: [
      { kind: 'text', text: opts.request.goal },
      {
        kind: 'data',
        data: {
          deployment: opts.request.deployment,
          namespace: opts.request.namespace,
          reason: opts.request.reason,
        },
      },
    ],
  };

  const buildRealSendMessage = () => {
    const authHandler = createBearerAuthHandler(() => opts.bearer);
    const authFetch = createAuthenticatingFetchWithRetry(fetch, authHandler);
    const transport = new JsonRpcTransport({
      endpoint: opts.cfg.specialistA2aUrl,
      fetchImpl: authFetch,
    });
    const client = new Client(transport, minimalSpecialistCard(opts.cfg.specialistA2aUrl));
    return (params: Parameters<typeof client.sendMessage>[0]) => client.sendMessage(params);
  };
  const sendMessage = opts._sendMessage ?? buildRealSendMessage();

  const result = await sendMessage({
    message: userMsg,
    configuration: {
      acceptedOutputModes: ['application/json', 'text/plain'],
      blocking: true,
    },
  });

  // result is `Message | Task`; specialist publishes a Task.
  if ((result as Task).kind === 'task') {
    const task = result as Task;
    const lastMsg = lastAgentMessage(task.history);
    const text = lastMsg ? extractText(lastMsg) : extractText(task.status.message);
    const parsed = text ? tryParse(text) : undefined;
    // Defensive: step-up may also arrive as the task's final message text.
    if (isStepUpPayload(parsed)) {
      return { ok: false, status: 'step-up', text, result: parsed, stepUp: parsed.data };
    }
    // A failure payload may also ride in as the task's final message even when
    // the SDK reports a non-failed/absent state — trust the payload over state.
    if (isErrorPayload(parsed)) {
      return { ok: false, status: 'failed', text, result: parsed };
    }
    const state = task.status.state ?? 'unknown';
    return {
      ok: state === 'completed',
      status: state as SpecialistResponse['status'],
      text,
      result: parsed,
    };
  }

  // Message-only response (no task): this is the canonical carrier when the
  // specialist returns a standalone step-up Message OR an error payload. The
  // @a2a-js SDK drops the executor's failed status-update and resolves to the
  // final Message, so we MUST inspect the payload here — otherwise a denied or
  // failed privileged action (e.g. the specialist's `{error:'access_denied'}`)
  // would be silently reported as a completed success.
  const text = extractText(result as Message);
  const parsed = text ? tryParse(text) : undefined;
  if (isStepUpPayload(parsed)) {
    return { ok: false, status: 'step-up', text, result: parsed, stepUp: parsed.data };
  }
  if (isErrorPayload(parsed)) {
    return { ok: false, status: 'failed', text, result: parsed };
  }
  return {
    ok: true,
    status: 'completed',
    text,
    result: parsed,
  };
}

/**
 * The specialist executor publishes failures as a final Message whose text is
 * either `{ error, error_description }` (its catch path) or `{ ok: false, ... }`
 * (a tool call that returned isError). Either shape means "not a success".
 */
function isErrorPayload(v: unknown): v is { error?: string; error_description?: string; ok?: boolean } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return o.ok === false || typeof o.error === 'string';
}

function lastAgentMessage(history: Message[] | undefined): Message | undefined {
  if (!history) return undefined;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.role === 'agent') return history[i];
  }
  return undefined;
}

function extractText(m: Message | undefined): string | undefined {
  if (!m) return undefined;
  const parts = m.parts ?? [];
  const t = parts
    .map((p) => (p.kind === 'text' ? p.text : p.kind === 'data' ? JSON.stringify(p.data) : ''))
    .filter(Boolean)
    .join('\n');
  return t || undefined;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
