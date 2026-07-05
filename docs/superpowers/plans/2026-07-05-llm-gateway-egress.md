# Identity-bound LLM Egress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route both LLM agents' Azure OpenAI calls through `agentgateway` as an
LLM gateway, so the reasoning hop is identity-bound (user-on-behalf-of Curity
token), least-privilege (`aud=llm-gateway` + `scope=llm:invoke`), and the Azure
key lives only at the gateway.

**Architecture:** Each agent performs one RFC 8693 exchange (subject = user
token, actor = agent SPIFFE JWT-SVID) → `aud=llm-gateway`, `scope=llm:invoke`,
and calls the gateway's OpenAI-compatible `/llm` route. The gateway validates
the JWT, requires the scope, injects the Azure `api-key`, and forwards to Azure
via its `ai`/azure backend. No exchange-shim and no `act`-chain match on this
route (Azure is outside the Curity trust domain).

**Tech Stack:** TypeScript (pnpm 9.x / turbo), Vercel AI SDK (`@ai-sdk/openai`,
`@ai-sdk/anthropic`), agentgateway v1.3.1, Curity (token procedures in Nashorn
ES5.1), KIND/kubectl.

## Global Constraints

- **agentgateway is v1.3.1 / git dbaaf7ed.** Azure enum is `resourceType: openAI`
  (lowercase-o). Azure credential header is `api-key` with prefix `""` (NOT
  `Authorization: Bearer`). `backendAuth.key.value` supports `$ENV` interpolation.
- **All CEL in agentgateway YAML is single-quoted** (unquoted `A ? B : C` breaks
  YAML parsing).
- **Curity procedures are Nashorn ES5.1.** No ES2017 trailing commas. `.prettierrc`
  pins `k8s/curity/procedures/*.js` to `trailingComma: "none"` — do not re-add them.
- **Secrets never in committed YAML.** Azure creds are seeded out-of-band from
  `.demo.env` / `make seed-*`. The Curity configmap is a positionally-significant
  XML export — make small additive edits only.
- **All public hostnames use `*.localtest.me`.** In-cluster JWKS is the
  plain-HTTP Service DNS form `http://curity.curity.svc.cluster.local:8443/...`.
- **Build/verify:** `pnpm turbo run build typecheck test`; per-package
  `pnpm --filter <pkg> test`.
- **Commit messages end with:** `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

## File Structure

- `packages/agent-runtime/src/llm.ts` — `buildLlm` gains `gateway` mode + per-request token; drops `azure`.
- `packages/agent-runtime/src/llm.test.ts` — gateway-mode unit tests.
- `packages/agent-runtime/package.json` — add `@ai-sdk/openai`; drop `@ai-sdk/azure`.
- `apps/agent-copilot/src/llm-token.ts` — **new**; TTL-cached exchange → `aud=llm-gateway`.
- `apps/agent-copilot/src/{config.ts,server.ts}` — gateway config + per-request model build.
- `apps/agent-specialist/src/llm-token.ts` — **new**; same for the specialist.
- `apps/agent-specialist/src/{config.ts,executor.ts}` — gateway config + per-request model build via DI.
- `k8s/curity/configmap.yaml` — `llm:invoke` scope.
- `k8s/curity/procedures/token-exchange.js` — `llm-gateway` audience policy for both agents.
- `k8s/workloads/agentgateway-config.yaml` — `/llm` route.
- `k8s/workloads/agentgateway.yaml` — gateway pod gets `AZURE_OPENAI_*` env from Secret `agentgateway-llm`.
- `k8s/workloads/agent-copilot.yaml`, `agent-specialist.yaml` — remove Azure env; add `LLM_GATEWAY_*`.
- `Makefile` — `seed-secrets` seeds the gateway Secret; drops agent Azure seeding.
- `scripts/smoke.sh` (or the smoke target) — LLM egress beat.
- `CLAUDE.md`, `docs/architecture.md`, `docs/design.md`, `docs/demo.md` — governed LLM hop.

---

## Task 1: Spike — verify real Azure translation + resolve `resourceName` injection

**No app code.** De-risks the two open items against the real Azure endpoint
using `.demo.env` (already present; holds `AZURE_OPENAI_ENDPOINT` +
`AZURE_OPENAI_API_KEY`). Uses the pinned image
`ghcr.io/agentgateway/agentgateway@sha256:c3ce7b75da90fef70239befcc1c3adc05152d7b9dd21fcb8351178026a2c4381`.

**Files:**
- Create (scratch, not committed): `/tmp` config under the session scratchpad.
- Modify: `docs/superpowers/specs/2026-07-05-llm-gateway-egress-design.md` (mark open items resolved).

- [ ] **Step 1: Derive resourceName + write a no-auth Azure route config**

Source creds and extract the resource name from the endpoint host:

```bash
set -a; . ./.demo.env; set +a
# https://<resourceName>.openai.azure.com -> <resourceName>
AZ_RES=$(printf '%s' "$AZURE_OPENAI_ENDPOINT" | sed -E 's#https?://([^.]+)\..*#\1#')
echo "resourceName=$AZ_RES"
```

Write `spike.yaml` (no jwtAuth — isolate the Azure hop), literal resourceName first:

```yaml
binds:
- port: 8080
  listeners:
  - name: llm
    protocol: HTTP
    routes:
    - name: llm
      matches:
      - path: { pathPrefix: /llm }
      policies:
        backendAuth:
          key:
            value: $AZURE_OPENAI_API_KEY
            location: { header: { name: api-key, prefix: "" } }
      backends:
      - ai:
          name: azure
          provider:
            azure:
              resourceName: RESOURCE_PLACEHOLDER
              resourceType: openAI
              model: gpt-4.1
              apiVersion: "2024-04-01-preview"
