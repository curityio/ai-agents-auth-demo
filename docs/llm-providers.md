# LLM providers

The agents reach an LLM through exactly one path: agentgateway's `/llm` route
(CLAUDE.md fact #22). Which vendor sits behind that route is a gateway-side
config choice, driven by one file, `.demo.env`. Nothing about the RFC 8693
exchange, the `llm:invoke` scope, or the agent code changes when you switch
providers — see [§7](#7-what-does-not-change).

---

## 1. Switching provider

```bash
cp .demo.env.example .demo.env
```

Edit `.demo.env`:

```sh
LLM_PROVIDER=azure           # openai | anthropic | gemini | azure
LLM_MODEL=claude-sonnet-4-6  # on azure: the deployment name
LLM_API_KEY=...
# azure only — a Foundry PROJECT endpoint (GPT + Claude) or an Azure OpenAI resource (GPT)
AZURE_OPENAI_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
```

**`azure` is the default** — both in this file and at the `make demo` prompt —
because it is the provider this demo is developed against. It and `anthropic`
are the two verified end to end (§3). For any other provider, delete the
`AZURE_OPENAI_ENDPOINT` line. Because azure requires that endpoint, a tree with
no `.demo.env` at all now fails the render with a message naming the missing
variable, rather than quietly falling back to a provider nobody chose.

Then, against a running cluster:

```bash
make seed-llm-secret configure-llm
```

`seed-llm-secret` writes `LLM_API_KEY` into the `agentgateway-llm` Secret (ns
`mcp`); `configure-llm` re-renders the gateway config from `.demo.env`, updates
the `agentgateway-config` ConfigMap, and restarts the gateway deployment so the
new provider block takes effect. Both steps are required — rendering alone
updates a gitignored file on disk but leaves the running ConfigMap, and
therefore the cluster, on the old provider.

**Nothing else in the repo is provider-specific.** The two agent Deployments
(`k8s/workloads/agent-copilot.yaml`, `agent-specialist.yaml`) carry no
`LLM_PROVIDER`/`LLM_MODEL` env vars — the agents don't know or care which vendor
answers `/llm`, and always send a placeholder model name (see [§4 of
`design.md`](design.md), and `packages/agent-runtime/src/llm.ts`). Switching
provider is a `.demo.env` edit plus the one `make` target above; nothing in
`apps/` or `packages/` is touched.

`make demo`'s first-time interactive bootstrap (`scripts/demo-inputs.sh`) asks
for the same four values up front — `LLM_PROVIDER` (default `azure`), the key
(masked on echo, with a warning for a suspiciously short paste), `LLM_MODEL`
(default per provider, matching `render-gateway-config.sh`), and
`AZURE_OPENAI_ENDPOINT` only when the provider is `azure` — and writes them to
`.demo.env` (mode 0600). An existing `.demo.env` that already carries a key is
reused verbatim, so a file hand-written from `.demo.env.example` is never
overwritten; delete it to be prompted again.

**Back-compat.** A `.demo.env` written before this feature — one that carries
only `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` and no `LLM_PROVIDER` —
still resolves to `LLM_PROVIDER=azure`, `LLM_MODEL=gpt-4.1`, and
`LLM_API_KEY=$AZURE_OPENAI_API_KEY`. A pre-existing setup keeps working without
an edit; this shim exists in `scripts/render-gateway-config.sh` and is
transitional.

---

## 2. The four providers

| `LLM_PROVIDER` | Get a key | Example `LLM_MODEL` | Extra variable |
| --- | --- | --- | --- |
| `openai` | https://platform.openai.com/api-keys | `gpt-4.1` | — |
| `anthropic` | https://console.anthropic.com/settings/keys | `claude-sonnet-4-6` | — |
| `gemini` | https://aistudio.google.com/apikey | `gemini-2.5-pro` | — |
| `azure` | an Azure AI Foundry resource (GPT + Claude) or an Azure OpenAI resource (GPT only) — see [§2.1](#21-azure-two-resource-types) | the **deployment name**, e.g. `claude-sonnet-4-6` or `gpt-4.1` | `AZURE_OPENAI_ENDPOINT` — its host picks the resource type |

Each row is a fragment in `k8s/workloads/llm-providers/` (`azure` has two,
`azure-openai.yaml` and `azure-foundry.yaml`),
supplying the `backendAuth` policy and the `backends` block for the gateway's
`/llm` route — see [§5](#5-adding-a-provider-agentgateway-supports-natively)
for the shape.

### 2.1 Azure: two resource types

`LLM_PROVIDER=azure` covers two kinds of Azure resource. The host in
`AZURE_OPENAI_ENDPOINT` decides which fragment is rendered:

| `AZURE_OPENAI_ENDPOINT` | Resource | Serves | Fragment |
| --- | --- | --- | --- |
| `https://<res>.services.ai.azure.com/api/projects/<project>` | Azure AI Foundry (kind `AIServices`) | GPT **and** Claude | `azure-foundry.yaml` |
| `https://<res>.openai.azure.com` | Azure OpenAI (kind `OpenAI`) | GPT only | `azure-openai.yaml` |

Anything else — including the `https://<res>.cognitiveservices.azure.com/` that
`az cognitiveservices account show` prints — fails the render with the two shapes
above. Foundry needs the **project** endpoint (the one the Foundry portal shows on
the project overview): agentgateway sends GPT deployments to
`/api/projects/<project>/openai/v1/chat/completions`, and a project is generally
not named after its resource.

On Foundry, GPT versus Claude is just `LLM_MODEL`. **A Claude deployment's name
must start with `claude`** — agentgateway v1.4.1 decides "this is Claude" by that
prefix, then translates the agents' Chat Completions request to Anthropic Messages
at `/anthropic/v1/messages` and adds `anthropic-version`. Name it `sonnet-prod` and
the request goes the OpenAI way, which Foundry refuses with `404 api_not_supported`.
The render cannot check this; it does not see deployment names.

**The Foundry auth-header trap.** Measured on 2026-09-26 with a real key:

| Request | `api-key` | `x-api-key` | `Authorization: Bearer <key>` |
| --- | --- | --- | --- |
| Claude, `/anthropic/v1/messages` | 401 | 200 | 200 |
| GPT, `/api/projects/<p>/openai/v1/chat/completions` | 200 | 401 | 200 |

Bearer is the only header both families accept, and it is what a `backendAuth.key`
with no `location` sends. So `azure-foundry.yaml` has **no** `location:` — the
opposite of `azure-openai.yaml` next to it, which needs `api-key`. Copying one onto
the other breaks whichever family the copied header does not suit, and
`make validate-llm` cannot see it (the config is still well-formed).

**Creating a Foundry resource for this demo** (what was done for
`ai-agents-demo-suren-foundry`):

- A **new** resource of kind `AIServices`, not an Azure OpenAI one, in a region
  whose catalog lists Claude — Sweden Central does, West Europe does not.
- Key authentication must be enabled (`disableLocalAuth` not `true`).
- Create a project on it; its endpoint is what goes in `AZURE_OPENAI_ENDPOINT`.
- A Claude deployment needs `properties.modelProviderData` (`organizationName`,
  `countryCode`, `industry`). The Azure CLI has no flag for it and
  `api-version=2025-06-01` silently drops it; the management API accepts it at
  `api-version=2025-10-01-preview`:

  ```bash
  az rest --method put --url "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<res>/deployments/claude-sonnet-4-6?api-version=2025-10-01-preview" \
    --body '{"sku":{"name":"GlobalStandard","capacity":50},"properties":{"model":{"format":"Anthropic","name":"claude-sonnet-4-6","version":"1"},"modelProviderData":{"organizationName":"<org>","countryCode":"<CC>","industry":"technology"}}}'
  ```

Gemini is not offered on Azure; Google's hosted Gemini is Vertex AI, which is not
shipped here (see §5).

---

## 3. Which is verified

**Azure (both resource types) and Anthropic are exercised end to end.**

- **Azure OpenAI** is the provider driven through the whole stack during
  development: seeded, deployed, and used to actually answer a chat turn from
  `https://app.localtest.me`, with the resulting trace inspected in Grafana.
- **Anthropic** (`claude-sonnet-4-6`) was verified on 2026-09-25 on a fresh
  `make demo` with `LLM_PROVIDER=anthropic`: the copilot answered from the web
  UI and a restart went through the specialist, so both agents' tool-calling
  loops ran over the gateway's Chat-Completions → Anthropic Messages
  translation. `make smoke-llm` passed as well — its `[2/3]` is a real upstream
  round-trip. That also confirms the implicit-`location` rewrite (the
  `x-api-key` / `anthropic-version` fixup described under
  [the Anthropic `location` trap](#5-adding-a-provider-agentgateway-supports-natively)) against the live vendor.
- **Azure AI Foundry** (`ai-agents-demo-suren-foundry`, Sweden Central) was
  verified on 2026-09-26: `make smoke-llm` passed with both
  `LLM_MODEL=claude-sonnet-4-6` and `LLM_MODEL=gpt-4.1` against the same resource
  and key. With Claude, the copilot answered a read question (`list_pods`) and a
  restart went through the specialist (`get_deployment` → `restart_deployment` →
  `get_deployment`) with an `acr=mfa` token from a real TOTP login. Both turns were
  sent to the copilot's `/chat` with real login tokens, not typed into the browser,
  and every gateway `/llm` span in both traces carried `gen_ai.usage.*`. That
  confirms the Chat Completions → Messages translation, the implicit Bearer key and
  `anthropic-version` on Foundry ([§2.1](#21-azure-two-resource-types)).

The other two — OpenAI and Gemini — are **schema-validated only**.
`make validate-llm` renders each fragment and runs it through agentgateway's
own `--validate-only` config check against the exact pinned image
(`ghcr.io/agentgateway/agentgateway:v1.5.0`), proving each fragment parses as a
well-formed provider block. Neither has been exercised against its
live vendor. Say so plainly rather than implying otherwise: a fragment that
loads cleanly can still have the wrong path prefix or the wrong auth header and
only fail when a real request reaches the vendor. Every fragment here was
derived from the agentgateway v1.4.1 source (`crates/llm/src/*.rs`), not from
the published docs, which is the strongest available mitigation short of
driving all four live — see [§4](#4-why-only-four).

---

## 4. Why only four

agentgateway's published documentation lists 19 first-class providers. That
page tracks `latest`, not the image this demo pins. At **v1.4.1**, and still at
**v1.5.0** (re-checked in source on the 2026-09-26 bump), standalone YAML config
accepts exactly eight provider keys:

```
openAI, gemini, vertex, anthropic, bedrock, azure, copilot, custom
```

The other thirteen — including the obvious first reach for a local/free
setup, Ollama, plus Groq, OpenRouter, Mistral, DeepSeek, Together AI, xAI,
Fireworks, Cerebras, Cohere, HuggingFace, Baseten, and DeepInfra — exist as
named presets in the v1.4.1 source (`crates/llm/src/custom.rs`), but the
local-config `AIProvider` enum has no variant for them; they're reachable only
through xDS (`types/agent_xds.rs`), which this demo's standalone-YAML config
doesn't use. Writing `provider: {ollama: {}}` (or `{groq: {}}`) into the
gateway config fails config load at exactly the schema-deserialization step
`make validate-llm` checks, with:

```
unknown variant `ollama`
```

That is not a typo or a missing feature flag — it is a real gap between the
docs and this pinned version, discovered by actually trying it, not by reading
a changelog. If you land on this page searching that error text, this is why:
reach the vendor through `custom` + `hostOverride` instead (see
[§6](#6-reaching-groq--openrouter--ollama--vllm)), and re-check on any
agentgateway version bump — the eight-key list is a property of v1.4.1–v1.5.0,
not a permanent architectural limit.

This is also why the four shipped providers are exactly OpenAI, Anthropic,
Gemini, and Azure OpenAI: they're the ones with a real native provider key at
this pin, so no fragment here needs `custom`, `hostOverride`, or a `formats`
block.

---

## 5. Adding a provider agentgateway supports natively

Bedrock and Vertex both have native keys at v1.4.1 (`bedrock` needs `region`;
`vertex` needs `projectId`) but aren't shipped, mainly because their auth
(`auth.aws` / `auth.gcp`) doesn't fit the single-`LLM_API_KEY` contract this
design standardized on. To add one:

1. Write `k8s/workloads/llm-providers/<provider>.yaml`, following the shape of
   the existing four fragments: a `backendAuth` block and a `backends: - ai:`
   block with `name: llm` (keep the backend's local label `llm` — it's what
   keeps `mcp.target`-style telemetry stable across a provider switch) and the
   provider-specific fields.
2. Add the provider's name to the `case` statement in
   `scripts/render-gateway-config.sh` (default model, any provider-specific
   rendered value).
3. Add the name to `PROVIDERS` in `scripts/validate-llm-providers.sh`.
4. Run `make validate-llm`.

**The Anthropic `location` trap is the worked example of what to watch for.**
agentgateway records whether a backend's `backendAuth.key.location` was set
explicitly (`http/auth/mod.rs`, `AppliedBackendAuthLocation.explicit`) and only
rewrites `Authorization: Bearer` → `x-api-key` and injects the
`anthropic-version: 2023-06-01` header **when that location was left implicit**
(`llm/mod.rs:1247-1276`). `k8s/workloads/llm-providers/anthropic.yaml` therefore
has no `location:` block at all — adding one "for clarity," which is exactly
what `azure-openai.yaml` right next to it does, silently suppresses both rewrites and
the upstream call fails to authenticate. Azure OpenAI is the mirror image: it gets no
per-provider fixup, so `azure-openai.yaml` *needs* the explicit `api-key` header
location it already has — and Azure AI Foundry is the mirror of *that*:
`azure-foundry.yaml` must leave `location` implicit, because Bearer is the only
header both its GPT and Claude deployments accept ([§2.1](#21-azure-two-resource-types)). This asymmetry is the single most likely thing a future
contributor "fixes" by making the two fragments look more alike. Don't.

More generally: required fields differ per provider (`bedrock` wants `region`,
`vertex` wants `projectId`, `azure` wants `resourceName`), and `hostOverride`
is a `host:port` string, not a map. `--validate-only` (used by
`make validate-llm`) catches a malformed field, but **not** a wrong-but-valid
one — see the caveat in [§3](#3-which-is-verified) and the note under
`make validate-llm` in `scripts/validate-llm-providers.sh`:
`--validate-only` does not evaluate CEL, so it proves a provider block is
well-formed and says nothing about the `jwtAuth`/`authorization` rules that
gate the route (CLAUDE.md fact #29).

---

## 6. Reaching Groq / OpenRouter / Ollama / vLLM

Every OpenAI-compatible endpoint that isn't one of the eight native keys —
Groq, OpenRouter, Together AI, DeepSeek, Mistral, xAI, a self-hosted vLLM, or
Ollama — is reachable through agentgateway's `custom` provider plus
`hostOverride`. This is a **documented extension point that was deliberately
not built** for the first version of this feature, to keep it small; it is one
fragment and one `.demo.env` variable, not new machinery:

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

Adding this for real means: a fifth fragment
(`k8s/workloads/llm-providers/custom.yaml` or a per-vendor variant), a new
`.demo.env` variable for the host (Groq's `api.groq.com:443` and a local
Ollama's `localhost:11434` are both just a `hostOverride` string), and the same
`case`/`PROVIDERS` wiring as [§5](#5-adding-a-provider-agentgateway-supports-natively).
Ollama specifically is worth calling out: it's one of the thirteen presets
that fails as a *named* provider key at v1.4.1 ([§4](#4-why-only-four)), but it
serves an OpenAI-compatible `/v1/chat/completions` surface, so it's reachable
through this same `custom` route — the failure in §4 is about the shorthand
`{ollama: {}}` key, not about Ollama itself being unreachable.

---

## 7. What does not change

Switching providers changes what sits **upstream of agentgateway**. Everything
on the agent side of the `/llm` route is untouched:

- Both agents still exchange the user's access token (subject) and their
  SPIFFE JWT-SVID (actor) for `aud=llm-gateway`, `scope=llm:invoke` — one RFC
  8693 call, same as any other hop.
- The gateway still requires that exact scope on `/llm` before forwarding
  anywhere, regardless of which provider fragment is loaded — `jwtAuth` and
  the `llm:invoke` `authorization` rule live **outside** the generated
  sentinel region in `k8s/workloads/agentgateway-config.yaml`, specifically so
  the authorization posture of this hop can't drift with a provider switch.
- The agents never hold the vendor key. The one credential per provider lives
  only in the `agentgateway-llm` Secret (ns `mcp`), read by the gateway.

See [`docs/design.md`](design.md) §3.6 for the full mechanics of this hop
(exchange shape, gateway route config, why there's no `act`-chain growth here).
