import { exchangeToken, CurityAuthError, oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

// Snapshot of the most recent mcp-ops → ops-api exchange, for the /last-token
// OBO-chain visualization. Single global slot, last writer wins (demo only).
// `subjectToken` is the INBOUND aud=mcp-ops token this call ran with — kept so
// /last-token can show the real agentgateway → mcp-ops leg. It must not decode
// its own request bearer for that: the chain walk also travels through the
// gateway, so that bearer is one the exchange-shim minted for the walk itself.
export interface LastExchange {
  subjectToken: string;
  accessToken: string;
  at: number;
}

let lastExchange: LastExchange | undefined;

export function peekLastExchange(): LastExchange | undefined {
  return lastExchange ? { ...lastExchange } : undefined;
}

export interface RestartArgs {
  name: string;
  namespace?: string;
  reason?: string;
}

export interface SetImageArgs { name: string; image: string; namespace?: string; reason?: string }
export interface ScaleArgs { name: string; replicas: number; namespace?: string; reason?: string }

function opsApiBase(cfg: Config): string {
  // cfg.opsApiUrl is the full /restart URL; strip the trailing path segment.
  return cfg.opsApiUrl.replace(/\/restart$/, '');
}

async function postJson<T>(url: string, bearer: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`ops-api responded ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as T;
}

/**
 * 3rd RFC 8693 hop: subject_token = the inbound mcp-ops-bound Bearer (already
 * carries act={specialist,copilot}); actor_token = mcp-ops's own SPIFFE SVID.
 * Curity's procedure nests automatically, yielding act={mcp-ops,specialist,copilot}.
 * Audience-only narrowing: scope stays ops:write.
 */
export async function obtainOpsApiToken(opts: {
  cfg: Config;
  subjectToken: string;
}): Promise<string> {
  const { cfg, subjectToken } = opts;
  const svid = await svidSource.getSvid(SVID_AUDIENCE);
  if (!svid) {
    throw new CurityAuthError(
      `SPIFFE JWT-SVID not available at ${SVID_FILE} (spiffe-helper not ready?)`,
      'invalid_actor',
    );
  }
  const result = await exchangeToken({
    tokenEndpoint: cfg.curityTokenEndpoint,
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    subjectToken,
    actorToken: svid.jwt,
    audience: cfg.opsApiAudience,
    scope: cfg.opsApiScope,
  });
  lastExchange = { subjectToken, accessToken: result.accessToken, at: Date.now() };
  return result.accessToken;
}

export interface RestartResult {
  deployment: string;
  namespace: string;
  restartedAt: string;
  generation?: number;
}

/** Call ops-api's POST /restart with the just-exchanged Bearer. */
export async function callOpsApiRestart(opts: {
  cfg: Config;
  bearer: string;
  args: RestartArgs;
}): Promise<RestartResult> {
  const { cfg, bearer, args } = opts;
  const tok = summarizeJwt(bearer);
  oboLog({
    service: 'mcp-ops',
    kind: 'CALL',
    headline: '→ ops-api POST /restart',
    fields: {
      url: cfg.opsApiUrl,
      deployment: args.name,
      namespace: args.namespace,
      'token aud': tok.aud,
      'token act': tok.act,
      'token acr': tok.acr,
    },
  });
  const res = await fetch(cfg.opsApiUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      // ignore body parse failures
    }
    throw new Error(`ops-api responded ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as RestartResult;
}

export async function callOpsApiSetImage(opts: { cfg: Config; bearer: string; args: SetImageArgs }) {
  const url = `${opsApiBase(opts.cfg)}/set-image`;
  oboLog({
    service: 'mcp-ops', kind: 'CALL', headline: '→ ops-api POST /set-image',
    fields: { url, deployment: opts.args.name, image: opts.args.image, 'token act': summarizeJwt(opts.bearer).act },
  });
  return postJson(url, opts.bearer, opts.args);
}

export async function callOpsApiScale(opts: { cfg: Config; bearer: string; args: ScaleArgs }) {
  const url = `${opsApiBase(opts.cfg)}/scale`;
  oboLog({
    service: 'mcp-ops', kind: 'CALL', headline: '→ ops-api POST /scale',
    fields: { url, deployment: opts.args.name, replicas: opts.args.replicas, 'token act': summarizeJwt(opts.bearer).act },
  });
  return postJson(url, opts.bearer, opts.args);
}