```

- [ ] **Step 2: Run the gateway against real Azure and drive a streamed request**

```bash
sed "s/RESOURCE_PLACEHOLDER/$AZ_RES/" spike.yaml > spike.real.yaml
docker run --rm --name agw-azspike -p 8080:8080 \
  -e AZURE_OPENAI_API_KEY="$AZURE_OPENAI_API_KEY" \
  -v "$PWD":/cfg <PINNED_IMAGE> -f /cfg/spike.real.yaml &
sleep 4
curl -sN http://127.0.0.1:8080/llm/chat/completions -H content-type:application/json \
  -d '{"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"say hi in 3 words"}]}' | head -20
```

Expected: SSE `data: {...delta...}` chunks from real Azure, ending `data: [DONE]`.
Record the gateway log line (should show `protocol=llm gen_ai.* http.status=200`).
**If this fails**, STOP — the design's core assumption is broken; report findings.

- [ ] **Step 3: Determine whether `resourceName` accepts `$ENV`**

Re-run Step 2 but set `resourceName: $AZURE_RESOURCE_NAME` in the config and pass
`-e AZURE_RESOURCE_NAME="$AZ_RES"`. If the streamed completion still succeeds,
env-interpolation works (record: **ENV**). If the gateway logs a DNS/connect
error to a host containing a literal `$`, it does not (record: **TEMPLATE**).

- [ ] **Step 4: Tear down + record findings**

```bash
docker rm -f agw-azspike 2>/dev/null
```

Edit the spec's "Open items" section: replace item #1 with the verified outcome
(pass/fail + the exact path the client used), and item #2 with **ENV** or
**TEMPLATE**. Commit.

```bash
git add docs/superpowers/specs/2026-07-05-llm-gateway-egress-design.md
git commit -m "docs(llm-gateway): resolve spike open items (azure translation + resourceName)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `buildLlm` gateway mode (agent-runtime)

**Files:**
- Modify: `packages/agent-runtime/src/llm.ts`
- Modify: `packages/agent-runtime/src/llm.test.ts`
- Modify: `packages/agent-runtime/package.json`

**Interfaces:**
- Produces: `buildLlm(cfg: LlmConfig, opts?: { accessToken?: string }): LanguageModelV1`
  where `LlmConfig = { llmProvider: 'gateway' | 'anthropic' | 'ollama'; llmModel: string; llmGatewayUrl?: string }`.
  Gateway mode requires `opts.accessToken`.

- [ ] **Step 1: Add the `@ai-sdk/openai` dependency**

```bash
pnpm --filter @ai-agents-demo/agent-runtime add @ai-sdk/openai
pnpm --filter @ai-agents-demo/agent-runtime remove @ai-sdk/azure
```

- [ ] **Step 2: Rewrite the tests (gateway replaces azure)**

Replace the whole `describe('buildLlm', ...)` body in `llm.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildLlm, type LlmConfig } from './llm.js';

const gw: LlmConfig = {
  llmProvider: 'gateway',
  llmModel: 'gpt-4.1',
  llmGatewayUrl: 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
};

describe('buildLlm', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('builds an OpenAI-compatible model in gateway mode with an injected token', () => {
    const model = buildLlm(gw, { accessToken: 'tok-123' });
    expect(model).toBeDefined();
    expect(model.provider).toContain('openai');
  });

  it('throws in gateway mode when accessToken is missing', () => {
    expect(() => buildLlm(gw)).toThrow(/accessToken/);
  });

  it('throws in gateway mode when llmGatewayUrl is missing', () => {
    expect(() => buildLlm({ llmProvider: 'gateway', llmModel: 'gpt-4.1' }, { accessToken: 't' })).toThrow(
      /LLM_GATEWAY_URL/,
    );
  });

  it('builds an Anthropic model when provider=anthropic (direct, no token)', () => {
    const model = buildLlm({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-6' });
    expect(model.provider).toContain('anthropic');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test`
