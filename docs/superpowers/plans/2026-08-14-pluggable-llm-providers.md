# Pluggable LLM Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the agents reach an LLM only through agentgateway's `/llm` route, and generate that route's provider block from `.demo.env` so a demo user can plug in OpenAI, Anthropic, Gemini, or Azure OpenAI by editing one file.

**Architecture:** `buildLlm` collapses to a single `createOpenAICompatible` call — the direct-to-vendor `anthropic`/`ollama` branches are deleted, not fixed, because they bypass the `llm:invoke` scope check. The model name moves out of the agents entirely and is pinned by the gateway's provider block, which `scripts/render-gateway-config.sh` splices from a per-provider fragment into a gitignored `.gen/agentgateway-config.yaml` that `make apply` turns into the ConfigMap.

**Tech Stack:** TypeScript (Node 22, ESM, vitest), Vercel AI SDK v7 (`ai@7`, `@ai-sdk/openai-compatible@3`), bash 3.2 + python3 for scripts, Kubernetes manifests, agentgateway v1.4.1.

**Spec:** [`docs/superpowers/specs/2026-08-14-pluggable-llm-providers-design.md`](../specs/2026-08-14-pluggable-llm-providers-design.md)

## Global Constraints

- **Branch:** `feat/pluggable-llm-providers`. It already exists and holds the spec commit.
- **agentgateway is pinned to `ghcr.io/agentgateway/agentgateway:v1.4.1`.** Every config claim in this plan was measured against that exact image. Do not bump it.
- **Only four provider keys ship:** `openAI`, `anthropic`, `gemini`, `azure`. At v1.4.1 standalone YAML accepts only `openAI, gemini, vertex, anthropic, bedrock, azure, copilot, custom` — `ollama`, `groq` etc. are xDS-only and fail config load with ``unknown variant``. Do not add them.
- **Anthropic's fragment MUST NOT set `backendAuth.key.location`.** The gateway moves the key to `x-api-key` and adds `anthropic-version: 2023-06-01` only when the location was left implicit (`llm/mod.rs:1247-1276` keys on an `explicit` flag). Setting it "for clarity" breaks Anthropic.
- **Azure's fragment MUST set `location: {header: {name: api-key, prefix: ""}}`** — Azure gets no such fixup.
- **`resourceType` is lowercase-o `openAI`** (CLAUDE.md fact #22).
- **Keep `@ai-sdk/openai-compatible`.** Never switch to `@ai-sdk/openai`: since ai@5 its provider function defaults to the Responses API and would POST `/llm/responses`, which the gateway does not serve (CLAUDE.md fact #30).
- **macOS bash is 3.2** — no `declare -A`, no `mapfile`. Use parallel arrays or IFS-split strings.
- **Never commit a credential.** `.demo.env` is gitignored; `.demo.env.example` carries placeholders only.
- **Do not touch** the `jwtAuth` provider block, the `llm:invoke` `authorization` rule, the RFC 8693 exchange, or anything under the `/observability`, `/ops`, or `last-token` routes.
- **Commit after every task.** Run `pnpm turbo run build typecheck test` before any commit that touches TypeScript.

---

### Task 1: agent-runtime — gateway-only `buildLlm`

Deletes the direct-to-vendor paths and removes the agent-side model knob. Self-contained: verified entirely by `packages/agent-runtime`'s own vitest suite.

**Files:**
- Modify: `packages/agent-runtime/src/llm.ts` (whole file)
- Modify: `packages/agent-runtime/src/llm.test.ts:1-89`
- Modify: `packages/agent-runtime/src/tool-errors.test.ts:70-74`
- Modify: `packages/agent-runtime/package.json` (remove one dependency)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `interface LlmConfig { llmGatewayUrl: string }` — note `llmProvider` and `llmModel` are **gone**, and `llmGatewayUrl` is now required, not optional.
  - `interface BuildLlmOptions { accessToken?: string; fetchImpl?: typeof fetch }` — unchanged.
  - `function buildLlm(cfg: LlmConfig, opts?: BuildLlmOptions): AgentLanguageModel` — unchanged signature.
  - `type AgentLanguageModel = Exclude<LanguageModel, string>` — unchanged.
  - `const GATEWAY_PINNED_MODEL = 'model-pinned-at-gateway'` — **not exported**; Task 2 does not need it.

- [ ] **Step 1: Write the failing test**

In `packages/agent-runtime/src/llm.test.ts`, replace the `gw` fixture at lines 5-9 and the whole `describe` block at lines 37-89 with the following. The two `recordingFetch`/`chatCompletion` helpers at lines 11-35 stay exactly as they are.

```ts
const gw: LlmConfig = {
  llmGatewayUrl: 'http://agentgateway.mcp.svc.cluster.local:8080/llm',
};

describe('buildLlm', () => {
  it('builds an OpenAI-compatible model with an injected token', () => {
    const model = buildLlm(gw, { accessToken: 'tok-123' });
    expect(model).toBeDefined();
  });

  // The regression this pins: since ai@5 the plain `@ai-sdk/openai` provider
  // defaults to the Responses API, so `openai(model)` would POST /llm/responses.
  // agentgateway's /llm route is chat-completions-shaped and is the only source
  // of gen_ai.usage.* accounting, so that drift breaks the LLM hop AND its
  // telemetry. Asserting on `model.provider` alone cannot see this — only the
  // request path can.
  it('POSTs to the chat completions path under the gateway base URL', async () => {
    const { impl, seen } = recordingFetch();
    const model = buildLlm(gw, { accessToken: 'tok-123', fetchImpl: impl });
    await generateText({ model, prompt: 'hi' });
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0].url).pathname).toBe('/llm/chat/completions');
  });

  // The exchanged aud=llm-gateway JWT must arrive as the bearer: that is what the
  // gateway validates and what it requires `llm:invoke` on before swapping in the
  // upstream provider key. Sending the wrong header means a 401 at the gateway.
  it('sends the exchanged token as the Authorization bearer', async () => {
    const { impl, seen } = recordingFetch();
    const model = buildLlm(gw, { accessToken: 'tok-123', fetchImpl: impl });
    await generateText({ model, prompt: 'hi' });
    expect(seen[0].headers.authorization).toBe('Bearer tok-123');
  });

  // The gateway's provider block pins `model:`, which overrides whatever the
  // client sends — so agents have no model to choose. This asserts they do not
  // start choosing one again. The placeholder is deliberately self-describing:
  // if a provider fragment ever omits `model:`, this exact string reaches the
  // vendor and the error names it.
  it('sends the gateway-pinned placeholder as the model', async () => {
    const { impl, seen } = recordingFetch();
    const model = buildLlm(gw, { accessToken: 'tok-123', fetchImpl: impl });
    await generateText({ model, prompt: 'hi' });
    expect(JSON.parse(seen[0].body!).model).toBe('model-pinned-at-gateway');
  });

  it('throws when accessToken is missing', () => {
    expect(() => buildLlm(gw)).toThrow(/accessToken/);
  });

  it('throws when llmGatewayUrl is missing', () => {
    expect(() => buildLlm({ llmGatewayUrl: '' }, { accessToken: 't' })).toThrow(/LLM_GATEWAY_URL/);
  });
});
```

The new `model` assertion needs the request body, which `recordingFetch` does not currently capture. Extend it — replace lines 26-35 with:

```ts
function recordingFetch() {
  const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const impl: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    seen.push({ url, headers, body: typeof init?.body === 'string' ? init.body : undefined });
    return chatCompletion();
  };
  return { impl, seen };
}
```

Also delete the now-unused `beforeEach`/`afterEach` env save/restore block (old lines 38-44) — it only existed to set `ANTHROPIC_API_KEY`. Update the import on line 1 to `import { describe, it, expect } from 'vitest';`.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm --filter @ai-agents-demo/agent-runtime test
```

Expected: FAIL. TypeScript errors on the `gw` fixture (`llmProvider` is still required by `LlmConfig`), and `tool-errors.test.ts` still passes `llmProvider`/`llmModel`.

- [ ] **Step 3: Rewrite `llm.ts`**

Replace the entire contents of `packages/agent-runtime/src/llm.ts` with:

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

/**
 * A constructed model instance.
 *
 * The SDK's `LanguageModel` is a union that also admits a bare model-id string
 * (resolved through its own gateway), which we never use — the model here is
 * built explicitly against an audience-scoped endpoint. Excluding the string form
 * keeps `.provider` reachable on the result.
 *
 * Deliberately NOT the versioned spec type (`LanguageModelV1`/`V3`/…): pinning to
 * a spec version is what turned the 4→7 upgrade into a source change in this file.
 */
export type AgentLanguageModel = Exclude<LanguageModel, string>;

/**
 * The model the agents put on the wire.
 *
 * agentgateway's provider block sets `model:`, which overrides whatever the
 * client requests, so agents have no model to configure. Chat Completions still
 * requires the field, so we send this.
 *
 * The value is deliberately self-describing rather than something plausible like
 * "default": if a provider fragment ever omits `model:`, this string reaches the
 * upstream vendor and the error reads `model 'model-pinned-at-gateway' not found`,
 * which diagnoses itself in one line.
 */
const GATEWAY_PINNED_MODEL = 'model-pinned-at-gateway';

export interface LlmConfig {
  /** Base URL of the agentgateway LLM route. */
  llmGatewayUrl: string;
}

export interface BuildLlmOptions {
  /** Per-request aud=llm-gateway bearer. Required. */
  accessToken?: string;
  /** Override the HTTP client. Tests use this to assert the outbound request. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the model the agents reason with.
 *
 * There is exactly one path: agentgateway's `/llm` route. Direct-to-vendor modes
 * used to exist and were removed on purpose — they bypassed the `llm:invoke`
 * scope check and put a static vendor key back in the agent's environment, which
 * is the property this demo exists to argue against. Which vendor sits upstream
 * is the gateway's business, configured in k8s/workloads/llm-providers/.
 */
export function buildLlm(cfg: LlmConfig, opts: BuildLlmOptions = {}): AgentLanguageModel {
  if (!cfg.llmGatewayUrl) throw new Error('LLM_GATEWAY_URL is required');
  if (!opts.accessToken)
    throw new Error('buildLlm requires a per-request accessToken (aud=llm-gateway)');

  // `@ai-sdk/openai-compatible`, NOT `@ai-sdk/openai`: agentgateway's /llm route
  // is an OpenAI-COMPATIBLE proxy, and it implements Chat Completions only. Since
  // ai@5 the plain OpenAI provider defaults to the Responses API, so
  // `createOpenAI(...)(model)` POSTs `${baseURL}/responses` and the hop breaks —
  // along with the gateway's gen_ai.usage.* accounting, which is the only place
  // LLM token usage is recorded. This provider has no Responses implementation to
  // drift onto. Pinned by llm.test.ts.
  //
  // The apiKey is sent as `Authorization: Bearer`: we pass the exchanged
  // aud=llm-gateway JWT, which the gateway validates (requiring `llm:invoke`)
  // before swapping in the real upstream provider key.
  return createOpenAICompatible({
    name: 'agentgateway',
    baseURL: cfg.llmGatewayUrl,
    apiKey: opts.accessToken,
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  })(GATEWAY_PINNED_MODEL);
}
```

- [ ] **Step 4: Fix the `tool-errors.test.ts` fixture**

Replace lines 70-74 with:

```ts
const cfg = {
  llmGatewayUrl: 'http://gw:8080/llm',
};
```

Nothing else in that file changes — its subject is SDK tool-error semantics, not provider wiring.

- [ ] **Step 5: Drop the Anthropic SDK dependency**

In `packages/agent-runtime/package.json`, delete the `"@ai-sdk/anthropic": "^4.0.33",` line from `dependencies`. It has no other consumer.

```bash
pnpm install
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
pnpm --filter @ai-agents-demo/agent-runtime test
```

Expected: PASS, 6 tests in `llm.test.ts` and 2 in `tool-errors.test.ts`.

Then confirm nothing else in the workspace referenced the removed fields:

```bash
grep -rn "llmProvider\|@ai-sdk/anthropic" --include="*.ts" --include="*.json" apps packages | grep -v node_modules
```

Expected: only `apps/agent-copilot/src/config.ts` and `apps/agent-specialist/src/config.ts` — both are Task 2.

- [ ] **Step 7: Commit**

```bash
git add packages/agent-runtime pnpm-lock.yaml
git commit -m "refactor(agent-runtime): make the agentgateway /llm route the only LLM path

Delete the direct-to-vendor anthropic/ollama branches from buildLlm. They
bypassed the llm:invoke scope check and reintroduced a static vendor key in the
agent's environment. The gateway now also pins the model, so agents send a
self-describing placeholder instead of choosing one."
```

---

### Task 2: Both agents drop `LLM_PROVIDER` and `LLM_MODEL`

After this task the two agent Deployment manifests contain nothing provider-specific — the property that makes switching providers a one-file change.

**Files:**
- Modify: `apps/agent-copilot/src/config.ts:19-20,36-39,62-65`
- Modify: `apps/agent-specialist/src/config.ts:25-27,49-52,73-80`
- Modify: `k8s/workloads/agent-copilot.yaml:112-115`
- Modify: `k8s/workloads/agent-specialist.yaml:99-102`

**Interfaces:**
- Consumes: `LlmConfig`, `buildLlm` from Task 1. Both agents' `Config` must remain structurally assignable to `LlmConfig` — i.e. keep `llmGatewayUrl: string`.
- Produces: `Config` in both agents without `llmProvider`/`llmModel`. `llmGatewayUrl`, `llmGatewayAudience`, `llmGatewayScope` are unchanged and still consumed by `obtainLlmToken`.

- [ ] **Step 1: Write the failing check**

There is no unit test for `loadConfig` in either agent; the compiler is the test here, and it is a real one — `apps/agent-copilot/src/llm.ts` passes `Config` where `LlmConfig` is expected, so a mismatch fails the build. Establish the failing state by editing the manifests first, then let typecheck drive the source edits.

In `k8s/workloads/agent-copilot.yaml`, delete these four lines (112-115):

```yaml
            - name: LLM_PROVIDER
              value: gateway
            - name: LLM_MODEL
              value: gpt-4.1
```

In `k8s/workloads/agent-specialist.yaml`, delete the identical four lines (99-102). Leave the explanatory comment block that follows them — it describes the `aud=llm-gateway` exchange, which is unchanged.

- [ ] **Step 2: Run typecheck to see the current state**

```bash
pnpm turbo run typecheck
```

Expected: PASS — the manifests are not typechecked. This confirms the manifests alone prove nothing, which is why the source edits below are driven by the compiler in Step 4.

- [ ] **Step 3: Edit both `config.ts` files**

In `apps/agent-copilot/src/config.ts`, delete lines 19-20 from the `Config` interface:

```ts
  llmProvider: 'gateway' | 'anthropic' | 'ollama';
  llmModel: string;
```

and change the comment on the next line from `/** Base URL of the agentgateway LLM route. Only used when llmProvider === 'gateway'. */` to `/** Base URL of the agentgateway LLM route. */`.

Delete the provider validation at lines 36-39:

```ts
  const provider = (process.env.LLM_PROVIDER ?? 'gateway').toLowerCase();
  if (provider !== 'gateway' && provider !== 'anthropic' && provider !== 'ollama') {
    throw new Error(`LLM_PROVIDER must be 'gateway' | 'anthropic' | 'ollama' (got '${provider}')`);
  }
```

so `loadConfig` opens directly with `const cfg: Config = {`. Delete the two assignments at lines 62-65:

```ts
    llmProvider: provider,
    llmModel:
      process.env.LLM_MODEL ??
      (provider === 'anthropic' ? 'claude-sonnet-4-6' : provider === 'gateway' ? 'gpt-4.1' : 'qwen2.5-coder:7b'),
```

Apply the exact same four deletions to `apps/agent-specialist/src/config.ts` — interface lines 26-27 (keeping the `// LLM` section comment), validation lines 49-52, and assignment lines 73-80 (the specialist's `llmModel` ternary is formatted across more lines).

- [ ] **Step 4: Run build, typecheck and the full test suite**

```bash
pnpm turbo run build typecheck test
```

Expected: PASS across all workspaces. If `apps/agent-copilot/src/llm.ts` errors, `Config` lost `llmGatewayUrl` — restore it.

- [ ] **Step 5: Verify no provider-specific env remains in the agent manifests**

```bash
grep -n "LLM_PROVIDER\|LLM_MODEL\|AZURE" k8s/workloads/agent-copilot.yaml k8s/workloads/agent-specialist.yaml
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/agent-copilot/src/config.ts apps/agent-specialist/src/config.ts \
        k8s/workloads/agent-copilot.yaml k8s/workloads/agent-specialist.yaml
git commit -m "refactor(agents): remove LLM_PROVIDER/LLM_MODEL from both agents

The gateway's provider block pins the model, so the agents have nothing
provider-specific left to configure. Both Deployment manifests are now
provider-agnostic, which is what makes switching providers a one-file change."
```

---

### Task 3: Provider fragments and the render script

The heart of the change. Ends with a golden test proving the `azure` render reproduces today's deployed block — the evidence that the one provider verifiable live is unaffected.

**Files:**
- Create: `k8s/workloads/llm-providers/openai.yaml`
- Create: `k8s/workloads/llm-providers/anthropic.yaml`
- Create: `k8s/workloads/llm-providers/gemini.yaml`
- Create: `k8s/workloads/llm-providers/azure.yaml`
- Create: `scripts/render-gateway-config.sh`
- Create: `tests/fixtures/llm-route-azure.expected.yaml`
- Create: `scripts/test-render-gateway-config.sh`
- Modify: `k8s/workloads/agentgateway-config.yaml:264-300` (the `llm` route)
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `scripts/render-gateway-config.sh` — no arguments; reads `.demo.env` from the repo root; writes `.gen/agentgateway-config.yaml`; exits non-zero with a message on unknown provider, missing `AZURE_OPENAI_ENDPOINT` for `azure`, or missing sentinels. Task 4's `make apply` and `make configure-llm` call it.
  - Fragment placeholders: `__LLM_MODEL__` in all four, `__AZURE_RESOURCE_NAME__` in `azure.yaml` only.
  - Sentinels in `agentgateway-config.yaml`: `# BEGIN_LLM_PROVIDER` / `# END_LLM_PROVIDER`.
  - Env contract the fragments depend on: `$LLM_API_KEY` must be present in the gateway container. Task 4 wires it.

- [ ] **Step 1: Capture the current deployed block as the golden fixture**

Do this **before** touching `agentgateway-config.yaml`, so the fixture records what is actually running today.

```bash
mkdir -p tests/fixtures
sed -n '285,300p' k8s/workloads/agentgateway-config.yaml > tests/fixtures/llm-route-azure.expected.yaml
cat tests/fixtures/llm-route-azure.expected.yaml
```

Expected content — verify it matches exactly before continuing:

```yaml
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

Now edit the fixture to record the two intended substitutions, so the golden test asserts the *new* expected output rather than the old one. Change `$AZURE_OPENAI_API_KEY` to `$LLM_API_KEY`, `$AZURE_RESOURCE_NAME` to `my-azure-resource`, and `name: azure` to `name: llm`. Add this comment as the first line of the file:

```yaml
# Golden fixture for scripts/test-render-gateway-config.sh.
# This is the `llm` route's backendAuth+backends as deployed on 2026-08-14, with
# exactly three intended changes: the key env var normalized to $LLM_API_KEY, the
# resource name rendered from .demo.env, and the backend label held constant at
# `llm` so telemetry does not move when the provider changes.
```

- [ ] **Step 2: Write the four fragments**

`k8s/workloads/llm-providers/openai.yaml`:

```yaml
# OpenAI. https://platform.openai.com/api-keys
#
# `backendAuth.key` with no `location` lands in `Authorization: Bearer`, which is
# what the OpenAI API wants — leave it implicit.
        backendAuth:
          key:
            value: $LLM_API_KEY
      backends:
      - ai:
          name: llm
          provider:
            openAI:
              model: __LLM_MODEL__
```

`k8s/workloads/llm-providers/anthropic.yaml`:

```yaml
# Anthropic. https://console.anthropic.com/settings/keys
#
# DO NOT add a `location:` here, however tempting it looks next to azure.yaml.
# agentgateway records whether the auth location was set explicitly
# (http/auth/mod.rs, AppliedBackendAuthLocation.explicit) and only rewrites
# Authorization: Bearer -> x-api-key, and injects `anthropic-version`, when it
# was left IMPLICIT (llm/mod.rs:1247-1276). Setting it suppresses both and the
# upstream call fails to authenticate.
        backendAuth:
          key:
            value: $LLM_API_KEY
      backends:
      - ai:
          name: llm
          provider:
            anthropic:
              model: __LLM_MODEL__
```

`k8s/workloads/llm-providers/gemini.yaml`:

```yaml
# Google Gemini (API-key auth via the OpenAI-compatible surface).
# https://aistudio.google.com/apikey
#
# agentgateway routes this to /v1beta/openai/chat/completions, which accepts
# Authorization: Bearer — so, as with openai.yaml, leave `location` implicit.
# (Vertex AI is a different provider key and needs GCP credentials; not shipped.)
        backendAuth:
          key:
            value: $LLM_API_KEY
      backends:
      - ai:
          name: llm
          provider:
            gemini:
              model: __LLM_MODEL__
```

`k8s/workloads/llm-providers/azure.yaml`:

```yaml
# Azure OpenAI. resourceName is rendered from AZURE_OPENAI_ENDPOINT in .demo.env.
#
# Azure is the one provider that DOES need an explicit `location`: it gets no
# per-provider header fixup, and Azure OpenAI authenticates API keys with the
# `api-key` header rather than a bearer token. `resourceType` is lowercase-o
# `openAI` (CLAUDE.md fact #22).
        backendAuth:
          key:
            value: $LLM_API_KEY
            location:
              header:
                name: api-key
                prefix: ""
      backends:
      - ai:
          name: llm
          provider:
            azure:
              resourceName: __AZURE_RESOURCE_NAME__
              resourceType: openAI
              model: __LLM_MODEL__
              apiVersion: "2024-04-01-preview"
```

- [ ] **Step 3: Put sentinels in the tracked config**

In `k8s/workloads/agentgateway-config.yaml`, replace the route's header comment (lines 265-269) and the `backendAuth`+`backends` block (lines 285-300) so the route reads:

```yaml
    # ------------------------------------------------------------------ #
    # LLM egress -> {gateway}:8080/llm  (OpenAI-compatible)
    # Identity-bound reasoning hop. jwtAuth(aud=llm-gateway) + require llm:invoke;
    # the gateway holds the ONLY upstream provider key (backendAuth.key). No shim,
    # no act-chain: the LLM vendor is outside the Curity trust domain — a single
    # upstream credential swap.
    #
    # Everything between the sentinels below is GENERATED from
    # k8s/workloads/llm-providers/<LLM_PROVIDER>.yaml by
    # scripts/render-gateway-config.sh, into .gen/agentgateway-config.yaml.
    # Edit the fragment, not this block. The jwtAuth and authorization policies
    # sit OUTSIDE the sentinels on purpose: the authorization posture of this hop
    # must not vary with the provider.
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
        # BEGIN_LLM_PROVIDER
        backendAuth:
          key:
            value: $LLM_API_KEY
            location:
              header:
                name: api-key
                prefix: ""
      backends:
      - ai:
          name: llm
          provider:
            azure:
              resourceName: $AZURE_RESOURCE_NAME
              resourceType: openAI
              model: gpt-4.1
              apiVersion: "2024-04-01-preview"
        # END_LLM_PROVIDER
```

The block between the sentinels stays a valid azure block so the tracked file remains readable and self-consistent; the renderer replaces it wholesale.

- [ ] **Step 4: Write the render script**

Create `scripts/render-gateway-config.sh`:

```bash
#!/usr/bin/env bash
# Render k8s/workloads/agentgateway-config.yaml with the LLM provider block
# selected by .demo.env, into .gen/agentgateway-config.yaml.
#
# The provider is chosen at config-ASSEMBLY time rather than by an env var at
# gateway runtime because agentgateway expands $VARS in values only — each
# provider is a different YAML key with a different field set, so no amount of
# substitution can switch between them.
#
# Run by `make apply` (always) and `make configure-llm` (after a .demo.env edit).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/k8s/workloads/agentgateway-config.yaml"
FRAG_DIR="$REPO_ROOT/k8s/workloads/llm-providers"
OUT="$REPO_ROOT/.gen/agentgateway-config.yaml"

die() { printf '\033[31mrender-gateway-config: %s\033[0m\n' "$*" >&2; exit 1; }

# Precedence: an explicitly exported variable beats .demo.env. Sourcing the file
# would otherwise clobber `LLM_PROVIDER=openai make configure-llm`, which is the
# obvious way to try a provider without editing the file — and it would fail
# silently, rendering the old provider while appearing to honour the override.
_env_provider="${LLM_PROVIDER:-}"
_env_model="${LLM_MODEL:-}"
_env_endpoint="${AZURE_OPENAI_ENDPOINT:-}"

# shellcheck disable=SC1091
[ -f "$REPO_ROOT/.demo.env" ] && . "$REPO_ROOT/.demo.env"

provider="${_env_provider:-${LLM_PROVIDER:-}}"
model="${_env_model:-${LLM_MODEL:-}}"
AZURE_OPENAI_ENDPOINT="${_env_endpoint:-${AZURE_OPENAI_ENDPOINT:-}}"

# Back-compat: a .demo.env written before this feature only had AZURE_*.
if [ -z "$provider" ] && [ -n "${AZURE_OPENAI_ENDPOINT:-}" ]; then
  provider=azure
fi
provider="$(printf '%s' "${provider:-openai}" | tr '[:upper:]' '[:lower:]')"

# Default model per provider. bash 3.2 on macOS has no associative arrays.
if [ -z "$model" ]; then
  case "$provider" in
    openai)    model=gpt-4.1 ;;
    anthropic) model=claude-sonnet-4-6 ;;
    gemini)    model=gemini-2.5-pro ;;
    azure)     model=gpt-4.1 ;;
  esac
