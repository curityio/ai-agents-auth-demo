# agentgateway MCP Gateway Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Istio ambient waypoint in front of the MCP servers with a standalone agentgateway that federates both MCP servers, does per-tool authz, and becomes a new RFC 8693 OBO hop via a co-located SPIFFE-aware exchange shim.

**Architecture:** agentgateway (upstream OSS image) validates the caller's `aud=mcp-gateway` token, applies per-tool CEL RBAC, and for each tool-call drives an `extAuthz` call to a co-located `exchange-shim` (Node, reuses `@ai-agents-demo/auth-curity`). The shim reads the gateway's rotating SPIFFE JWT-SVID from `/run/spiffe/curity-actor.jwt` and performs the RFC 8693 exchange (subject = caller token, actor = SVID, audience/scope = per backend), returning a token-endpoint-shaped JSON body. agentgateway swaps the returned token onto the request and forwards to the origin MCP server. The gateway inserts one position into every downstream `act` chain.

**Tech Stack:** agentgateway (standalone, Apache-2.0), Node 20 + TypeScript (shim), pnpm 9 workspace, KIND, Istio ambient (ztunnel L4 only now), SPIRE (JWT-SVID), Curity (RFC 8693).

## Global Constraints

- **Node ≥ 20; pnpm 9.15.0 via corepack.** All packages ESM (`.js` import specifiers in TS).
- **All public hostnames use `*.localtest.me`** — never `*.nip.io`/`127.0.0.1`.
- **Curity token procedures are validated by Nashorn (ES5.1) at config load.** No ES2017 trailing commas in `k8s/curity/procedures/*.js` (the `.prettierrc` override pins those files to `trailingComma: "none"` — do not override it). A syntax error CrashLoops Curity.
- **Secrets are NEVER inline in workload YAML.** Credential-shaped values go out-of-band via `make seed-*` / `kubectl create secret`.
- **`packages/auth-curity` owns all Curity rules** (issuer/audience/JWKS/exchange). The shim consumes it; it must not re-implement exchange logic.
- **The Curity configmap (`k8s/curity/configmap.yaml`) is a positionally-significant XML export.** Prefer small additive edits.
- **SPIFFE trust domain is `demo.curity.local`;** the SVID file is `/run/spiffe/curity-actor.jwt`; `ClusterSPIFFEID.spec.className` MUST be `spire-spire`.
- **macOS bash is 3.2** (no `declare -A`) for any shell scripting.

---

### Task 1: exchange-shim service (RFC 8693 with gateway SVID as actor)

**Files:**
- Create: `apps/exchange-shim/package.json`
- Create: `apps/exchange-shim/tsconfig.json`
- Create: `apps/exchange-shim/src/config.ts`
- Create: `apps/exchange-shim/src/exchange-handler.ts`
- Create: `apps/exchange-shim/src/server.ts`
- Test: `apps/exchange-shim/tests/exchange-handler.test.ts`

**Interfaces:**
- Consumes: `exchangeToken` from `@ai-agents-demo/auth-curity` with signature
  `exchangeToken({ tokenEndpoint: string; clientId: string; clientSecret?: string; subjectToken: string; actorToken: string; audience: string; scope: string }): Promise<{ accessToken: string; tokenType: string; expiresInSec: number; scope: string; issuedTokenType: string }>`;
  `SpiffeJwtSvidSource` from `@ai-agents-demo/spiffe`, constructed as
  `new SpiffeJwtSvidSource({ audiences: [{ audience: string; filePath: string }] })` with `await source.getSvid(audience): Promise<{ jwt: string; audience: string } | null>`.
- Produces: `handleExchange(req: ExchangeRequest, deps: HandlerDeps): Promise<ExchangeResponse>` where
  `ExchangeRequest = { callerToken: string; targetAudience: string; targetScope: string }`,
  `ExchangeResponse = { access_token: string; token_type: string; expires_in: number }` (token-endpoint-shaped so agentgateway reads `json(response.body).access_token`),
  and `HandlerDeps = { getSvidJwt: () => Promise<string>; exchange: typeof exchangeToken; tokenEndpoint: string; clientId: string; clientSecret: string; audienceScopes: Record<string, string> }`.

- [ ] **Step 1: Scaffold the workspace package**

Create `apps/exchange-shim/package.json`:

```json
{
  "name": "@ai-agents-demo/exchange-shim",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@ai-agents-demo/auth-curity": "workspace:*",
    "@ai-agents-demo/spiffe": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

Create `apps/exchange-shim/tsconfig.json` (copy the shape of `apps/mcp-ops/tsconfig.json`):

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

Run: `pnpm install`
Expected: installs, links workspace deps.

- [ ] **Step 2: Write the failing test**

Create `apps/exchange-shim/tests/exchange-handler.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { handleExchange } from '../src/exchange-handler.js';

const deps = {
  getSvidJwt: vi.fn(async () => 'svid.jwt.compact'),
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  clientId: 'mcp-gateway',
  clientSecret: 'Password1',
  audienceScopes: { 'mcp-observability': 'obs:read', 'mcp-ops': 'ops:write' },
  exchange: vi.fn(async () => ({
    accessToken: 'narrowed.token',
    tokenType: 'Bearer',
    expiresInSec: 300,
    scope: 'obs:read',
    issuedTokenType: 'urn:ietf:params:oauth:token-type:access_token',
  })),
};

