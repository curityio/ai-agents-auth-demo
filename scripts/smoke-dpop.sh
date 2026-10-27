#!/usr/bin/env bash
# Smoke test for DPoP (RFC 9449) on the agent → agentgateway hop.
#
# Runs inside the agent-copilot pod with the copilot's own CIMD key + SPIFFE SVID,
# using the PRODUCT code (auth-curity `exchangeToken({dpop})`, agent-runtime
# `withDpop`), against the gateway's public route:
#
#   [1/5] A DPoP exchange returns a token bound to our key (cnf.jkt = thumbprint),
#         through Curity's use_dpop_nonce round trip.
#   [2/5] That token, presented with fresh proofs, connects and lists the read tools.
#   [3/5] The SAME token replayed as a plain Bearer (no proof) is refused with
#         401 + a DPoP challenge — a leaked bound token is useless without the key.
#   [4/5] A proof made for another route (htu=/ops/mcp) is refused.
#   [5/5] A replayed proof (same jti) is refused.
#
# Unbound tokens keep working as Bearer (MCP Inspector, the other suites); the shim
# only demands a proof when the token carries cnf.jkt.
#
# Required env: SMOKE_SUBJECT_TOKEN — a fresh Curity access token for Alice
# (inspect:read is enough). Exit codes: 0 on success, non-zero on any failure.
set -euo pipefail

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
if [[ -z "${SMOKE_SUBJECT_TOKEN:-}" ]]; then
  red "SMOKE_SUBJECT_TOKEN env var is required (a fresh Curity access token for Alice)."
  exit 78  # EX_CONFIG
fi

GATEWAY_URL="${GATEWAY_URL:-https://mcp-gateway.localtest.me/inspect/mcp}"
TOKEN_ENDPOINT="${TOKEN_ENDPOINT:-https://curity.localtest.me/oauth/v2/oauth-token}"

kubectl -n agents exec -i deploy/agent-copilot -c agent -- \
  env SUBJ="$SMOKE_SUBJECT_TOKEN" GW="$GATEWAY_URL" TE="$TOKEN_ENDPOINT" \
  sh -c 'cd /app/apps/agent-copilot && node --input-type=module -' <<'NODE'
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { decodeJwt } from 'jose';
import { createCimdIdentity, createDpopKey, createDpopProof, exchangeToken } from '@ai-agents-demo/auth-curity';
import { withDpop } from '@ai-agents-demo/agent-runtime';

// The MCP client is a dependency of agent-runtime, not of the copilot app.
const cjs = createRequire('/app/packages/agent-runtime/package.json').resolve('@modelcontextprotocol/client');
const { Client, StreamableHTTPClientTransport } = await import(join(dirname(cjs), 'index.mjs'));

const { GW, TE, SUBJ } = process.env;
const ok = (m) => console.log(`OK   ${m}`);
const die = (m) => { console.log(`FAIL ${m}`); process.exit(1); };

async function listTools(fetchImpl, headers = {}) {
  const t = new StreamableHTTPClientTransport(new URL(GW), { fetch: fetchImpl, requestInit: { headers } });
  const c = new Client({ name: 'smoke-dpop', version: '0' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  await c.connect(t);
  const names = (await c.listTools()).tools.map((x) => x.name).sort();
  await c.close();
  return names;
}
const refused = async (label, fn) => {
  try { await fn(); } catch (e) {
    const msg = String(e?.message ?? e);
    if (/401|invalid_dpop_proof|unauthori/i.test(msg)) return ok(label);
    die(`${label}: refused, but not as a DPoP 401: ${msg.slice(0, 160)}`);
  }
  die(`${label}: was ACCEPTED`);
};

// [1/5] bound exchange
const clientId = process.env.CURITY_CLIENT_ID, pem = process.env.CURITY_AGENT_PRIVATE_KEY_PEM;
const { kid } = await createCimdIdentity({ privateKeyPkcs8Pem: pem, clientId });
const key = await createDpopKey();
const { accessToken } = await exchangeToken({
  tokenEndpoint: TE, clientId,
  clientAuth: { method: 'private_key_jwt', privateKeyPkcs8Pem: pem, kid, assertionAudience: TE },
  subjectToken: SUBJ, actorToken: readFileSync('/run/spiffe/curity-actor.jwt', 'utf8').trim(),
  audience: process.env.MCP_INSPECT_AUDIENCE ?? 'mcp-gateway', scope: 'inspect:read', dpop: key,
});
const cnf = decodeJwt(accessToken).cnf?.jkt;
if (cnf !== key.jkt) die(`[1/5] token not bound to our key: cnf.jkt=${cnf}`);
ok(`[1/5] exchange bound the token to our key (cnf.jkt=${cnf.slice(0, 12)}…, nonce ${key.nonce ? 'negotiated' : 'none'})`);

// [2/5] proofs → works
const bearer = { authorization: `Bearer ${accessToken}` };
const tools = await listTools(withDpop(key), bearer).catch((e) => die(`[2/5] with proofs: ${e?.message ?? e}`));
if (!tools.includes('list_pods')) die(`[2/5] unexpected tools: ${tools}`);
ok(`[2/5] with per-request proofs the gateway serves the read tier: ${tools.join(', ')}`);

// [3/5] replayed as Bearer, no proof → 401 DPoP challenge
const r = await fetch(GW, { method: 'POST', headers: { ...bearer, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
const www = r.headers.get('www-authenticate') ?? '';
if (r.status !== 401) die(`[3/5] bound token without proof: expected 401, got ${r.status}`);
ok(`[3/5] bound token replayed as plain Bearer → 401 ${www ? `(${www.slice(0, 70)})` : ''}`);
await refused('[3/5] …and the MCP client cannot connect with it either', () => listTools(fetch, bearer));

// [4/5] proof for another route
const wrongRoute = async (input, init) => {
  const h = new Headers(init?.headers);
  h.set('authorization', `DPoP ${accessToken}`);
  h.set('dpop', await createDpopProof(key, { htm: init?.method ?? 'GET', htu: GW.replace('/inspect/mcp', '/ops/mcp'), accessToken }));
  return fetch(input, { ...init, headers: h });
};
await refused('[4/5] a proof made for /ops/mcp is refused on /inspect/mcp', () => listTools(wrongRoute, bearer));

// [5/5] the same proof twice
let frozen;
const replaying = async (input, init) => {
  const h = new Headers(init?.headers);
  h.set('authorization', `DPoP ${accessToken}`);
  frozen ??= await createDpopProof(key, { htm: 'POST', htu: GW, accessToken });
  h.set('dpop', frozen);
  return fetch(input, { ...init, headers: h });
};
await refused('[5/5] a replayed proof (same jti) is refused', () => listTools(replaying, bearer));
NODE
printf '\033[32m%s\033[0m\n' "==> DPoP binding enforced on the agent → gateway hop."