fi

FRAGMENT="$FRAG_DIR/$provider.yaml"
[ -f "$FRAGMENT" ] || die "unknown LLM_PROVIDER '$provider' (expected one of: openai anthropic gemini azure)"
[ -n "$model" ] || die "LLM_MODEL is empty and no default is known for '$provider'"

resource_name=""
if [ "$provider" = "azure" ]; then
  [ -n "${AZURE_OPENAI_ENDPOINT:-}" ] || \
    die "LLM_PROVIDER=azure needs AZURE_OPENAI_ENDPOINT (e.g. https://<resource>.openai.azure.com) in .demo.env"
  resource_name="$(printf '%s' "$AZURE_OPENAI_ENDPOINT" | sed -E 's#https?://([^.]+)\..*#\1#')"
  [ -n "$resource_name" ] || die "could not derive the Azure resource name from '$AZURE_OPENAI_ENDPOINT'"
fi

mkdir -p "$(dirname "$OUT")"

SRC="$SRC" FRAGMENT="$FRAGMENT" OUT="$OUT" MODEL="$model" RESOURCE_NAME="$resource_name" \
python3 - <<'PY'
import os, re, sys

src = open(os.environ["SRC"]).read()
frag = open(os.environ["FRAGMENT"]).read()

# Drop the fragment's leading comment header — it documents the fragment for a
# human reading the file, and repeating it in the rendered output is noise.
body = "\n".join(l for l in frag.splitlines() if not l.lstrip().startswith("#"))
body = body.strip("\n")
body = body.replace("__LLM_MODEL__", os.environ["MODEL"])
body = body.replace("__AZURE_RESOURCE_NAME__", os.environ["RESOURCE_NAME"])