describe('handleExchange', () => {
  it('exchanges caller token using the SVID as actor and returns a token-endpoint body', async () => {
    const res = await handleExchange(
      { callerToken: 'caller.token', targetAudience: 'mcp-observability', targetScope: 'obs:read' },
      deps,
    );
    expect(deps.exchange).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'mcp-gateway',
        clientSecret: 'Password1',
        subjectToken: 'caller.token',
        actorToken: 'svid.jwt.compact',
        audience: 'mcp-observability',
        scope: 'obs:read',
      }),
    );
    expect(res).toEqual({ access_token: 'narrowed.token', token_type: 'Bearer', expires_in: 300 });
  });

  it('rejects an audience not in the allow-list', async () => {
    await expect(
      handleExchange(
        { callerToken: 'c', targetAudience: 'evil', targetScope: 'obs:read' },
        deps,
      ),
    ).rejects.toThrow(/audience/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @ai-agents-demo/exchange-shim test`
Expected: FAIL — `handleExchange` not found.

- [ ] **Step 4: Implement the handler**

Create `apps/exchange-shim/src/exchange-handler.ts`:

```typescript
import type { exchangeToken } from '@ai-agents-demo/auth-curity';

export interface ExchangeRequest {
  callerToken: string;
  targetAudience: string;
  targetScope: string;
}

export interface ExchangeResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface HandlerDeps {
  getSvidJwt: () => Promise<string>;
  exchange: typeof exchangeToken;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** Allow-list: audience -> the single scope the gateway may request for it. */
  audienceScopes: Record<string, string>;
}

export async function handleExchange(
  req: ExchangeRequest,
  deps: HandlerDeps,
): Promise<ExchangeResponse> {
  const allowedScope = deps.audienceScopes[req.targetAudience];
  if (!allowedScope) {
    throw new Error(`audience not allowed: ${req.targetAudience}`);
  }
  const actorToken = await deps.getSvidJwt();
  const result = await deps.exchange({
    tokenEndpoint: deps.tokenEndpoint,
    clientId: deps.clientId,
    clientSecret: deps.clientSecret,
    subjectToken: req.callerToken,
    actorToken,
    audience: req.targetAudience,
    scope: req.targetScope || allowedScope,
  });
  return {
    access_token: result.accessToken,
    token_type: result.tokenType,
    expires_in: result.expiresInSec,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @ai-agents-demo/exchange-shim test`
Expected: PASS (2 tests).

- [ ] **Step 6: Add config loader**

Create `apps/exchange-shim/src/config.ts`:

```typescript
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export interface Config {
  port: number;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  svidFile: string;
  svidAudience: string;
  audienceScopes: Record<string, string>;
}

export function loadConfig(): Config {
  return {
    port: Number(process.env.PORT ?? 8090),
    tokenEndpoint: required('CURITY_TOKEN_ENDPOINT'),
    clientId: process.env.GATEWAY_CLIENT_ID ?? 'mcp-gateway',
    clientSecret: required('CURITY_CLIENT_SECRET'),
    svidFile: process.env.SPIFFE_SVID_PATH ?? '/run/spiffe/curity-actor.jwt',
    svidAudience: process.env.SVID_AUDIENCE ?? 'https://curity.localtest.me/oauth/v2/oauth-token',
    audienceScopes: { 'mcp-observability': 'obs:read', 'mcp-ops': 'ops:write' },
  };
}
```

- [ ] **Step 7: Add the HTTP server**

Create `apps/exchange-shim/src/server.ts`:

```typescript
import { createServer } from 'node:http';
import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { loadConfig } from './config.js';
import { handleExchange } from './exchange-handler.js';

const cfg = loadConfig();
const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: cfg.svidAudience, filePath: cfg.svidFile }],
});

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200).end('ok');
    return;
  }
  if (req.method !== 'POST' || req.url !== '/exchange') {
    res.writeHead(404).end();
    return;
  }
  const callerAuth = req.headers['x-caller-authorization'];
  const targetAudience = req.headers['x-target-audience'];
  const targetScope = req.headers['x-target-scope'];
  if (typeof callerAuth !== 'string' || typeof targetAudience !== 'string') {
    res.writeHead(400).end(JSON.stringify({ error: 'invalid_request' }));
    return;
  }
  const callerToken = callerAuth.replace(/^Bearer\s+/i, '');
  handleExchange(
    { callerToken, targetAudience, targetScope: typeof targetScope === 'string' ? targetScope : '' },
    {
      getSvidJwt: async () => {
        const svid = await svidSource.getSvid(cfg.svidAudience);
        if (!svid) throw new CurityAuthError(`SVID not available at ${cfg.svidFile}`, 'invalid_actor');
        return svid.jwt;
      },
      exchange: exchangeToken,
      tokenEndpoint: cfg.tokenEndpoint,
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      audienceScopes: cfg.audienceScopes,
    },
  )
    .then((body) => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    })
    .catch((e) => {
      res.writeHead(403, { 'content-type': 'application/json' }).end(
        JSON.stringify({ error: 'exchange_failed', error_description: (e as Error).message }),
      );
    });
});

