import { exchangeToken, CurityAuthError, oboLog, summarizeJwt } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});

// Snapshot of the most recent mcp-observability → obs-api exchange, for the
// /last-token OBO-chain visualization. Single global slot (demo only).
// `subjectToken` is the INBOUND aud=mcp-observability token this call ran with — kept so
// /last-token can show the real agentgateway → mcp-observability leg. It must not decode
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

export interface PodSummary {
  name: string;
  namespace: string;
  status: string;
  restarts: number;
  ageSeconds: number;
  image: string;
}

export interface PodLogsResult {
  podName: string;
  namespace: string;
  lines: string[];
}

/**
 * 3rd RFC 8693 hop for the read path: subject = inbound mcp-observability-bound
 * token (act={copilot}); actor = mcp-observability's SVID. Curity nests to
 * act={mcp-observability,copilot}. Audience-only narrowing; scope stays obs:read.
 */
export async function obtainObsApiToken(opts: {
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
    audience: cfg.obsApiAudience,
    scope: cfg.obsApiScope,
  });
  lastExchange = { subjectToken, accessToken: result.accessToken, at: Date.now() };
  return result.accessToken;
}

async function getJson<T>(url: string, bearer: string): Promise<T> {
  const res = await fetch(url, {
    method: 'GET',
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
  });
  if (!res.ok) {
    let detail = '';
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`obs-api responded ${res.status}${detail ? ': ' + detail : ''}`);
  }
  return (await res.json()) as T;
}

export async function callListPods(opts: {
  cfg: Config;
  bearer: string;
  namespace: string;
}): Promise<PodSummary[]> {
  const url = `${opts.cfg.obsApiBaseUrl}/pods?namespace=${encodeURIComponent(opts.namespace)}`;
  oboLog({
    service: 'mcp-observability',
    kind: 'CALL',
    headline: '→ obs-api GET /pods',
    fields: { url, namespace: opts.namespace, 'token act': summarizeJwt(opts.bearer).act },
  });
  return getJson<PodSummary[]>(url, opts.bearer);
}

export async function callGetPodLogs(opts: {
  cfg: Config;
  bearer: string;
  podName: string;
  namespace: string;
  tailLines: number;
}): Promise<PodLogsResult> {
  const url =
    `${opts.cfg.obsApiBaseUrl}/pods/${encodeURIComponent(opts.podName)}/logs` +
    `?namespace=${encodeURIComponent(opts.namespace)}&tailLines=${opts.tailLines}`;
  oboLog({
    service: 'mcp-observability',
    kind: 'CALL',
    headline: '→ obs-api GET /pods/:name/logs',
    fields: {
      pod: opts.podName,
      namespace: opts.namespace,
      tailLines: opts.tailLines,
      'token act': summarizeJwt(opts.bearer).act,
    },
  });
  return getJson<PodLogsResult>(url, opts.bearer);
}

export interface DeploymentSummary {
  name: string;
  namespace: string;
  image: string;
  replicas: number;
  readyReplicas: number;
  updatedReplicas: number;
  generation: number | undefined;
  observedGeneration: number | undefined;
}

export async function callGetDeployment(opts: {
  cfg: Config;
  bearer: string;
  name: string;
  namespace: string;
}): Promise<DeploymentSummary> {
  const url = `${opts.cfg.obsApiBaseUrl}/deployments/${encodeURIComponent(opts.name)}?namespace=${encodeURIComponent(opts.namespace)}`;
  oboLog({
    service: 'mcp-observability',
    kind: 'CALL',
    headline: '→ obs-api GET /deployments/:name',
    fields: { url, deployment: opts.name, namespace: opts.namespace, 'token act': summarizeJwt(opts.bearer).act },
  });
  return getJson<DeploymentSummary>(url, opts.bearer);
}