pattern = re.compile(r"( *)# BEGIN_LLM_PROVIDER\n.*?\n( *)# END_LLM_PROVIDER", re.DOTALL)
if not pattern.search(src):
    sys.exit("BEGIN_LLM_PROVIDER / END_LLM_PROVIDER sentinels not found in " + os.environ["SRC"])

def repl(m):
    return f"{m.group(1)}# BEGIN_LLM_PROVIDER\n{body}\n{m.group(2)}# END_LLM_PROVIDER"

open(os.environ["OUT"], "w").write(pattern.sub(repl, src, count=1))
PY

printf '==> rendered %s (provider=%s model=%s)\n' "${OUT#"$REPO_ROOT/"}" "$provider" "$model"
```

```bash
chmod +x scripts/render-gateway-config.sh
```

- [ ] **Step 5: Ignore the generated directory**

Add to `.gitignore`, under the `# build artifacts` heading:

```
.gen/
```

- [ ] **Step 6: Write the golden test**

Create `scripts/test-render-gateway-config.sh`:

```bash
#!/usr/bin/env bash
# Golden test: rendering `azure` reproduces the llm route as deployed on
# 2026-08-14, modulo the three intended substitutions recorded in the fixture.
#
# Azure is the only provider that can be driven end to end here, and it is also
# the one being refactored out of the tracked config — so this comparison is the
# evidence that the refactor is behaviour-preserving.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXPECTED="$REPO_ROOT/tests/fixtures/llm-route-azure.expected.yaml"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

# Render with an explicit environment rather than the developer's .demo.env.
cat > "$TMP/.demo.env" <<'EOF'
LLM_PROVIDER=azure
LLM_MODEL=gpt-4.1
AZURE_OPENAI_ENDPOINT=https://my-azure-resource.openai.azure.com
EOF

WORK="$TMP/repo"
mkdir -p "$WORK/scripts" "$WORK/k8s/workloads"
cp "$REPO_ROOT/scripts/render-gateway-config.sh" "$WORK/scripts/"
cp "$REPO_ROOT/k8s/workloads/agentgateway-config.yaml" "$WORK/k8s/workloads/"
cp -R "$REPO_ROOT/k8s/workloads/llm-providers" "$WORK/k8s/workloads/"
cp "$TMP/.demo.env" "$WORK/.demo.env"

bash "$WORK/scripts/render-gateway-config.sh" >/dev/null

# Extract the rendered region between the sentinels.
sed -n '/# BEGIN_LLM_PROVIDER/,/# END_LLM_PROVIDER/p' "$WORK/.gen/agentgateway-config.yaml" \
  | sed '1d;$d' > "$TMP/actual.yaml"

# Compare against the fixture, ignoring its comment header.
grep -v '^#' "$EXPECTED" | sed '/^$/d' > "$TMP/expected.yaml"

if diff -u "$TMP/expected.yaml" "$TMP/actual.yaml"; then
  green "OK: azure render matches the deployed llm route"
else
  red "FAIL: azure render drifted from tests/fixtures/llm-route-azure.expected.yaml"
  exit 1
fi
```