Expected: FAIL (gateway mode not implemented; azure symbols removed).

- [ ] **Step 4: Rewrite `llm.ts`**

```ts
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV1 } from 'ai';

export interface LlmConfig {
  llmProvider: 'gateway' | 'anthropic' | 'ollama';
  llmModel: string;
  /** Base URL of the agentgateway LLM route. Only used when llmProvider === 'gateway'. */
  llmGatewayUrl?: string;
}

export interface BuildLlmOptions {
  /** Per-request aud=llm-gateway bearer. Required in gateway mode. */
  accessToken?: string;
}

export function buildLlm(cfg: LlmConfig, opts: BuildLlmOptions = {}): LanguageModelV1 {
  if (cfg.llmProvider === 'anthropic') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when LLM_PROVIDER=anthropic');
    return createAnthropic({ apiKey })(cfg.llmModel);
  }

  if (cfg.llmProvider === 'gateway') {
    if (!cfg.llmGatewayUrl) throw new Error('LLM_GATEWAY_URL is required when LLM_PROVIDER=gateway');
    if (!opts.accessToken)
      throw new Error('buildLlm gateway mode requires a per-request accessToken (aud=llm-gateway)');
    // The AI SDK OpenAI provider POSTs to `${baseURL}/chat/completions` and sends the
    // apiKey as `Authorization: Bearer`. We pass the exchanged aud=llm-gateway JWT as
    // that bearer; the gateway validates it and swaps in the Azure api-key upstream.
    const openai = createOpenAI({ baseURL: cfg.llmGatewayUrl, apiKey: opts.accessToken });
    return openai(cfg.llmModel);
  }

  throw new Error('Ollama provider not yet wired. Set LLM_PROVIDER=gateway|anthropic.');
}
```

- [ ] **Step 5: Run tests + typecheck to verify they pass**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test && pnpm --filter @ai-agents-demo/agent-runtime typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-runtime
git commit -m "feat(agent-runtime): buildLlm gateway mode with per-request token

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Curity — `llm:invoke` scope + `llm-gateway` exchange policy

**Files:**
- Modify: `k8s/curity/configmap.yaml` (scopes block)
- Modify: `k8s/curity/procedures/token-exchange.js` (`CLIENT_POLICY`)

- [ ] **Step 1: Add the `llm:invoke` scope**

In `configmap.yaml`, find the `<scopes>` block (near line 192, alongside
`<scope><id>obs:read</id>` and `<scope><id>ops:write</id>`). Add, matching the
exact surrounding element style:

```xml
                <scope>
                  <id>llm:invoke</id>
                  <description>Invoke the LLM gateway on behalf of the user</description>
                </scope>
```

- [ ] **Step 2: Allow both agents to exchange to `aud=llm-gateway`**

In `token-exchange.js` `CLIENT_POLICY`, add the `llm-gateway` audience to BOTH
agent entries. No trailing commas (Nashorn). copilot entry becomes:

```js
'https://copilot.localtest.me/.well-known/oauth-client': {
  'mcp-gateway': { scopes: ['obs:read'] },
  'agent-specialist': { scopes: ['obs:read', 'ops:write'] },
  'llm-gateway': { scopes: ['llm:invoke'] }
},
```

specialist entry becomes:

```js
'https://specialist.localtest.me/.well-known/oauth-client': {
  'mcp-gateway': { scopes: ['obs:read', 'ops:write'] },
  'llm-gateway': { scopes: ['llm:invoke'] }
},
```

(Preserve the existing per-entry `audiencePolicies`/`allowedActors` structure —
match the exact keys already present; only add the one `llm-gateway` line each.)

- [ ] **Step 3: Syntax-check the procedure (ES5.1 discipline)**

Run: `node --check k8s/curity/procedures/token-exchange.js`
Expected: no output (exit 0). Confirm no trailing commas were introduced in
function calls/args.

- [ ] **Step 4: Commit**

```bash
git add k8s/curity/configmap.yaml k8s/curity/procedures/token-exchange.js
git commit -m "feat(curity): llm:invoke scope + llm-gateway exchange policy for both agents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: agentgateway `/llm` route + gateway Azure Secret + end-to-end gateway test

**Files:**
- Modify: `k8s/workloads/agentgateway-config.yaml` (new `/llm` route)
- Modify: `k8s/workloads/agentgateway.yaml` (Azure env from Secret `agentgateway-llm`)

**Interfaces:**
- Consumes: `llm:invoke` scope + `llm-gateway` exchange policy from Task 3.
- Produces: a governed `/llm` route reachable at
  `http://agentgateway.mcp.svc.cluster.local:8080/llm`.