server.listen(cfg.port, () => console.log(`exchange-shim on :${cfg.port}`));
```

- [ ] **Step 8: Typecheck + build**

Run: `pnpm --filter @ai-agents-demo/exchange-shim typecheck && pnpm --filter @ai-agents-demo/exchange-shim build`
Expected: no errors; `dist/` emitted.

- [ ] **Step 9: Commit**

```bash
git add apps/exchange-shim pnpm-lock.yaml
git commit -m "feat(exchange-shim): SPIFFE-aware RFC 8693 exchange service for the MCP gateway"
```

---

### Task 2: exchange-shim container image + build wiring

**Files:**
- Create: `apps/exchange-shim/Dockerfile`
- Modify: `Makefile:43` (`IMAGE_NAMES`)

**Interfaces:**
- Produces: image `ai-agents-demo/exchange-shim:dev` listening on `:8090`, reading the SVID from `/run/spiffe/curity-actor.jwt`.

- [ ] **Step 1: Write the Dockerfile**

Create `apps/exchange-shim/Dockerfile` (mirrors `apps/mcp-ops/Dockerfile`; no otel-bootstrap needed):

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:20-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/auth-curity/package.json packages/auth-curity/
COPY packages/spiffe/package.json packages/spiffe/
COPY apps/exchange-shim/package.json apps/exchange-shim/
RUN pnpm install --frozen-lockfile=false --filter "@ai-agents-demo/exchange-shim..."
COPY packages/auth-curity packages/auth-curity
COPY packages/spiffe packages/spiffe
COPY apps/exchange-shim apps/exchange-shim
RUN pnpm --filter "@ai-agents-demo/auth-curity" build \
 && pnpm --filter "@ai-agents-demo/spiffe" build \
 && pnpm --filter "@ai-agents-demo/exchange-shim" build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/exchange-shim
EXPOSE 8090
USER node
CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Add to the image build list**

In `Makefile` line 43, append `exchange-shim` to `IMAGE_NAMES`:

```makefile
IMAGE_NAMES ?= mcp-observability mcp-ops ops-api obs-api agent-copilot agent-specialist web exchange-shim
```

(Verify the current value first with `rg -n "IMAGE_NAMES" Makefile`; append `exchange-shim`, do not drop existing names — `web` may or may not already be present.)

- [ ] **Step 3: Build the image**

Run: `docker build -t ai-agents-demo/exchange-shim:dev -f apps/exchange-shim/Dockerfile .`
Expected: build succeeds; final stage `runtime`.

- [ ] **Step 4: Commit**

```bash
git add apps/exchange-shim/Dockerfile Makefile
git commit -m "build(exchange-shim): container image + add to make images"
```

---

### Task 3: Grow the act-chains by the gateway position

**Files:**
- Modify: `apps/mcp-ops/src/config.ts:41`
- Modify: `apps/obs-api/src/config.ts:33-42`
- Modify: `apps/ops-api/src/config.ts` (the `expectedActorChain` array)
- Test: `apps/obs-api/tests/config.test.ts`, `apps/ops-api/tests/config.test.ts`, `apps/mcp-ops/tests/auth-middleware.test.ts`

**Interfaces:**
- Consumes: existing `SPIFFE_ID(ns, sa)` / `SPIFFE_AGENT(name)` regex helpers in each config.
- Produces: the gateway SPIFFE ID `spiffe://demo.curity.local/ns/mcp/sa/agentgateway` inserted immediately after the MCP-server position (or first, for mcp-ops) in each chain.

- [ ] **Step 1: Write/extend the failing test — obs-api**