```bash
chmod +x scripts/test-render-gateway-config.sh
```

- [ ] **Step 7: Run the golden test**

```bash
bash scripts/test-render-gateway-config.sh
```

Expected: `OK: azure render matches the deployed llm route`. If it fails, the diff shows exactly which line drifted — fix the fragment or the fixture, whichever is wrong, and rerun.

- [ ] **Step 8: Verify all four providers render**

This also exercises the env-over-`.demo.env` precedence added in Step 4 — if that
were wrong, your own `.demo.env` would win and the wrong provider would render.

```bash
for p in openai anthropic gemini azure; do
  LLM_PROVIDER=$p LLM_MODEL=test-model \
  AZURE_OPENAI_ENDPOINT=https://r.openai.azure.com \
    bash scripts/render-gateway-config.sh
  echo "--- $p ---"
  sed -n '/BEGIN_LLM_PROVIDER/,/END_LLM_PROVIDER/p' .gen/agentgateway-config.yaml
done
```

Expected: each iteration prints its own provider key (`openAI:`, `anthropic:`,
`gemini:`, `azure:`) with `model: test-model`, and the azure one shows
`resourceName: r`. Then confirm no placeholder survives:

```bash
grep -c "__LLM_MODEL__\|__AZURE_RESOURCE_NAME__" .gen/agentgateway-config.yaml || true
```