- [ ] **Step 1: Add the `/llm` route to the gateway config**

In `agentgateway-config.yaml`, add a new route under the `mcp` listener's
`routes:` (after the `ops` route, before the DEMO-ONLY passthroughs). Use the
`resourceName` injection approach recorded in Task 1 — the block below uses the
**ENV** variant (`$AZURE_RESOURCE_NAME`); if Task 1 recorded **TEMPLATE**,
replace `resourceName: $AZURE_RESOURCE_NAME` with a literal
`resourceName: RESOURCE_PLACEHOLDER` and add the sed step in Task 7's seed target.

```yaml
    # ------------------------------------------------------------------ #
    # LLM egress -> {gateway}:8080/llm  (OpenAI-compatible; azure backend)
    # Identity-bound reasoning hop. jwtAuth(aud=llm-gateway) + require llm:invoke;
    # the gateway holds the ONLY Azure key (backendAuth.key). No shim, no act-chain:
    # Azure is outside the Curity trust domain — a single upstream credential swap.
    # ------------------------------------------------------------------ #
    - name: llm
      matches:
      - path:
          pathPrefix: /llm
      policies:
        jwtAuth:
          providers:
          - issuer: https://curity.localtest.me/oauth/v2/oauth-anonymous
            audiences:
            - llm-gateway
            jwks:
              url: http://curity.curity.svc.cluster.local:8443/oauth/v2/oauth-anonymous/jwks
        authorization:
          rules:
          - require: '"llm:invoke" in (jwt.scope.split(" "))'
        backendAuth:
          key:
            value: $AZURE_OPENAI_API_KEY
            location:
              header:
                name: api-key
                prefix: ""
      backends:
      - ai:
          name: azure
          provider:
            azure:
              resourceName: $AZURE_RESOURCE_NAME
              resourceType: openAI
              model: gpt-4.1
              apiVersion: "2024-04-01-preview"
```

- [ ] **Step 2: Validate the full config against the pinned binary**

```bash
docker run --rm -e AZURE_OPENAI_API_KEY=dummy -e AZURE_RESOURCE_NAME=dummy \
  -v "$PWD/k8s/workloads":/cfg <PINNED_IMAGE> -f /cfg/agentgateway-config.yaml --validate-only
```

Expected: `Configuration is valid!` (JWKS fetch will be skipped by validate-only;
if it attempts a fetch, that is acceptable — schema validity is the gate).

- [ ] **Step 3: Wire Azure env into the gateway pod**

In `agentgateway.yaml`, on the `agentgateway` container, add env sourced from a
new Secret `agentgateway-llm` (created out-of-band in Step 4):

```yaml
          env:
            - name: AZURE_OPENAI_API_KEY
              valueFrom:
                secretKeyRef: { name: agentgateway-llm, key: AZURE_OPENAI_API_KEY }
            - name: AZURE_RESOURCE_NAME
              valueFrom:
                secretKeyRef: { name: agentgateway-llm, key: AZURE_RESOURCE_NAME }
```