In `apps/obs-api/tests/config.test.ts`, add (adapt to the file's existing import of `loadConfig`):

```typescript
it('accepts the agentgateway position in both read chains', () => {
  const cfg = loadConfig();
  const gw = 'spiffe://demo.curity.local/ns/mcp/sa/agentgateway';
  // Path A: [obs-mcp, gateway, copilot]
  expect(cfg.expectedActorChains[0][1].test(gw)).toBe(true);
  expect(cfg.expectedActorChains[0].length).toBe(3);
  // Path B: [obs-mcp, gateway, specialist, copilot]
  expect(cfg.expectedActorChains[1][1].test(gw)).toBe(true);
  expect(cfg.expectedActorChains[1].length).toBe(4);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @ai-agents-demo/obs-api test -- config`
Expected: FAIL — chains are still length 2/3.

- [ ] **Step 3: Edit obs-api chains**

In `apps/obs-api/src/config.ts`, replace the `expectedActorChains` array (lines 33-42) with:

```typescript
    expectedActorChains: [
      // Read path A: [mcp-observability, agentgateway, agent-copilot]
      [
        SPIFFE_ID('mcp', 'mcp-observability'),
        SPIFFE_ID('mcp', 'agentgateway'),
        SPIFFE_ID('agents', 'agent-copilot'),
      ],
      // Read path B: [mcp-observability, agentgateway, agent-specialist, agent-copilot]
      [
        SPIFFE_ID('mcp', 'mcp-observability'),
        SPIFFE_ID('mcp', 'agentgateway'),
        SPIFFE_ID('agents', 'agent-specialist'),
        SPIFFE_ID('agents', 'agent-copilot'),
      ],
    ],
```

Also update the doc comment at lines 9-10 to reflect the inserted `agentgateway` position.

- [ ] **Step 4: Run to verify obs-api passes**

Run: `pnpm --filter @ai-agents-demo/obs-api test -- config`
Expected: PASS.

- [ ] **Step 5: Edit ops-api chain + test**

In `apps/ops-api/src/config.ts`, change `expectedActorChain` to:

```typescript
    expectedActorChain: [
      SPIFFE_ID('mcp', 'mcp-ops'),
      SPIFFE_ID('mcp', 'agentgateway'),
      SPIFFE_ID('agents', 'agent-specialist'),
      SPIFFE_ID('agents', 'agent-copilot'),
    ],
```

In `apps/ops-api/tests/config.test.ts` add:

```typescript
it('includes agentgateway as the second chain position', () => {
  const cfg = loadConfig();
  expect(cfg.expectedActorChain.length).toBe(4);
  expect(cfg.expectedActorChain[1].test('spiffe://demo.curity.local/ns/mcp/sa/agentgateway')).toBe(true);
});
```

Run: `pnpm --filter @ai-agents-demo/ops-api test -- config`
Expected: PASS.

- [ ] **Step 6: Edit mcp-ops chain**

In `apps/mcp-ops/src/config.ts` line 41, the chain uses `SPIFFE_AGENT` (agents-ns only). The gateway is in the `mcp` ns, so introduce a general helper alongside it. Add near the existing `SPIFFE_AGENT`:

```typescript
const SPIFFE_ID = (ns: string, sa: string): RegExp =>
  new RegExp(`^spiffe://demo\\.curity\\.local/ns/${ns}/sa/${sa}$`);
```

Then change `expectedActorChain` to:

```typescript
    expectedActorChain: [
      SPIFFE_ID('mcp', 'agentgateway'),
      SPIFFE_AGENT('agent-specialist'),
      SPIFFE_AGENT('agent-copilot'),
    ],
```

- [ ] **Step 7: Update mcp-ops middleware test**

In `apps/mcp-ops/tests/auth-middleware.test.ts`, find the fixture that builds an accepted `act` chain (search for `agent-specialist`) and prepend an `agentgateway` (`ns/mcp/sa/agentgateway`) actor as the outermost/most-recent position so the depth-3 chain becomes depth-4. Run:

Run: `pnpm --filter @ai-agents-demo/mcp-ops test`
Expected: PASS (chain now expects the gateway position).

- [ ] **Step 8: Full typecheck**

Run: `pnpm turbo run build typecheck --filter=@ai-agents-demo/obs-api --filter=@ai-agents-demo/ops-api --filter=@ai-agents-demo/mcp-ops`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/obs-api apps/ops-api apps/mcp-ops
git commit -m "feat(resource-servers): insert agentgateway position into act-chains"
```

---

### Task 4: Curity — gateway client, policy, and agent retargeting

**Files:**
- Modify: `k8s/curity/procedures/token-exchange.js` (the `CLIENT_POLICY` object, lines ~59-92)
- Modify: `k8s/curity/configmap.yaml` (add the `mcp-gateway` client, additive)

**Interfaces:**
- Produces: Curity accepts `audience=mcp-gateway` from the two agents, and accepts `audience` in `{mcp-observability, mcp-ops}` from client `mcp-gateway` when the actor is `spiffe://demo.curity.local/ns/mcp/sa/agentgateway`.

- [ ] **Step 1: Retarget the agents + add the gateway policy**

In `k8s/curity/procedures/token-exchange.js`, edit `CLIENT_POLICY`. **No trailing commas** (Nashorn). Set copilot and specialist to exchange to `mcp-gateway`, and add the gateway entry:

```javascript
  'https://copilot.localtest.me/.well-known/oauth-client': {
    perAudience: {
      'mcp-gateway': { scopes: ['obs:read'] },
      'agent-specialist': { scopes: ['obs:read', 'ops:write'] }
    },
    allowedActors: [/^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-copilot$/]
  },
  'https://specialist.localtest.me/.well-known/oauth-client': {
    perAudience: {
      'mcp-gateway': { scopes: ['obs:read', 'ops:write'] }
    },
    allowedActors: [/^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-specialist$/]
  },
  // agentgateway: confidential client fanning out to the two MCP backends,
  // narrowing the broad aud=mcp-gateway caller token per tool-target.
  'mcp-gateway': {
    perAudience: {
      'mcp-observability': { scopes: ['obs:read'] },
      'mcp-ops': { scopes: ['ops:write'] }
    },
    allowedActors: [/^spiffe:\/\/demo\.curity\.local\/ns\/mcp\/sa\/agentgateway$/]
  },
```

Keep the existing `mcp-ops` and `mcp-observability` entries (MCP→API hops) unchanged.

- [ ] **Step 2: Syntax-check the procedure (ES5.1)**

Run: `node --check k8s/curity/procedures/token-exchange.js`
Expected: no output (valid). NOTE: `node --check` does NOT catch ES2017 trailing commas; visually confirm none were added in function calls/args.

- [ ] **Step 3: Add the `mcp-gateway` client to the configmap**

In `k8s/curity/configmap.yaml`, locate the existing `<client>` block for `mcp-ops` (search `<id>mcp-ops</id>`). Copy it as a sibling `<client>` with `<id>mcp-gateway</id>`, `client_secret_basic` auth, the same `token-exchange` capability/grant, and `obs:read`/`ops:write` in its allowed scopes + `mcp-observability`/`mcp-ops` in its allowed audiences. Keep the secret as the committed demo hash (same `Password1` crypt the other MCP clients use). Make it a purely additive insertion; do not reorder surrounding elements.

- [ ] **Step 4: Verify the XML is well-formed**

Extract the XML-valued configmap key and validate with `xmllint` (do NOT use Python's
stdlib `xml.etree`/`minidom` — they are XXE/billion-laughs vulnerable by default):

Run: `yq '.data | to_entries | .[] | select(.value|test("^\\s*<")) | .value' k8s/curity/configmap.yaml | xmllint --noout - && echo OK`
Expected: `OK` (the XML-valued configmap payload parses). `xmllint` does not expand
external entities here; if a specific key must be isolated, `yq '.data["<key>"]' … | xmllint --noout -`.

- [ ] **Step 5: Commit**

```bash
git add k8s/curity/procedures/token-exchange.js k8s/curity/configmap.yaml
git commit -m "feat(curity): add mcp-gateway client + retarget agents to aud=mcp-gateway"
```

---

### Task 5: agentgateway config (federation + JWT + per-tool RBAC + extAuthz→shim)

**Files:**
- Create: `k8s/workloads/agentgateway-config.yaml` (the agentgateway `config.yaml`, later mounted via ConfigMap)
- Create: `scratchpad/agentgateway-local/` (throwaway local validation harness — not committed)

**Interfaces:**
- Produces: an agentgateway config exposing one MCP listener on `:8080` federating targets `observability` (→ `mcp-observability.mcp.svc.cluster.local:8080/mcp`) and `ops` (→ `mcp-ops.mcp.svc.cluster.local:8080/mcp`), validating `aud=mcp-gateway`, applying per-tool RBAC, and driving the shim at `http://localhost:8090/exchange` via `extAuthz`.

- [ ] **Step 1: VALIDATION SPIKE — is the `mcp` CEL context available inside `extAuthz`?**

This decides federation vs. path-routing (spec Risk 1). Run agentgateway locally against a stub. In `scratchpad/agentgateway-local/`:

Install the binary: `curl -sL https://agentgateway.dev/install | bash` (or `docker run` the image).
Write a minimal config with one MCP listener, two stdio targets (`npx @modelcontextprotocol/server-everything` twice under names `observability`/`ops`), and an `extAuthz` whose `addRequestHeaders` sets `x-target-audience: '(mcp.tool.target == "ops") ? "mcp-ops" : "mcp-observability"'`. Point `extAuthz.host` at a netcat/echo server that logs received headers.

Run: start agentgateway, issue an MCP `tools/call`, inspect the echo server log.
Expected outcome A (mcp context available): the echo server receives `x-target-audience: mcp-ops` for an ops tool → **use the federated single-endpoint design (Step 2a)**.
Expected outcome B (mcp context NOT available / errors on `mcp.*`): → **use the path-routed fallback (Step 2b)**.

Record the outcome as a comment at the top of `k8s/workloads/agentgateway-config.yaml`.

- [ ] **Step 2a: Write the federated config (if Outcome A)**

Create `k8s/workloads/agentgateway-config.yaml`. Note: schema field names are confirmed against `https://agentgateway.dev/schema/config` and the `backend-oauth`/`mcp-authz` examples while writing; the structure below is the target shape:

```yaml
# yaml-language-server: $schema=https://agentgateway.dev/schema/config
# Spike outcome (Task 5 Step 1): mcp context IS available in extAuthz -> federated.
binds:
- port: 8080
  listeners:
  - name: mcp
    protocol: HTTP
    routes:
    - name: mcp-federated
      matches:
      - path:
          pathPrefix: /mcp
      policies:
        mcpAuthentication:
          issuer: https://curity.localtest.me/oauth/v2/oauth-anonymous
          audiences:
          - mcp-gateway
          jwks:
            url: http://curity.curity.svc.cluster.local:8443/oauth/v2/oauth-anonymous/jwks
        mcpAuthorization:
          rules:
          # Equivalence: any authenticated caller may use the read tools + the safe write tools.
          - 'mcp.tool.name in ["list_pods", "get_pod_logs", "get_deployment", "restart_deployment", "scale_deployment"]'
          # Showcase: set_deployment_image requires an extra claim the base role lacks
          # (filtered from tools/list AND denied on call_tool when absent). Adjust the
          # claim to whatever the demo's privileged path carries, e.g. a role or scope.
          - 'mcp.tool.name == "set_deployment_image" && "ops:write" in (jwt.scope.split(" "))'
        extAuthz:
          host: localhost:8090
          cache:
            key:
            - request.headers["authorization"]
            - (mcp.tool.target == "ops") ? "ops" : "obs"
            ttl: extauthz.expires - 5
            maxEntries: 1024
          protocol:
            http:
              path: '"/exchange"'
              addRequestHeaders:
                :method: '"POST"'
                x-caller-authorization: request.headers["authorization"]
                x-target-audience: '(mcp.tool.target == "ops") ? "mcp-ops" : "mcp-observability"'
                x-target-scope: '(mcp.tool.target == "ops") ? "ops:write" : "obs:read"'
              metadata:
                token: json(response.body).access_token
                expires: unvalidatedJwtPayload(json(response.body).access_token).exp
        transformations:
          request:
            set:
              authorization: '"Bearer " + extauthz.token'
      mcp:
        targets:
        - name: observability
          mcp:
            host: mcp-observability.mcp.svc.cluster.local:8080
            path: /mcp
        - name: ops
          mcp:
            host: mcp-ops.mcp.svc.cluster.local:8080
            path: /mcp
```

- [ ] **Step 2b: Write the path-routed fallback (if Outcome B)**

Instead of one federated route, define two routes on the same listener (`/observability/mcp`, `/ops/mcp`), each with its own `mcp.targets` single entry and a **static** `x-target-audience`/`x-target-scope` in `extAuthz.addRequestHeaders` (no `mcp.*`). The per-tool `set_deployment_image` rule stays on the `/ops/mcp` route's `mcpAuthorization`. Record in the file header that federation degraded to path-routing and why.

- [ ] **Step 3: Re-run the local harness end-to-end**

Point the local agentgateway at the real shim (`node apps/exchange-shim/dist/server.js` with test env) and a stub token endpoint that echoes a signed JWT. Issue `tools/list` and `tools/call`.
Expected: `tools/list` for a token WITHOUT `ops:write` omits `set_deployment_image`; a `call_tool` to a read tool triggers one `extAuthz` POST to `/exchange` with the correct `x-target-audience`.

- [ ] **Step 4: Commit**

```bash
git add k8s/workloads/agentgateway-config.yaml
git commit -m "feat(agentgateway): federated MCP config with JWT, per-tool RBAC, extAuthz->shim"
```

---

### Task 6: agentgateway Kubernetes workload

**Files:**
- Create: `k8s/workloads/agentgateway.yaml` (SA, ConfigMap from Task 5 config, Deployment with 3 containers + spiffe-helper, Service)
- Create: `k8s/spire/identities/agentgateway.yaml` (ClusterSPIFFEID)
- Modify: `Makefile` (add `seed-gateway-secret` target; fold into `seed-secrets`)
- Modify: `scripts/cluster-routing.sh` (hostAlias + mkcert CA for the gateway pod)

**Interfaces:**
- Consumes: image `ai-agents-demo/exchange-shim:dev` (Task 2); the agentgateway config (Task 5); the gateway client secret Secret `agentgateway-curity` (`CURITY_CLIENT_SECRET`).
- Produces: Service `agentgateway.mcp.svc.cluster.local:8080` with path `/mcp`; SVID `spiffe://demo.curity.local/ns/mcp/sa/agentgateway`.

- [ ] **Step 1: ClusterSPIFFEID**

Create `k8s/spire/identities/agentgateway.yaml` (mirror `k8s/spire/identities/agent-specialist.yaml`):

```yaml
apiVersion: spire.spiffe.io/v1alpha1
kind: ClusterSPIFFEID
metadata:
  name: agentgateway
spec:
  className: spire-spire
  spiffeIDTemplate: 'spiffe://{{ .TrustDomain }}/ns/{{ .PodMeta.Namespace }}/sa/{{ .PodSpec.ServiceAccountName }}'
  podSelector:
    matchLabels:
      app: agentgateway
  namespaceSelector:
    matchLabels:
      kubernetes.io/metadata.name: mcp
  jwtTtl: 5m
```

- [ ] **Step 2: The workload manifest**

Create `k8s/workloads/agentgateway.yaml`. Structure (mirror `agent-specialist.yaml`'s SA + spiffe-helper ConfigMap + volumes pattern):
- `ServiceAccount agentgateway` in ns `mcp`.
- `ConfigMap agentgateway-spiffe-helper` — identical to the specialist's `spiffe-helper.conf` (audience `https://curity.localtest.me/oauth/v2/oauth-token`, file `/run/spiffe/curity-actor.jwt`).
- `ConfigMap agentgateway-config` — `config.yaml` = the contents of `k8s/workloads/agentgateway-config.yaml` (Task 5). (During `make apply`, generate this ConfigMap from that file; do not hand-duplicate — see Step 5.)
- `Deployment agentgateway` with `serviceAccountName: agentgateway`, `app: agentgateway` label, volumes `spiffe-workload-api` (csi), `spiffe-svids` (emptyDir memory), `spiffe-helper-config`, `gateway-config`; containers:
  - `agentgateway` — image `ghcr.io/agentgateway/agentgateway:latest` (pin the digest/tag actually used), args `["-f", "/etc/agentgateway/config.yaml"]`, mount `gateway-config` at `/etc/agentgateway`, port `8080`, `readinessProbe` GET `/mcp` or the gateway's health path.
  - `exchange-shim` — image `ai-agents-demo/exchange-shim:dev`, port `8090`, mount `spiffe-svids` at `/run/spiffe` readOnly, env `CURITY_TOKEN_ENDPOINT=https://curity.localtest.me/oauth/v2/oauth-token`, `GATEWAY_CLIENT_ID=mcp-gateway`, `SPIFFE_SVID_PATH=/run/spiffe/curity-actor.jwt`, `envFrom` secret `agentgateway-curity`; `readinessProbe` GET `/healthz` on 8090.
  - `spiffe-helper` — image `ghcr.io/spiffe/spiffe-helper:0.11.0`, args `["-config", "/etc/spiffe-helper/spiffe-helper.conf"]`, mounts as in the specialist, `securityContext.runAsUser: 1000`.
- `Service agentgateway` in ns `mcp`, selector `app: agentgateway`, port `8080` → `8080`.

**Do NOT** add the `istio.io/use-waypoint` label (the waypoint is being removed in Task 7).

- [ ] **Step 3: Seed the gateway client secret (Makefile)**

Add to `Makefile` (mirror `seed-mcp-ops-secret`):

```makefile
.PHONY: seed-gateway-secret
seed-gateway-secret: ## Seed the agentgateway client secret (fixed demo value "Password1")
	@kubectl create namespace $(NS_MCP) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_MCP) create secret generic agentgateway-curity \
	    --from-literal=CURITY_CLIENT_SECRET=Password1 \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_MCP),agentgateway)
```

Add `seed-gateway-secret` to the `seed-secrets` target's prerequisite list (line ~333).

- [ ] **Step 4: Gateway pod → Curity routing**

In `scripts/cluster-routing.sh`, add the `agentgateway` deployment (ns `mcp`) to whatever loop patches the `curity.localtest.me` → istio-ingress `hostAlias` and mounts the mkcert root CA (`NODE_EXTRA_CA_CERTS`) into backend app pods. It needs both: the shim calls `https://curity.localtest.me/oauth/v2/oauth-token`, so it must resolve the host AND trust the edge TLS. Follow the existing per-namespace pattern (macOS bash 3.2 — no associative arrays).

- [ ] **Step 5: Wire config ConfigMap generation into `make apply`**

Ensure `make apply` creates/updates `agentgateway-config` from `k8s/workloads/agentgateway-config.yaml` (e.g. `kubectl -n mcp create configmap agentgateway-config --from-file=config.yaml=k8s/workloads/agentgateway-config.yaml --dry-run=client -o yaml | kubectl apply -f -`), and applies `k8s/workloads/agentgateway.yaml` + `k8s/spire/identities/agentgateway.yaml`. Add these to the apply target/kustomization the same way sibling workloads are wired.

- [ ] **Step 6: Verify (needs a cluster)**

Run: `make images apply routing status`
Expected: `agentgateway` pod `Running` (3/3 containers ready); `make routing-check` passes; the SVID file exists in the shim container:
`kubectl -n mcp exec deploy/agentgateway -c exchange-shim -- sh -c 'test -s /run/spiffe/curity-actor.jwt && echo SVID-OK'` → `SVID-OK`.

- [ ] **Step 7: Commit**

```bash
git add k8s/workloads/agentgateway.yaml k8s/spire/identities/agentgateway.yaml Makefile scripts/cluster-routing.sh
git commit -m "feat(k8s): agentgateway workload (gateway + shim + spiffe-helper) in mcp ns"
```

---

### Task 7: Repoint agents at the gateway; remove the Istio waypoint

**Files:**
- Modify: `k8s/workloads/agent-copilot.yaml` (MCP env)
- Modify: `k8s/workloads/agent-specialist.yaml` (MCP env)
- Delete: `k8s/istio/mcp-l7-authz.yaml`
- Modify: `k8s/workloads/mcp-observability.yaml`, `k8s/workloads/mcp-ops.yaml` (strip `istio.io/use-waypoint`)
- Modify: whatever kustomization/apply list references `mcp-l7-authz.yaml`

**Interfaces:**
- Consumes: Service `agentgateway.mcp.svc.cluster.local:8080/mcp` (Task 6).
- Produces: both agents call the gateway with `aud=mcp-gateway`; the waypoint no longer exists.

- [ ] **Step 1: Repoint agent-copilot**

In `k8s/workloads/agent-copilot.yaml`, set:
- `MCP_OBSERVABILITY_URL` → `http://agentgateway.mcp.svc.cluster.local:8080/mcp`
- `MCP_OBSERVABILITY_AUDIENCE` → `mcp-gateway`
- keep `MCP_OBSERVABILITY_SCOPE` = `obs:read`.

- [ ] **Step 2: Repoint agent-specialist**

In `k8s/workloads/agent-specialist.yaml`, set BOTH MCP URLs to the gateway and BOTH audiences to `mcp-gateway`:
- `MCP_OPS_URL` and `MCP_OBSERVABILITY_URL` → `http://agentgateway.mcp.svc.cluster.local:8080/mcp`
- `MCP_OPS_AUDIENCE` → `mcp-gateway`, `MCP_OBSERVABILITY_AUDIENCE` → `mcp-gateway`
- keep scopes `ops:write` / `obs:read`.

(The specialist now mints a single `aud=mcp-gateway` token per call; the gateway narrows per tool. `MCP_OPS_RESOURCE_METADATA_URL` for step-up challenges is unaffected — the 401 still originates from mcp-ops/ops-api and passes back through the gateway.)

- [ ] **Step 3: Remove the waypoint**

```bash
git rm k8s/istio/mcp-l7-authz.yaml
```

In `k8s/workloads/mcp-observability.yaml` and `k8s/workloads/mcp-ops.yaml`, remove the `istio.io/use-waypoint: mcp-waypoint` label from the Service metadata. Remove any reference to `mcp-l7-authz.yaml` from the apply/kustomize list.

- [ ] **Step 4: Verify (needs a cluster)**

Run: `make apply routing status`
Expected: agents `Running`; `kubectl -n mcp get gateway` no longer lists `mcp-waypoint`; `kubectl get authorizationpolicy -n mcp` no longer lists the mcp-ops/observability policies.

- [ ] **Step 5: Commit**

```bash
git add k8s/workloads/agent-copilot.yaml k8s/workloads/agent-specialist.yaml k8s/workloads/mcp-observability.yaml k8s/workloads/mcp-ops.yaml
git commit -m "feat(k8s): route agents through agentgateway; remove Istio MCP waypoint"
```

---

### Task 8: End-to-end smoke assertions + docs

**Files:**
- Modify: `make smoke` target + its script (find via `rg -n "smoke" Makefile`)
- Modify: `docs/architecture.md`, `docs/design.md`
- Modify: `CLAUDE.md` (update the topology diagram + the fact about MCP L7 authz #21)

**Interfaces:**
- Consumes: the full deployed stack.
- Produces: smoke coverage of the new hop + tool filtering; docs reflecting reality.

- [ ] **Step 1: Extend the smoke test**

In the smoke script, add assertions:
1. **OBO read still works:** copilot read path returns pods (existing assertion should still pass with the gateway inserted).
2. **A2A write still works + step-up:** specialist write path still triggers the RFC 9470 challenge for a non-MFA session and succeeds for an MFA session (existing assertions pass unchanged through the gateway).
3. **New hop present:** hit copilot's `/last-token` (or ops-api trace) and assert the `act` chain now contains `…/ns/mcp/sa/agentgateway`.
4. **Per-tool filtering:** an MCP `tools/list` through the gateway with a base-role token omits `set_deployment_image`; with the privileged token it appears.

- [ ] **Step 2: Run the smoke suite (needs a cluster)**

Run: `make smoke`
Expected: all assertions pass, including the 4 new ones.

- [ ] **Step 3: Update the canonical docs**

- `docs/architecture.md`: redraw both OBO chains to include the agentgateway hop (`… → agentgateway →(exchange, act:+gateway) → mcp-observability/mcp-ops → …`); describe the shim and why it exists (agentgateway CEL can't read the rotating SVID).
- `docs/design.md`: add the `apps/exchange-shim` module, the `k8s/workloads/agentgateway*` deployment, the federated-endpoint decision, and the `mcp-gateway` audience/client.
- `CLAUDE.md`: replace fact #21 (Istio MCP waypoint) with the agentgateway topology; update the architecture ASCII diagram at the top (agents → agentgateway → MCP servers).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test(smoke): assert gateway hop + per-tool filtering; docs: agentgateway topology"
```

---

## Self-Review

**Spec coverage:**
- Replace waypoint → Task 7. ✅
- Federated endpoint (+ fallback) → Task 5 (Step 1 spike decides; 2a/2b). ✅
- Gateway as RFC 8693 hop → Tasks 1 (shim), 4 (Curity client/policy), 6 (SVID + deploy). ✅
- Exchange via SPIFFE shim → Tasks 1, 2, 6. ✅
- act-chain +1 (mcp-ops, obs-api, ops-api; mcp-observability untouched) → Task 3. ✅
- Equivalence + `set_deployment_image` showcase rule → Task 5 (`mcpAuthorization`). ✅
- Single `aud=mcp-gateway` token, gateway narrows per tool; role/step-up preserved → Tasks 4 + 7. ✅
- Routing/hostAlias, seed secret, ClusterSPIFFEID → Task 6. ✅
- Testing + rollback + docs → Task 8 (rollback = revert commits / re-add `mcp-l7-authz.yaml`). ✅

**Placeholder scan:** No `TBD`/`add error handling`-style gaps; the one genuinely unknown (schema field names for the agentgateway config, and mcp-context-in-extAuthz) is handled by an explicit spike (Task 5 Step 1) with both branches written, not left vague.

**Type consistency:** `handleExchange`/`HandlerDeps`/`ExchangeResponse` names are consistent across Task 1 steps and the server. `SPIFFE_ID(ns, sa)` helper is used uniformly for the gateway position; mcp-ops gains it explicitly (Task 3 Step 6) since it previously only had `SPIFFE_AGENT`. `exchangeToken` params match the verbatim signature read from `packages/auth-curity/src/exchange.ts`.

**Known residual risks (carried from spec, surfaced in tasks):** agentgateway config schema field names (`mcp.targets`, `mcpAuthentication`, `mcpAuthorization`, `extAuthz`) are the target shape from the docs/examples and MUST be reconciled against the pinned agentgateway version's `$schema` during Task 5; the local harness (Task 5 Steps 1/3) is where that reconciliation happens before touching the cluster.