Expected: `0`.

- [ ] **Step 9: Commit**

```bash
git add k8s/workloads/llm-providers k8s/workloads/agentgateway-config.yaml \
        scripts/render-gateway-config.sh scripts/test-render-gateway-config.sh \
        tests/fixtures/llm-route-azure.expected.yaml .gitignore
git commit -m "feat(gateway): generate the /llm provider block from .demo.env

Four provider fragments (openai, anthropic, gemini, azure) spliced between
sentinels into .gen/agentgateway-config.yaml. jwtAuth and the llm:invoke rule
stay outside the generated region so the authorization posture cannot vary with
the provider. A golden test pins the azure render against the block deployed
today."
```

---

### Task 4: Schema validation and Makefile wiring

Makes the render load-bearing (`make apply` uses it) and adds the test that will catch provider-schema drift on a future image bump.

**Files:**
- Create: `scripts/validate-llm-providers.sh`
- Modify: `Makefile:290` (`apply` prerequisites), `Makefile:314-316` (ConfigMap source), `Makefile:386-402` (`seed-llm-secret`), plus two new targets
- Modify: `k8s/workloads/agentgateway.yaml:153-162` (env)

**Interfaces:**
- Consumes: `scripts/render-gateway-config.sh` from Task 3.
- Produces: `make configure-llm`, `make validate-llm`, and a `seed-llm-secret` that writes the `agentgateway-llm` Secret with key `LLM_API_KEY` (plus nothing else).