(Merge into the container's existing `env:` list if present; otherwise add it.)

- [ ] **Step 4: Create the Secret and deploy**

```bash
set -a; . ./.demo.env; set +a
AZ_RES=$(printf '%s' "$AZURE_OPENAI_ENDPOINT" | sed -E 's#https?://([^.]+)\..*#\1#')
kubectl create secret generic agentgateway-llm -n mcp \
  --from-literal=AZURE_OPENAI_API_KEY="$AZURE_OPENAI_API_KEY" \
  --from-literal=AZURE_RESOURCE_NAME="$AZ_RES" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl apply -f k8s/workloads/agentgateway.yaml
kubectl -n mcp create configmap agentgateway-config \
  --from-file=config.yaml=k8s/workloads/agentgateway-config.yaml \
  --dry-run=client -o yaml | kubectl apply -f -   # match how the config is mounted; see existing apply flow
kubectl -n mcp rollout restart deploy/agentgateway
kubectl -n mcp rollout status deploy/agentgateway --timeout=120s
```

(If `make apply` is the canonical mount path for the config, run that instead of
the manual configmap line — check how `agentgateway-config.yaml` reaches the pod.)

- [ ] **Step 5: End-to-end gateway test with a real `aud=llm-gateway` token**

Mint a token via the copilot exchange path (or reuse the smoke harness's token
minting for `aud=mcp-gateway`, changing audience→`llm-gateway`, scope→`llm:invoke`).
Then, from a pod that can resolve the Service (e.g. `kubectl -n mcp run`):

```bash
curl -sN http://agentgateway.mcp.svc.cluster.local:8080/llm/chat/completions \
  -H "authorization: Bearer $LLM_TOKEN" -H content-type:application/json \
  -d '{"model":"gpt-4.1","stream":true,"messages":[{"role":"user","content":"hi"}]}' | head -5
# Negative: a token WITHOUT llm:invoke (or aud!=llm-gateway) must be denied AT the gateway:
curl -s -o /dev/null -w '%{http_code}\n' http://agentgateway.mcp.svc.cluster.local:8080/llm/chat/completions \
  -H "authorization: Bearer $MCP_TOKEN" -H content-type:application/json -d '{"model":"gpt-4.1","messages":[]}'
```

Expected: streamed completion for `$LLM_TOKEN`; `401`/`403` for `$MCP_TOKEN`.

- [ ] **Step 6: Commit**

```bash
git add k8s/workloads/agentgateway-config.yaml k8s/workloads/agentgateway.yaml
git commit -m "feat(agentgateway): identity-bound /llm route to Azure OpenAI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: agent-copilot integration

**Files:**
- Create: `apps/agent-copilot/src/llm-token.ts`
- Modify: `apps/agent-copilot/src/config.ts`
- Modify: `apps/agent-copilot/src/server.ts`
- Modify: `k8s/workloads/agent-copilot.yaml`

**Interfaces:**
- Consumes: `buildLlm(cfg, { accessToken })` (Task 2); `exchangeToken`,
  `TokenExchangeCache`, `getCimdIdentity`, `SpiffeJwtSvidSource` (existing).
- Produces: `obtainLlmToken({ cfg, subjectToken, subjectSub, subjectAcr }): Promise<string>`.

- [ ] **Step 1: Extend `Config` (config.ts)**

Change the provider union and fields. In the `Config` interface replace
`llmProvider: 'anthropic' | 'azure' | 'ollama'` with
`llmProvider: 'gateway' | 'anthropic' | 'ollama'`, remove `azureEndpoint`/
`azureApiVersion`, and add:

```ts
  llmGatewayUrl: string;
  llmGatewayAudience: string;
  llmGatewayScope: string;
```

In `loadConfig()` replace the provider parsing + azure block:

```ts
  const provider = (process.env.LLM_PROVIDER ?? 'gateway').toLowerCase();
  if (provider !== 'gateway' && provider !== 'anthropic' && provider !== 'ollama') {
    throw new Error(`LLM_PROVIDER must be 'gateway' | 'anthropic' | 'ollama' (got '${provider}')`);
  }
```

Set the config fields (drop the azure branch entirely):

```ts
    llmProvider: provider,
    llmModel:
      process.env.LLM_MODEL ??
      (provider === 'anthropic' ? 'claude-sonnet-4-6' : provider === 'gateway' ? 'gpt-4.1' : 'qwen2.5-coder:7b'),
    llmGatewayUrl:
      process.env.LLM_GATEWAY_URL ?? 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
    llmGatewayAudience: process.env.LLM_GATEWAY_AUDIENCE ?? 'llm-gateway',
    llmGatewayScope: process.env.LLM_GATEWAY_SCOPE ?? 'llm:invoke',
```

- [ ] **Step 2: Create `llm-token.ts`**

```ts
import { exchangeToken, CurityAuthError } from '@ai-agents-demo/auth-curity';
import { SpiffeJwtSvidSource } from '@ai-agents-demo/spiffe';
import { TokenExchangeCache } from './token-exchange-cache.js';
import { getCimdIdentity } from './cimd-identity.js';
import { SVID_AUDIENCE, SVID_FILE } from './spiffe-constants.js';
import type { Config } from './config.js';

const svidSource = new SpiffeJwtSvidSource({
  audiences: [{ audience: SVID_AUDIENCE, filePath: SVID_FILE }],
});
const llmCache = new TokenExchangeCache({ ttlMs: 60_000 });

/**
 * RFC 8693 exchange → aud=llm-gateway, scope=llm:invoke. Subject = the user
 * token (on-behalf-of), actor = this agent's SPIFFE JWT-SVID. 60 s TTL cache
 * keyed on (sub, scope, audience, acr). Mirrors obtainMcpToken in mcp-client.ts.
 */
export async function obtainLlmToken(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  subjectAcr: string;
}): Promise<string> {
  const { cfg, subjectToken, subjectSub, subjectAcr } = opts;
  const key = {
    sub: subjectSub,
    scope: cfg.llmGatewayScope,
    audience: cfg.llmGatewayAudience,
    acr: subjectAcr,
  };
  const cached = llmCache.get(key);
  if (cached) return cached.accessToken;

  const svid = await svidSource.getSvid(SVID_AUDIENCE);
  if (!svid) {
    throw new CurityAuthError(
      `SPIFFE JWT-SVID not available at ${SVID_FILE} (spiffe-helper not ready?)`,
      'invalid_actor',
    );
  }

  const identity = await getCimdIdentity(cfg);
  const result = await exchangeToken({
    tokenEndpoint: cfg.curityTokenEndpoint,
    clientId: cfg.agentClientId,
    clientAuth: {
      method: 'private_key_jwt',
      privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
      kid: identity.kid,
      assertionAudience: cfg.curityTokenEndpoint,
    },
    subjectToken,
    actorToken: svid.jwt,
    audience: cfg.llmGatewayAudience,
    scope: cfg.llmGatewayScope,
  });

  llmCache.set(key, {
    accessToken: result.accessToken,
    expiresInSec: result.expiresInSec,
    scope: result.scope,
  });
  return result.accessToken;
}
```

- [ ] **Step 3: Build the model per-request in the handler (server.ts)**

Remove the startup line `const llm = buildLlm(cfg);` (near line 30). Add the
import near the other `./` imports:

```ts
import { obtainLlmToken } from './llm-token.js';
```

In the request handler, immediately before the `const result = await generateText({`
call (currently ~line 218), insert:

```ts
      let llmToken: string;
      try {
        llmToken = await obtainLlmToken({
          cfg,
          subjectToken: authed.bearerToken!,
          subjectSub: userSub,
          subjectAcr: userAcr,
        });
      } catch (e) {
        console.error('[agent-copilot] llm token exchange failed', e);
        res.status(502).json({ error: 'llm_unavailable' });
        return;
      }
      const llm = buildLlm(cfg, { accessToken: llmToken });
```

(`buildLlm` is already imported from `./llm.js`.)

- [ ] **Step 4: Update the manifest env (agent-copilot.yaml)**

Remove the `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` env entries (and
`AZURE_OPENAI_API_VERSION` if present). Add:

```yaml
            - name: LLM_PROVIDER
              value: gateway
            - name: LLM_GATEWAY_URL
              value: http://agentgateway.mcp.svc.cluster.local:8080/llm
            - name: LLM_GATEWAY_AUDIENCE
              value: llm-gateway
            - name: LLM_GATEWAY_SCOPE
              value: llm:invoke
```

- [ ] **Step 5: Typecheck + build**

Run: `pnpm --filter @ai-agents-demo/agent-copilot typecheck && pnpm --filter @ai-agents-demo/agent-copilot build`
Expected: PASS (no references to removed `azureEndpoint`/`azureApiVersion`).

- [ ] **Step 6: Rebuild image, deploy, drive a real request**

```bash
make images   # or the copilot-specific build; then:
kubectl -n agents rollout restart deploy/agent-copilot
kubectl -n agents rollout status deploy/agent-copilot --timeout=120s
```

Drive a copilot question through the web BFF (or its endpoint) and confirm a
non-empty answer. Then prove the key moved:

```bash
kubectl -n agents set env deploy/agent-copilot --list | grep -i azure || echo "no AZURE env on copilot (correct)"
```

Expected: an answer returns; no `AZURE_*` env on the pod.

- [ ] **Step 7: Commit**

```bash
git add apps/agent-copilot k8s/workloads/agent-copilot.yaml
git commit -m "feat(agent-copilot): route LLM calls through gateway (identity-bound egress)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: agent-specialist integration

**Files:**
- Create: `apps/agent-specialist/src/llm-token.ts`
- Modify: `apps/agent-specialist/src/config.ts`
- Modify: `apps/agent-specialist/src/executor.ts`
- Modify: `k8s/workloads/agent-specialist.yaml`

**Interfaces:**
- Consumes: same as Task 5. `runRemediation` already takes a `deps` object with
  `obtainOpsToken`/`obtainObsToken`; add `obtainLlmToken` as a peer dep.
- Produces: `obtainLlmToken` in `apps/agent-specialist/src/llm-token.ts` (same
  signature as copilot's, minus nothing — the specialist passes `subjectAcr: ''`).

- [ ] **Step 1: Extend `Config` (config.ts)**

Apply the exact same edits as Task 5 Step 1 to
`apps/agent-specialist/src/config.ts` (provider union → `gateway|anthropic|ollama`,
drop azure fields, add `llmGatewayUrl`/`llmGatewayAudience`/`llmGatewayScope`,
default `LLM_PROVIDER=gateway`, model default `gpt-4.1`).

- [ ] **Step 2: Create `llm-token.ts`**

Copy the copilot `llm-token.ts` (Task 5 Step 2) into
`apps/agent-specialist/src/llm-token.ts` verbatim — the imports
(`token-exchange-cache`, `cimd-identity`, `spiffe-constants`, `config`) resolve
identically in the specialist app. (These are per-app modules that already exist
in the specialist; confirm the four import paths resolve, then keep the file
identical.)

- [ ] **Step 3: Add `obtainLlmToken` to the DI surface + build per-request (executor.ts)**

Add to the `RemediationDeps` interface (near the existing
`obtainOpsToken`/`obtainObsToken` at lines 63-64):

```ts
  obtainLlmToken: (o: {
    cfg: Config;
    subjectToken: string;
    subjectSub: string;
    subjectAcr: string;
  }) => Promise<string>;
```

Remove the startup-scope `const llm = buildLlm(cfg);` (line 267). Immediately
before the `const result = await generateText({` call (line 269), insert:

```ts
    const llmToken = await deps.obtainLlmToken({ cfg, subjectToken: bearer, subjectSub: sub, subjectAcr: '' });
    const llm = buildLlm(cfg, { accessToken: llmToken });
```

Wire the real impl into the default deps (near lines 294-295 where
`obtainOpsToken`/`obtainObsToken` are assigned):

```ts
    obtainLlmToken,
```

and add the import at the top:

```ts
import { obtainLlmToken } from './llm-token.js';
```

- [ ] **Step 4: Update existing executor tests for the new dep**

`apps/agent-specialist/tests/executor.test.ts` constructs `deps`. Add a stub so
the tool-loop can build a model:

```ts
    obtainLlmToken: async () => 'test-llm-token',
```

to every `deps` object the tests build. Ensure the test's `cfg` includes
`llmProvider: 'gateway'`, `llmModel: 'gpt-4.1'`,
`llmGatewayUrl: 'http://gw:8080/llm'`, `llmGatewayAudience: 'llm-gateway'`,
`llmGatewayScope: 'llm:invoke'` (drop any azure fields).

- [ ] **Step 5: Run tests + typecheck + build**

Run: `pnpm --filter @ai-agents-demo/agent-specialist test && pnpm --filter @ai-agents-demo/agent-specialist typecheck && pnpm --filter @ai-agents-demo/agent-specialist build`
Expected: PASS.

- [ ] **Step 6: Update the manifest env (agent-specialist.yaml)**

Same edits as Task 5 Step 4, applied to `agent-specialist.yaml`.

- [ ] **Step 7: Deploy + drive an A2A remediation, prove the key moved**

```bash
make images
kubectl -n agents rollout restart deploy/agent-specialist
kubectl -n agents rollout status deploy/agent-specialist --timeout=120s
kubectl -n agents set env deploy/agent-specialist --list | grep -i azure || echo "no AZURE env on specialist (correct)"
```

Drive a remediation (copilot → A2A → specialist) and confirm it completes.

- [ ] **Step 8: Commit**

```bash
git add apps/agent-specialist k8s/workloads/agent-specialist.yaml
git commit -m "feat(agent-specialist): route LLM calls through gateway (identity-bound egress)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Makefile / seed refactor

**Files:**
- Modify: `Makefile` (the `seed-secrets` / azure-seeding target near line 371)

- [ ] **Step 1: Point Azure seeding at the gateway Secret**

In the target that currently seeds `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_KEY`
into the agent Secrets (Makefile ~371-381), change it to create the
`agentgateway-llm` Secret in ns `mcp`, deriving `resourceName` from the endpoint:

```make
	  res=$$(printf '%s' "$$e" | sed -E 's#https?://([^.]+)\..*#\1#'); \
	  kubectl create secret generic agentgateway-llm -n mcp \
	    --from-literal=AZURE_OPENAI_API_KEY="$$k" \
	    --from-literal=AZURE_RESOURCE_NAME="$$res" \
	    --dry-run=client -o yaml | kubectl apply -f -; \
```

Remove the lines that seeded the Azure key/endpoint into `agent-*-llm` Secrets.
(macOS bash 3.2 — no `declare -A`.) If Task 1 recorded **TEMPLATE** for
`resourceName`, also add a `sed -i` step here that substitutes `RESOURCE_PLACEHOLDER`
in `agentgateway-config.yaml` before `make apply` mounts it.

- [ ] **Step 2: Verify the seed target runs**

Run: `make seed-secrets` (interactive) or invoke the specific target.
Expected: `secret/agentgateway-llm ... configured`; no agent Azure Secret created.

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "chore(seed): seed Azure creds into the gateway Secret, not the agents

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: smoke test — LLM egress beat

**Files:**
- Modify: the smoke script behind `make smoke` (locate via `grep -rn "smoke" Makefile scripts/`)

- [ ] **Step 1: Add positive + negative + key-absence assertions**

Append an LLM section to the smoke script. Use the existing token-minting helper
(the one that produces an `aud=mcp-gateway` token) with audience `llm-gateway`
and scope `llm:invoke` for the positive token, and reuse an `aud=mcp-gateway`
token as the negative. Concretely:

```bash
echo "== LLM egress =="
# positive: aud=llm-gateway + llm:invoke -> 200 streamed
code=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer $LLM_TOKEN" -H content-type:application/json \
  --data '{"model":"gpt-4.1","messages":[{"role":"user","content":"ping"}]}' \
  "$GW/llm/chat/completions")
[ "$code" = "200" ] || { echo "FAIL: llm:invoke caller got $code (want 200)"; exit 1; }

# negative: aud=mcp-gateway (no llm:invoke) -> denied AT the gateway
code=$(curl -s -o /dev/null -w '%{http_code}' \
  -H "authorization: Bearer $MCP_TOKEN" -H content-type:application/json \
  --data '{"model":"gpt-4.1","messages":[]}' "$GW/llm/chat/completions")
case "$code" in 401|403) : ;; *) echo "FAIL: non-llm caller got $code (want 401/403)"; exit 1;; esac

# credential moved: no Azure key on the agent pods
kubectl -n agents set env deploy/agent-copilot --list | grep -qi AZURE_OPENAI_API_KEY \
  && { echo "FAIL: AZURE_OPENAI_API_KEY still on agent-copilot"; exit 1; } || true
echo "LLM egress OK"
```

(Adapt `$GW`, `$LLM_TOKEN`, `$MCP_TOKEN` to the smoke script's existing variable
names / token-minting functions.)

- [ ] **Step 2: Run smoke**

Run: `make smoke`
Expected: all existing beats pass + `LLM egress OK`.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test(smoke): LLM egress positive/negative + agent key-absence

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: docs

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design.md`, `docs/demo.md`

- [ ] **Step 1: CLAUDE.md — diagram + hard-won fact**

Extend the topology diagram's agent rows with the LLM egress hop:

```
agent-copilot / agent-specialist ─ LLM ─▶ agentgateway (/llm; aud=llm-gateway, require llm:invoke; backendAuth.key=Azure key) ─▶ Azure OpenAI
```

Add a new hard-won-fact entry (next number after the current last, ~#22):

> **22. The LLM egress is a governed hop through agentgateway.** Both agents
> exchange the user token → `aud=llm-gateway`, `scope=llm:invoke` (one exchange,
> no shim — Azure is outside the trust domain) and call the gateway's
> OpenAI-compatible `/llm` route. The gateway holds the ONLY Azure key
> (`backendAuth.key: $AZURE_OPENAI_API_KEY`, header `api-key`), validates the JWT,
> and requires `llm:invoke`. `resourceType` is `openAI` (lowercase-o). The AI SDK
> client (`buildLlm` gateway mode) points `baseURL` at `.../llm` and passes the
> exchanged JWT as the OpenAI bearer. Agents no longer hold `AZURE_OPENAI_API_KEY`.

Update the "Both agents are LLM agents" bullet to note the gateway-routed LLM
call and the removed direct-Azure path.

- [ ] **Step 2: architecture.md + design.md + demo.md**

- `architecture.md`: add the LLM egress to the topology + trust model (new
  `llm-gateway` audience/scope; single exchange; no act-chain).
- `design.md`: document `buildLlm` gateway mode, `obtainLlmToken`, the gateway
  `/llm` route, and the moved credential.
- `demo.md`: add a runbook beat — drive a question, show the `/llm` span with
  `gen_ai.*` attributes in Grafana/Tempo attributed to the user; show the
  gateway denies a non-`llm:invoke` caller. Mermaid: quoted subgraph/node labels.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/architecture.md docs/design.md docs/demo.md
git commit -m "docs: governed LLM egress via agentgateway across the canonical docs

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** components §"Components changed" → Tasks 2–7; testing → Tasks
  2/6/8; docs → Task 9; open items → Task 1. All covered.
- **Type consistency:** `buildLlm(cfg, {accessToken})`, `obtainLlmToken({cfg,
  subjectToken, subjectSub, subjectAcr})`, `LlmConfig.llmGatewayUrl`,
  `Config.llmGateway{Url,Audience,Scope}` used consistently across Tasks 2/5/6.
- **Verification-gated forks:** `resourceName` ENV-vs-TEMPLATE is resolved in
  Task 1 and both concrete variants are specified in Tasks 4/7 — not a placeholder.
- **`<PINNED_IMAGE>`** = `ghcr.io/agentgateway/agentgateway@sha256:c3ce7b75da90fef70239befcc1c3adc05152d7b9dd21fcb8351178026a2c4381`.
