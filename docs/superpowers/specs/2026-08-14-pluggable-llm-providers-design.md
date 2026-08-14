# Pluggable LLM providers

**Date:** 2026-08-14
**Branch:** `feat/pluggable-llm-providers`
**Status:** design approved, not yet implemented.

## Goal

Two changes that serve one outcome — someone who clones this demo can point it at
whatever LLM they already have a key for, in one file, and everything else keeps
working:

1. **Standardize.** The agents reach an LLM through agentgateway's `/llm` route
   and nowhere else. The `anthropic` and `ollama` branches in `buildLlm` — a
   direct-to-vendor path that bypasses the `llm:invoke` scope check and puts a
   static vendor key back in the agent's environment — are deleted, not fixed.
2. **Make the upstream pluggable.** The provider block in the gateway config is
   generated from `.demo.env` instead of being hard-coded to Azure OpenAI.

Non-goals: changing the RFC 8693 exchange to `aud=llm-gateway`, the `llm:invoke`
authorization rule, the request wire format, or anything about MCP. The security
properties of the LLM hop are unchanged by this work; only what sits upstream of
the gateway becomes configurable.

## Verified facts this design rests on

All measured against the pinned `ghcr.io/agentgateway/agentgateway:v1.4.1`, using
`--validate-only` (the technique from CLAUDE.md fact #29) and the source checkout
at `~/workspace/curity/ai-work/projects/agentgateway`. Re-verify on an image bump.

**The published provider list does not describe our pin.** agentgateway's docs
list 19 first-class providers, but those track `latest`. At v1.4.1 standalone YAML
accepts exactly eight keys:

```
openAI, gemini, vertex, anthropic, bedrock, azure, copilot, custom
```

`provider: {ollama: {}}` and `provider: {groq: {}}` fail config load with
``unknown variant `ollama` ``. The thirteen named presets (ollama, groq, mistral,
openrouter, deepseek, togetherai, xai, fireworks, cerebras, cohere, huggingface,
baseten, deepinfra) exist in `crates/llm/src/custom.rs` at v1.4.1 but are reachable
**only through xDS** (`types/agent_xds.rs`); the local-config `AIProvider` enum has
no variant for them. From standalone YAML they must be spelled as `custom` plus
`hostOverride` — which is why this design ships only providers that have a real
native key.

**`model` is optional on every provider, and it overrides the client's request.**
`openai.rs`/`anthropic.rs`/`gemini.rs` all document it as "Model ID to send to X,
overriding the model in the client request". This is what makes it possible for
the model name to live in exactly one place.

**`backendAuth.key` without `location` defaults to `Authorization: Bearer`, and
the per-provider fixup keys on whether you set it.** `http/auth/mod.rs:205-212`
records an `AppliedBackendAuthLocation { explicit }` flag. `llm/mod.rs:1247-1276`
then rewrites for Anthropic: the key moves to `x-api-key` and an
`anthropic-version: 2023-06-01` header is added — **but only when `explicit` is
false.** Setting `location` for clarity would suppress the rewrite and break
Anthropic. Azure is the mirror image: it gets no fixup, so it needs the explicit
`api-key` location it already has.

**Required fields differ per provider:** `bedrock` needs `region`, `vertex` needs
`projectId`, `azure` needs `resourceName`. `hostOverride` is a `host:port` string,
not a map.

## Scope: which providers ship

| Provider | Key | Auth | Ships |
| --- | --- | --- | --- |
| OpenAI | `openAI` | `key`, default location | yes |
| Anthropic | `anthropic` | `key`, **no** `location` | yes |
| Gemini | `gemini` | `key`, default location | yes |
| Azure OpenAI | `azure` | `key` + explicit `api-key` header | yes |
| Bedrock / Vertex | `bedrock` / `vertex` | `auth.aws` / `auth.gcp` | no |
| Ollama, Groq, OpenRouter, … | `custom` + `hostOverride` | varies | no |

All four shipped providers are native keys, so this design needs no `custom`
machinery, no `hostOverride`, and no `formats` — every fragment is a provider key
and a `backendAuth` block.

**Documented extension point, deliberately not built.** A fifth fragment using
`custom` + a host variable would unlock Groq, OpenRouter, Together, DeepSeek,
Mistral, xAI and any OpenAI-compatible endpoint including vLLM and Ollama. It is
one file and one `.demo.env` variable. It is left out to keep the first version
small; `docs/llm-providers.md` will say so explicitly and show the block, so the
absence reads as a decision rather than an oversight.

## §1 — Agent side: one path, no model

### `packages/agent-runtime/src/llm.ts`

`LlmConfig` loses `llmProvider` and `llmModel`; `llmGatewayUrl` becomes required
rather than optional. `buildLlm` becomes a single `createOpenAICompatible` call —
the two `if` branches and the trailing `throw` all go.

The `@ai-sdk/openai-compatible` choice and its comment stay exactly as they are:
that is CLAUDE.md fact #30 and is unrelated to this work.

Agents no longer name a model, so `buildLlm` sends a constant:

```ts
/**
 * The gateway's provider block pins `model:`, which overrides whatever the client
 * sends. Agents therefore have no model to configure — but Chat Completions
 * requires the field, so we send this.
 *
 * The value is deliberately self-describing: if a provider fragment ever omits
 * `model:`, this string reaches the upstream vendor and the error reads
 * `model 'model-pinned-at-gateway' not found`, which diagnoses itself.
 */
const GATEWAY_PINNED_MODEL = 'model-pinned-at-gateway';
```

### Dependency

`@ai-sdk/anthropic` is removed from `packages/agent-runtime/package.json`. It has
no other consumer.

### Both agents

`apps/agent-copilot/src/config.ts` and `apps/agent-specialist/src/config.ts` drop
`llmProvider` and `llmModel` from the `Config` interface, drop the
`LLM_PROVIDER` validation branch, and drop both defaults. `llmGatewayUrl`,
`llmGatewayAudience` and `llmGatewayScope` are unchanged.

`apps/agent-copilot/src/llm.ts` (the TS2742 re-export wrapper) and
`apps/agent-specialist/src/executor.ts` need no change — both call
`buildLlm(cfg, { accessToken })` and `cfg` merely gets narrower.

`k8s/workloads/agent-copilot.yaml` and `agent-specialist.yaml` drop the
`LLM_PROVIDER` and `LLM_MODEL` env entries. **These manifests then contain nothing
provider-specific, which is the property that makes switching providers a
one-file change.**

## §2 — Gateway side: four fragments, one marker

### Fragments

```
k8s/workloads/llm-providers/openai.yaml
k8s/workloads/llm-providers/anthropic.yaml
k8s/workloads/llm-providers/gemini.yaml
k8s/workloads/llm-providers/azure.yaml
```

Each holds the two provider-varying regions of the `llm` route as pre-indented
text: the `backendAuth` policy and the `backends` list. They are not contiguous in
the file — `backendAuth` is a sibling of `jwtAuth` under `policies:`, and
`backends:` follows `policies:` — so the marker spans from `backendAuth` to the end
of the route, and the fragment supplies both.

`openai.yaml`:

```yaml
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

`anthropic.yaml` is the same shape with `anthropic:` — and carries a comment
recording why `location` must stay absent (the `x-api-key` and `anthropic-version`
rewrite is suppressed when `explicit` is true).

`azure.yaml` keeps today's explicit header and gains two rendered values:

```yaml
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

`resourceType: openAI` keeps its lowercase-`o` spelling (CLAUDE.md fact #22).

The backend `name:` is `llm` in every fragment rather than the provider's name.
It is a local label, and holding it constant keeps `mcp.target`-style telemetry
and any future CEL reference stable across a provider switch.

### What is NOT in a fragment

`jwtAuth` (issuer, `aud=llm-gateway`, JWKS URL) and the `authorization` rule
requiring `llm:invoke` stay in the tracked config, outside the marker. The
authorization posture of the LLM hop must not vary with the provider, and keeping
it lexically outside the generated region makes that structural instead of a
convention someone has to remember.

### `scripts/render-gateway-config.sh`

Reads `.demo.env`, selects the fragment, substitutes `__LLM_MODEL__` and
`__AZURE_RESOURCE_NAME__`, splices it between sentinel markers in
`k8s/workloads/agentgateway-config.yaml`, and writes `.gen/agentgateway-config.yaml`.

Sentinels follow the existing `scripts/embed-mkcert-ca.sh` convention:

```yaml
      # >>> llm-provider (generated by scripts/render-gateway-config.sh) >>>
      # <<< llm-provider <<<
```

The tracked file keeps a working `azure` block between the markers so it stays
readable and valid on its own; the script replaces whatever is there. `.gen/` is
gitignored. Written in bash 3.2-compatible form (CLAUDE.md: macOS bash is 3.2, no
`declare -A`).

Failure modes, all fatal with a legible message: unknown `LLM_PROVIDER`, missing
`LLM_MODEL`, `azure` without `AZURE_OPENAI_ENDPOINT`, missing marker pair.

### `make apply`

Renders before creating the ConfigMap, the same way it already runs
`curity-truststore` and `curity-procedures`:

```make
kubectl -n $(NS_MCP) create configmap agentgateway-config \
  --from-file=config.yaml=.gen/agentgateway-config.yaml \
  --dry-run=client -o yaml | kubectl apply -f -
```

`make configure-llm` is the re-run path after a `.demo.env` edit: render, update
the ConfigMap, restart the gateway. Rendering alone would leave the cluster on the
old provider, so all three steps belong to the one target.

### Files

New: `k8s/workloads/llm-providers/{openai,anthropic,gemini,azure}.yaml`,
`scripts/render-gateway-config.sh`, `scripts/validate-llm-providers.sh`,
`.demo.env.example`, `docs/llm-providers.md`.

Modified: `packages/agent-runtime/src/{llm.ts,llm.test.ts,tool-errors.test.ts}`,
`packages/agent-runtime/package.json`, `apps/agent-{copilot,specialist}/src/config.ts`,
`k8s/workloads/agent-{copilot,specialist}.yaml`,
`k8s/workloads/agentgateway{,-config}.yaml`, `scripts/smoke-llm.sh`, `Makefile`,
`.gitignore` (add `.gen/`), `CLAUDE.md`, and the docs listed below.

## §3 — One env contract

`.demo.env`, with a new tracked `.demo.env.example` documenting it:

```sh
LLM_PROVIDER=openai          # openai | anthropic | gemini | azure
LLM_MODEL=gpt-4.1
LLM_API_KEY=sk-...
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com   # azure only
```

**The key normalizes to one variable, `LLM_API_KEY`.** The Secret stays
`agentgateway-llm` in the `mcp` namespace but carries `LLM_API_KEY` instead of
`AZURE_OPENAI_API_KEY`, and `k8s/workloads/agentgateway.yaml` drops
`AZURE_RESOURCE_NAME` entirely — it is non-secret and becomes a rendered value.
The Deployment then holds nothing provider-specific.

`make seed-llm-secret` becomes provider-agnostic: prompt for `LLM_API_KEY`, and
for `AZURE_OPENAI_ENDPOINT` only when the provider is `azure`.

**Backward compatibility.** An existing `.demo.env` with only
`AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` and no `LLM_PROVIDER` resolves
to `LLM_PROVIDER=azure`, `LLM_MODEL=gpt-4.1`, `LLM_API_KEY=$AZURE_OPENAI_API_KEY`.
Today's setup keeps working without an edit. `docs/llm-providers.md` documents the
shim as transitional.

## §4 — Testing

Only one provider can be driven end to end, so the safety net is schema
validation against the pinned image rather than mocks that would only assert our
own beliefs about the schema.

**`make validate-llm`** (`scripts/validate-llm-providers.sh`) renders all four
providers and runs each through
`docker run … agentgateway:v1.4.1 -f … --validate-only`. This is the test that
earns its keep: it is what caught the ollama/groq xDS-only issue during design,
and it is what will catch provider-schema drift on an image bump. Caveat to
record in the script: `--validate-only` does **not** check CEL (fact #29), so it
proves the provider block is well-formed and nothing about the `jwtAuth`/
`authorization` rules.

**Golden test: rendering `azure` reproduces today's committed block.** The one
provider that can be verified live is the one being refactored out of the tracked
file, so a byte-comparison against the current `llm` route is the evidence that
this change is behaviour-preserving. Modulo the `$AZURE_OPENAI_API_KEY` →
`$LLM_API_KEY` and `$AZURE_RESOURCE_NAME` → rendered-value substitutions, which
the test states explicitly rather than normalizing away.

**`packages/agent-runtime/src/llm.test.ts`** keeps the request-path and bearer
assertions (both pin fact #30), drops the anthropic case, and gains one asserting
the request body's `model` is `model-pinned-at-gateway` — so a future change that
reintroduces agent-side model selection fails loudly. `tool-errors.test.ts` needs
its `LlmConfig` literals updated; its subject matter is unaffected.

**`scripts/smoke-llm.sh`** keeps all three assertions unchanged — they test the
exchange, the gateway's authz, and a real round-trip, none of which are
provider-specific. The credential-containment check widens to assert that
**both** `LLM_API_KEY` and `AZURE_OPENAI_API_KEY` are absent from `agent-copilot`,
so it still catches the old leak and the new one. Header comments lose their
Azure framing.

## Documentation

- **`docs/llm-providers.md`** (new) — the "plug in your provider" page: the four
  providers, the `.demo.env` contract, `make configure-llm`, the `custom`
  extension point, and the v1.4.1-vs-docs provider-list discrepancy so nobody
  else rediscovers it.
- **CLAUDE.md fact #22** — rewritten. It currently states Azure as fixed fact and
  names `AZURE_OPENAI_API_KEY`. It must record that the provider is generated,
  that the model is pinned gateway-side, and the Anthropic `location` trap.
- **`docs/demo.md`, `docs/design.md` §3.6, `docs/architecture.md`, `README.md`,
  `docs/explainers/llm-tool-calling.md`** — replace hard-coded Azure references.
  `docs/explainers/agentgateway-mcp-front-door.md` and
  `workload-manifests.md` mention Azure env vars that no longer exist.

## Risks

**The three untested providers are untested.** Schema-valid is not the same as
working; a wrong path prefix or auth header would only surface when a user tries
it. Mitigated by deriving every fragment from the v1.4.1 source rather than from
the docs, and by keeping the set small. `docs/llm-providers.md` should say which
provider is verified live.

**`.gen/` is a new indirection.** Someone editing `agentgateway-config.yaml` and
applying without re-rendering gets a stale ConfigMap. Mitigated by `make apply`
always rendering, and by the tracked file carrying a valid block between its
markers so reading it is never misleading.

**Model/provider mismatch is a runtime error, not a config error.**
`LLM_PROVIDER=openai` with `LLM_MODEL=claude-sonnet-4-6` validates fine and fails
at the vendor. Accepted: a model allow-list per provider would go stale faster
than it would help.