- [ ] **Step 1: Write the validation script**

Create `scripts/validate-llm-providers.sh`:

```bash
#!/usr/bin/env bash
# Render every provider fragment and run it through agentgateway's own config
# validator, using the exact image the demo deploys.
#
# This is the safety net for the three providers that cannot be driven end to end
# here. It is what caught, during design, that `provider: {ollama: {}}` and
# `{groq: {}}` are xDS-only at v1.4.1 and fail standalone config load.
#
# CAVEAT: --validate-only does NOT evaluate CEL (CLAUDE.md fact #29). It proves
# the provider block is well-formed and nothing about the jwtAuth/authorization
# rules, whose expressions are checked only at runtime.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="$(grep -o 'ghcr.io/agentgateway/agentgateway:[^ ]*' "$REPO_ROOT/k8s/workloads/agentgateway.yaml" | head -1)"
PROVIDERS="openai anthropic gemini azure"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
note() { printf '==> %s\n' "$*"; }

note "validating against $IMAGE"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

WORK="$TMP/repo"
mkdir -p "$WORK/scripts" "$WORK/k8s/workloads"
cp "$REPO_ROOT/scripts/render-gateway-config.sh" "$WORK/scripts/"
cp "$REPO_ROOT/k8s/workloads/agentgateway-config.yaml" "$WORK/k8s/workloads/"
cp -R "$REPO_ROOT/k8s/workloads/llm-providers" "$WORK/k8s/workloads/"

failed=0
for p in $PROVIDERS; do
  cat > "$WORK/.demo.env" <<EOF
LLM_PROVIDER=$p
LLM_MODEL=validation-model
AZURE_OPENAI_ENDPOINT=https://validation-resource.openai.azure.com
EOF
  bash "$WORK/scripts/render-gateway-config.sh" >/dev/null

  # The gateway resolves $VARS at load; supply dummies so validation reaches the
  # schema rather than stopping at an unset variable.
  if out=$(docker run --rm \
      -e LLM_API_KEY=dummy \
      -e AZURE_OPENAI_API_KEY=dummy \
      -v "$WORK/.gen:/c:ro" \
      "$IMAGE" -f /c/agentgateway-config.yaml --validate-only 2>&1); then
    green "  OK   $p"
  else
    red   "  FAIL $p"
    printf '%s\n' "$out" | sed 's/^/       /'
    failed=1
  fi
done

echo
if [ "$failed" -ne 0 ]; then
  red "ONE OR MORE PROVIDER FRAGMENTS FAILED VALIDATION"
  exit 1
fi
green "ALL PROVIDER FRAGMENTS VALIDATE"
```

```bash
chmod +x scripts/validate-llm-providers.sh
```

- [ ] **Step 2: Run it to verify all four pass**

```bash
bash scripts/validate-llm-providers.sh
```

Expected: `OK` for all four, then `ALL PROVIDER FRAGMENTS VALIDATE`.

Note: the gateway also fetches the Curity JWKS during load. If validation fails on a JWKS network error rather than a schema error, that is past schema validation and is the known behaviour recorded in CLAUDE.md fact #29 — treat a JWKS-only failure as a pass and record it in the script's comment header.

- [ ] **Step 3: Prove the validator actually catches a bad fragment**

A validation script that passes unconditionally is worse than none. Verify it fails:

```bash
cp k8s/workloads/llm-providers/openai.yaml /tmp/openai.yaml.bak
sed -i '' 's/openAI:/ollama:/' k8s/workloads/llm-providers/openai.yaml
bash scripts/validate-llm-providers.sh; echo "exit=$?"
cp /tmp/openai.yaml.bak k8s/workloads/llm-providers/openai.yaml
```

Expected: `FAIL openai` with ``unknown variant `ollama` ``, and `exit=1`. Then confirm the restore worked by rerunning the validator and seeing all four pass.

- [ ] **Step 4: Normalize the gateway's env**

In `k8s/workloads/agentgateway.yaml`, replace the two env entries at lines 153-162 with one:

```yaml
          env:
            # The ONLY upstream LLM credential in the system. Which vendor it
            # belongs to is decided by k8s/workloads/llm-providers/<provider>.yaml
            # at render time, so this Deployment is provider-agnostic.
            - name: LLM_API_KEY
              valueFrom:
                secretKeyRef:
                  name: agentgateway-llm
                  key: LLM_API_KEY
```

`AZURE_RESOURCE_NAME` is gone entirely — it is not a secret, and it is now a rendered value in the azure fragment.

- [ ] **Step 5: Rewrite `seed-llm-secret` and add the two new targets**

In the `Makefile`, replace the `seed-llm-secret` target (lines 386-402) with:

```make
.PHONY: seed-llm-secret
seed-llm-secret: ## Create the agentgateway LLM provider secret (from .demo.env if present, else prompt)
	@if [ -f .demo.env ]; then . ./.demo.env; fi; \
	  k="$${LLM_API_KEY:-$$AZURE_OPENAI_API_KEY}"; \
	  if [ -z "$$k" ]; then read -r -s -p "LLM_API_KEY: " k; echo; fi; \
	  test -n "$$k" || { echo "LLM_API_KEY empty — abort"; exit 1; }; \
	  kubectl create namespace $(NS_MCP) --dry-run=client -o yaml | kubectl apply -f - >/dev/null; \
	  kubectl -n $(NS_MCP) create secret generic agentgateway-llm \
	    --from-literal=LLM_API_KEY="$$k" \
	    --dry-run=client -o yaml | kubectl apply -f -; \
	  $(call restart_if_exists,$(NS_MCP),agentgateway)

.PHONY: render-gateway-config
render-gateway-config: ## Render .gen/agentgateway-config.yaml from .demo.env (run by `make apply`)
	bash scripts/render-gateway-config.sh

.PHONY: configure-llm
configure-llm: render-gateway-config ## Switch LLM provider: re-render, update the ConfigMap, restart the gateway
	kubectl -n $(NS_MCP) create configmap agentgateway-config \
	  --from-file=config.yaml=.gen/agentgateway-config.yaml \
	  --dry-run=client -o yaml | kubectl apply -f -
	$(call restart_if_exists,$(NS_MCP),agentgateway)

.PHONY: validate-llm
validate-llm: ## Validate every provider fragment against the pinned agentgateway image
	bash scripts/validate-llm-providers.sh
	bash scripts/test-render-gateway-config.sh
```

