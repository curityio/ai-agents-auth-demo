import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { StepUpRequiredError } from '@ai-agents-demo/a2a-helpers';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

let lastExchange: { sub: string; accessToken: string; at: number } | undefined;

/**
 * Peek the most recent exchange this process performed. Matches
 * agent-copilot's peekLastExchange — used by /last-token for the demo UI's
 * N-deep chain visualization.
 */
export function peekLastExchange(): { sub: string; accessToken: string; at: number } | undefined {
  return lastExchange ? { ...lastExchange } : undefined;
}

/**
 * Exchange the inbound bearer (carrying act=copilot) for an mcp-ops-bound
 * token. The procedure nests the inbound act under THIS agent's SPIFFE ID
 * automatically — so the issued token's `act` is
 *   { sub: specialist, act: { sub: copilot } }
 * which is exactly what mcp-ops's middleware checks.
 *
 * Intentionally NO local cache here: the inbound bearer is request-scoped
 * (user JWT after one upstream exchange), and caching across users would
 * leak privileged tokens between sessions. agent-copilot's cache is keyed
 * on user sub; here we let each call mint fresh.
 */
export async function obtainOpsToken(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  /** Discovered from the MCP server's authorization-server metadata (never configured). */
  tokenEndpoint: string;
  /** Discovered: the 401 challenge's `scope`, else the PRM's `scopes_supported`. */
  scope: string;
  /**
   * Whether this call should be recorded as the process's "most recent
   * exchange" for the debug /last-token route. Defaults to true. The tools/list
   * PROBE passes false: it mints the same tokens a real flow would, but it is
   * not a flow, and recording it made the OBO-chain view flip to a branch the
   * user never exercised.
   */
  recordLastExchange?: boolean;
}): Promise<string> {
  const { cfg, subjectToken, subjectSub, tokenEndpoint, scope } = opts;
  const svid = await svidSource.getSvid(SVID_AUDIENCE);
  if (!svid) {
    throw new CurityAuthError(
      `SPIFFE JWT-SVID not available at ${SVID_FILE} (spiffe-helper not ready?)`,
      'invalid_actor',
    );
  }
  const identity = await getCimdIdentity(cfg);
  const result = await exchangeToken({
    tokenEndpoint,
    clientId: cfg.agentClientId,
    clientAuth: {
      method: 'private_key_jwt',
      privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
      kid: identity.kid,
      assertionAudience: tokenEndpoint,
    },
    subjectToken,
    actorToken: svid.jwt,
    audience: cfg.mcpOpsAudience,
    scope,
  });
  if (opts.recordLastExchange !== false) {
    lastExchange = { sub: subjectSub, accessToken: result.accessToken, at: Date.now() };
  }
  return result.accessToken;
}

/**
 * Parse an RFC 9470 `insufficient_user_authentication` WWW-Authenticate header.
 * Returns the challenge fields, or null if this is any other 401 (not step-up).
 * Only fires for the specific `error="insufficient_user_authentication"` value,
 * leaving other 401s (expired token, invalid token, etc.) as plain errors.
 */
export function parseStepUpChallenge(
  wwwAuthenticate: string | undefined,
): { acrValues: string; resourceMetadata: string } | null {
  if (!wwwAuthenticate) return null;
  const get = (k: string) => wwwAuthenticate.match(new RegExp(`${k}="([^"]+)"`))?.[1];
  if (get('error') !== 'insufficient_user_authentication') return null;
  return {
    acrValues: get('acr_values') ?? 'mfa',
    resourceMetadata: get('resource_metadata') ?? '',
  };
}

/**
 * Out-of-band channel for a challenge observed during the LLM tool loop.
 *
 * Necessary because ai@5 removed `ToolExecutionError` and stopped propagating
 * throws out of a tool's `execute`: the SDK converts them into `tool-error`
 * content parts and keeps looping, so `generateText` RESOLVES and the throw below
 * never reaches `runRemediation`'s catch. Without this sink a real MFA challenge
 * would be handed to the model, which would narrate a failure, and the browser
 * would render that prose instead of prompting for step-up.
 */
export interface StepUpSink {
  err?: StepUpRequiredError;
}

/**
 * Build a fetch wrapper that converts an RFC 9470 step-up 401 into a typed
 * StepUpRequiredError before the MCP SDK swallows the headers. Used for the
 * WRITE toolset (mcp-ops). Reads are unprivileged and don't need this.
 *
 * Still throws — that aborts the individual tool call rather than handing the
 * model a bogus success — but also records into `sink`, which is what actually
 * carries the challenge out. First challenge wins: a later one would describe the
 * same missing authentication.
 */
export function buildStepUpInterceptingFetch(scope: string, sink?: StepUpSink): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (response.status === 401) {
      const challenge = parseStepUpChallenge(response.headers.get('www-authenticate') ?? undefined);
      if (challenge) {
        await response.body?.cancel().catch(() => undefined);
        const err = new StepUpRequiredError({
          acrValues: challenge.acrValues,
          resourceMetadata: challenge.resourceMetadata,
          scope,
        });
        if (sink && !sink.err) sink.err = err;
        throw err;
      }
    }
    return response;
  };
}