The `LLM_API_KEY:-$$AZURE_OPENAI_API_KEY` fallback is the back-compat path for a `.demo.env` written before this feature.

- [ ] **Step 6: Wire the render into `make apply`**

Change line 290 from:

```make
apply: curity-procedures curity-truststore ## Apply all manifests (assumes images built/loaded) and run routing
```

to:

```make
apply: curity-procedures curity-truststore render-gateway-config ## Apply all manifests (assumes images built/loaded) and run routing
```

and change the ConfigMap source at lines 314-316 to read from the rendered artifact:

```make
	kubectl -n $(NS_MCP) create configmap agentgateway-config \
	  --from-file=config.yaml=.gen/agentgateway-config.yaml \
	  --dry-run=client -o yaml | kubectl apply -f -
```

Update the comment above it (lines 311-313) so it no longer calls the tracked file "the single source of truth":

```make
	# agentgateway: render its config from k8s/workloads/agentgateway-config.yaml
	# + the LLM provider fragment chosen in .demo.env (see the render-gateway-config
	# prerequisite), then create the ConfigMap from .gen/ BEFORE the Deployment.
```

- [ ] **Step 7: Verify the Makefile wiring**

```bash
make validate-llm
rm -rf .gen && make render-gateway-config && test -f .gen/agentgateway-config.yaml && echo "render OK"
make -n apply | head -5
```

Expected: validation passes both scripts; the render recreates `.gen/`; `make -n apply` shows `bash scripts/render-gateway-config.sh` running before the `kubectl apply` lines.

- [ ] **Step 8: Commit**

```bash
git add scripts/validate-llm-providers.sh Makefile k8s/workloads/agentgateway.yaml
git commit -m "feat(make): render the gateway config in apply; validate every provider

make apply now renders .gen/agentgateway-config.yaml before creating the
ConfigMap; make configure-llm re-renders, updates it and restarts the gateway.
make validate-llm runs all four fragments through agentgateway v1.4.1's own
--validate-only, which is the only check the three untestable providers get.
The gateway Secret normalizes to a single LLM_API_KEY."
```

---

### Task 5: Env example and provider-agnostic smoke test

**Files:**
- Create: `.demo.env.example`
- Modify: `scripts/smoke-llm.sh:1-22` (header), `scripts/smoke-llm.sh:180-189` (credential assertion)
- Modify: `Makefile:485` (`smoke-llm` help text)

**Interfaces:**
- Consumes: the `.demo.env` contract from Task 3 and the `LLM_API_KEY` Secret key from Task 4.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the tracked env example**

Create `.demo.env.example`:

```sh
# Copy to .demo.env and fill in. .demo.env is gitignored; this file is not, so
# never put a real key here.
#
# Switching provider is this file plus `make configure-llm` — nothing else in the
# repo is provider-specific.

# openai | anthropic | gemini | azure
LLM_PROVIDER=openai

# Must be a model the provider above actually serves. A mismatch validates fine
# and fails at request time with the vendor's own error.
#   openai     gpt-4.1
#   anthropic  claude-sonnet-4-6
#   gemini     gemini-2.5-pro
#   azure      the DEPLOYMENT name in your Azure resource, not the base model
LLM_MODEL=gpt-4.1

# The one upstream LLM credential in the system. It lives only in the
# agentgateway pod; the agents never hold it.
LLM_API_KEY=

# azure only — the resource name is derived from this.
#AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com
```

- [ ] **Step 2: Update the smoke test's credential assertion**

In `scripts/smoke-llm.sh`, replace lines 180-189 with:

```bash
# ----- Credential moved: no upstream LLM key on the agent pods -------------------
# Checks BOTH names: LLM_API_KEY is the current one, AZURE_OPENAI_API_KEY the
# pre-2026-08-14 one, so this keeps catching the old leak as well as the new.
note "Credential moved: asserting no upstream LLM key on agent-copilot"
if ENV_LIST=$(kubectl -n agents set env deploy/agent-copilot --list 2>&1); then
  LEAKED=""
  for VAR in LLM_API_KEY AZURE_OPENAI_API_KEY; do
    if echo "$ENV_LIST" | grep -qi "$VAR"; then LEAKED="$LEAKED $VAR"; fi
  done
  if [ -n "$LEAKED" ]; then
    red "  upstream LLM key still present on agent-copilot:$LEAKED"; exit 1
  fi
  green "  OK (no upstream LLM key on agent-copilot)"
else
  note "  (non-fatal) could not read deploy/agent-copilot env: $ENV_LIST"
fi
```

- [ ] **Step 3: De-Azure the smoke test's header**

In `scripts/smoke-llm.sh`, replace lines 8-21 with:

```bash
# /llm/chat/completions route. The gateway validates the JWT, authorizes
# llm:invoke, swaps in the upstream provider key server-side, and forwards to
# whichever provider is configured in .demo.env. The agents never hold that key.
#
# Assertions:
#   [1/3] positive: Alice's subject token + copilot SVID exchange to
#         aud=llm-gateway (scope llm:invoke).
#   [2/3] positive (REAL egress): that llm-gateway token drives a chat
#         completion through the gateway → HTTP 200 (proves JWT validate +
#         llm:invoke authz + provider-key swap + a real upstream round-trip).
#   [3/3] negative: an aud=mcp-gateway / scope=obs:read token (no llm:invoke)
#         is denied AT the gateway (401/403), before any upstream call.
#   plus: no upstream LLM key (LLM_API_KEY / AZURE_OPENAI_API_KEY) is present in
#         agent-copilot's env — the credential moved server-side into the gateway.
```

Also update line 2's `→ Azure` framing and the `Topology:` paragraph's Azure references to say "the configured provider".

- [ ] **Step 4: Update the Makefile help text**

Change line 485 from `smoke-llm: ## Smoke: identity-bound LLM egress (user → agent → gateway /llm → Azure). Needs SMOKE_SUBJECT_TOKEN.` to:

```make
smoke-llm: ## Smoke: identity-bound LLM egress (user → agent → gateway /llm → provider). Needs SMOKE_SUBJECT_TOKEN.
```

- [ ] **Step 5: Verify the script still parses and no Azure framing remains**

```bash
bash -n scripts/smoke-llm.sh && echo "syntax OK"
grep -in "azure" scripts/smoke-llm.sh
```

Expected: syntax OK, and the only `azure` hits are the two intentional `AZURE_OPENAI_API_KEY` back-compat mentions.

- [ ] **Step 6: Commit**

```bash
git add .demo.env.example scripts/smoke-llm.sh Makefile
git commit -m "test(smoke): make the LLM egress smoke test provider-agnostic

The three assertions were never Azure-specific; only the framing and the
credential-containment check were. That check now asserts neither LLM_API_KEY
nor AZURE_OPENAI_API_KEY is present, so it catches the old leak and the new.
Adds a tracked .demo.env.example documenting the one-file provider contract."
```

---

### Task 6: Documentation

The last task, because it should describe what was actually built.

**Files:**
- Create: `docs/llm-providers.md`
- Modify: `CLAUDE.md` (fact #22, and the `make` command list)
- Modify: `docs/demo.md`, `docs/design.md`, `docs/architecture.md`, `README.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Write `docs/llm-providers.md`**

Create the page with these sections, written out in full — no outline placeholders:

1. **Switching provider** — copy `.demo.env.example` to `.demo.env`, set `LLM_PROVIDER`/`LLM_MODEL`/`LLM_API_KEY`, run `make seed-llm-secret configure-llm`. State that nothing else in the repo is provider-specific.
2. **The four providers** — a table of `LLM_PROVIDER` value, where to get a key, an example `LLM_MODEL`, and any extra variable (`AZURE_OPENAI_ENDPOINT` for azure only).
3. **Which is verified** — state plainly that Azure OpenAI is the provider driven end to end during development and that the other three are schema-validated against the pinned image by `make validate-llm`, not exercised against the live vendor.
4. **Why only four** — the v1.4.1-vs-docs discrepancy: agentgateway's published docs list 19 providers, but standalone YAML at v1.4.1 accepts only `openAI, gemini, vertex, anthropic, bedrock, azure, copilot, custom`; the 13 named presets (ollama, groq, openrouter, …) are xDS-only and fail config load. Include the exact error text ``unknown variant `ollama` `` so a search lands here.
5. **Adding a provider agentgateway supports natively** — write a fragment in `k8s/workloads/llm-providers/`, add its name to the `case` in `render-gateway-config.sh` and to `PROVIDERS` in `validate-llm-providers.sh`, run `make validate-llm`. Include the Anthropic `location` trap as the worked example of what to watch for.
6. **Reaching Groq / OpenRouter / Ollama / vLLM** — the `custom` extension point that was deliberately not built. Show the block and say it is a single fragment plus one `.demo.env` variable:

   ```yaml
           backendAuth:
             key:
               value: $LLM_API_KEY
       backends:
       - ai:
           name: llm
           provider:
             custom:
               model: __LLM_MODEL__
               providerOverride: groq
               formats:
               - type: completions
                 path: /openai/v1/chat/completions
           hostOverride: api.groq.com:443
   ```

7. **What does not change** — the RFC 8693 exchange to `aud=llm-gateway`, the `llm:invoke` requirement, the fact that agents never hold the vendor key. Point at `docs/design.md` §3.6.

- [ ] **Step 2: Rewrite CLAUDE.md fact #22**

Replace the existing fact #22 with text that keeps its true claims and corrects the rest. It must state: both agents exchange to `aud=llm-gateway`/`llm:invoke` and call the gateway's `/llm` route (unchanged); the gateway holds the only upstream key, now as `$LLM_API_KEY` rather than `$AZURE_OPENAI_API_KEY`; the provider block is **generated** from `.demo.env` by `scripts/render-gateway-config.sh` into `.gen/agentgateway-config.yaml`, so editing the tracked `agentgateway-config.yaml`'s llm route between the sentinels has no effect; the gateway pins `model:`, so agents send `model-pinned-at-gateway` and have no `LLM_MODEL`; `buildLlm` has no direct-to-vendor mode and reintroducing one would bypass the `llm:invoke` check; **Anthropic breaks if `backendAuth.key.location` is set** (the `x-api-key`/`anthropic-version` rewrite only runs when it is implicit) while Azure requires it; and at v1.4.1 only eight provider keys parse from standalone YAML, the named presets being xDS-only. Keep the `resourceType: openAI` and `@ai-sdk/openai-compatible` (fact #30) cross-references.

- [ ] **Step 3: Add the new targets to CLAUDE.md's command list**

In the `## Commands` block, add after `make seed-secrets`:

```
make configure-llm   # switch LLM provider after editing .demo.env
make validate-llm    # validate all provider fragments against the pinned gateway image
```

and update `make seed-secrets`' description, which currently says "Azure LLM key".

- [ ] **Step 4: Sweep the remaining docs**

```bash
grep -rn -i "azure" docs/demo.md docs/design.md docs/architecture.md README.md
```

For each hit, replace hard-coded Azure framing with "the configured LLM provider" and link to `docs/llm-providers.md`. Specific known spots: `docs/design.md` §3.6's scope table (the `llm-gateway` row's description), `docs/architecture.md`'s topology diagram legend, and `README.md`'s prerequisites, which should now say "an API key for one of: OpenAI, Anthropic, Gemini, Azure OpenAI".

Skip `docs/superpowers/` entirely — those are historical records of what was true when written. Skip `docs/explainers/`; it is gitignored.

- [ ] **Step 5: Verify no stale references remain**

```bash
grep -rn "AZURE_RESOURCE_NAME\|LLM_PROVIDER=gateway\|llmProvider" \
  --include="*.md" --include="*.yaml" --include="*.ts" \
  . | grep -v node_modules | grep -v docs/superpowers | grep -v .gen/
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add docs/llm-providers.md CLAUDE.md docs README.md
git commit -m "docs: document the pluggable LLM provider contract

Adds docs/llm-providers.md and rewrites CLAUDE.md fact #22, which stated Azure
as fixed fact. Records the two traps: Anthropic's x-api-key rewrite is
suppressed if backendAuth location is set explicitly, and at v1.4.1 only eight
provider keys parse from standalone YAML (the named presets are xDS-only)."
```

---

## Final verification

After all six tasks, on a running cluster:

```bash
pnpm turbo run build typecheck test    # all workspaces green
make validate-llm                      # 4 fragments + golden test
make images apply                      # rebuild and redeploy
make status                            # all pods healthy
make smoke                             # full auth/authz suite incl. smoke-llm
```

Then switch provider live to prove the whole point — edit `.demo.env` to a second provider, run `make seed-llm-secret configure-llm`, and drive one chat turn from `https://app.localtest.me`. Record the result in the spec's Status line.
