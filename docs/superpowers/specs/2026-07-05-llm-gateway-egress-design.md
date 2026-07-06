# Identity-bound LLM egress via agentgateway

**Status:** design approved (2026-07-05); implementation pending
**Branch:** `feat/llm-gateway-egress`

## Problem

Every hop in this demo is authenticated (SPIFFE), least-privilege (RFC 8693
token exchange), and traceable (OTel → Tempo → Grafana) — except one. The two
LLM agents (`agent-copilot`, `agent-specialist`) call Azure OpenAI **directly**
using a static shared API key (`AZURE_OPENAI_API_KEY`) baked into each agent
pod's Secret (`packages/agent-runtime/src/llm.ts`, `buildLlm` azure branch).

That makes the "think" side of the architecture an ungoverned egress:

- the credential is a shared secret spread across every agent pod, not an identity;
- the call is not attributable to the user who triggered it;
- it does not pass through the same governance/observability boundary as the
  "act" side (agent → MCP → API → K8s).

The demo governs what the agent *does* meticulously but not what it *thinks
with*. This design closes that asymmetry.

## Goal

Make the LLM call an **identity-bound, least-privilege, traceable hop** by
routing it through the existing `agentgateway` (ns `mcp`) as an LLM gateway in
front of Azure OpenAI. The gateway becomes the **sole holder of the Azure
credential**; agents present a user-on-behalf-of Curity token instead.

Non-goals (explicitly out of scope for this cut):

- Per-tier model authorization (copilot cheaper model / specialist stronger
  model). Decided out — identity-bound egress only. Could be a follow-up.
- Prompt/response guardrails, PII redaction, provider failover, model routing.
- Retaining the direct-to-Azure path. It is **removed** (see decisions).

## Decisions (locked with the user)

1. **Token identity = user on-behalf-of.** The LLM-egress token is minted by an
   RFC 8693 exchange with the end-user token as `subject_token` and the agent's
   SPIFFE JWT-SVID as `actor_token`, narrowed to `aud=llm-gateway`,
   `scope=llm:invoke`. Symmetric with the MCP exchange; enables per-user
   attribution of the reasoning hop.
2. **Identity-bound egress only.** Both agents use the same model. The gateway
   enforces `aud=llm-gateway` + `scope=llm:invoke` and holds the only Azure key.
   No per-tier model gate in this cut.
3. **Both agents** route their LLM calls through the gateway.
4. **Replace the direct-to-Azure path entirely.** The `azure` provider mode is
   removed from the agents. `anthropic` mode remains for the local `pnpm dev`
   loop (direct, no gateway). Deployed manifests use the new `gateway` mode.

## Verified facts (spike, agentgateway v1.3.1 / git dbaaf7ed)

These were established against the actually-running binary before this design;
they are load-bearing and must not be re-litigated:

- **LLM backend schema validates** via `--validate-only`. Correct enum is
  `resourceType: openAI` (NOT `OpenAI`, which the docs stated — doc drift).
- **`policies.backendAuth.key.value: $ENV`** + `location.header.{name,prefix}`
  attaches a static upstream credential held at the gateway. Azure OpenAI uses
  the `api-key` header (prefix `""`), not `Authorization: Bearer`.
- **Route-level `jwtAuth` + `authorization.rules[].require: '<CEL over jwt.*>'`**
  validate on the same route as an `ai` backend.
- **SSE streaming passes through unbuffered.** Chunks emitted 300 ms apart at a
  mock backend arrived ~300 ms apart at the client through the gateway. This is
  the format the Vercel AI SDK tool-loop consumes.
- **The gateway natively recognizes the LLM protocol** and stamps OTel GenAI
  span attributes (`protocol=llm`, `gen_ai.operation.name=chat`,
  `gen_ai.provider.name=openai`, `gen_ai.request.model`). Traceability is free.
- **`hostOverride: "host:port"`** is a valid string field on the `ai` backend
  (used only in the spike to reach the mock; not used in production config).
- **Path forwarding:** with the openAI provider the inbound path is forwarded
  verbatim to the backend. The `azure` provider is documented to construct its
  own Azure URL from `resourceName`/`model`/`apiVersion` — see open item #1.

## Architecture

```
agent-copilot ─┐  exchange: user token → aud=llm-gateway, scope=llm:invoke
agent-specialist ─┤    (subject = user, actor = agent SPIFFE JWT-SVID)
                    │
                    └─ Bearer(aud=llm-gateway) ─▶ agentgateway  /llm route ─┐
                                                                            │ api-key
   agentgateway /llm route:                                                 ▼
     - jwtAuth: issuer=oauth-anonymous, aud=llm-gateway, jwks=in-cluster   Azure OpenAI
     - authorization: require 'llm:invoke' in jwt.scope
     - backendAuth.key: $AZURE_OPENAI_API_KEY  (the ONLY Azure key)
     - backend: ai / provider.azure (resourceName, resourceType: openAI, model, apiVersion)
```

- **One exchange, no shim.** Unlike the MCP path (agent → `aud=mcp-gateway`,
  then shim re-exchanges → `aud=mcp-observability`/`mcp-ops`), the LLM path has
  no downstream Curity resource: Azure is outside the trust domain. The agent
  performs a single exchange to `aud=llm-gateway`; the gateway validates it and
  swaps in the Azure key. No `extAuthz`/`exchange-shim`, no `act`-chain match.
- **Resource-server chains unchanged.** obs-api/ops-api `expectedActorChains`
  are not touched — the LLM route never reaches them.

## Components changed

### `packages/agent-runtime/src/llm.ts`

- `LlmConfig.llmProvider`: `'gateway' | 'anthropic' | 'ollama'` (remove
  `'azure'`). Add `llmGatewayUrl: string` (used in `gateway` mode).
- `buildLlm(cfg, opts?: { accessToken?: string }): LanguageModelV1`.
  - `gateway` mode: require `opts.accessToken`; return
    `createOpenAI({ baseURL: cfg.llmGatewayUrl, apiKey: opts.accessToken })(cfg.llmModel)`.
    The exchanged `aud=llm-gateway` JWT rides as the OpenAI bearer.
  - `anthropic` mode: unchanged (direct, ignores `accessToken`).
- Drop `@ai-sdk/azure` dependency from this package.

### Agents (`apps/agent-copilot`, `apps/agent-specialist`)

- New `src/llm-token.ts`: TTL-cached `exchangeToken` (from
  `@ai-agents-demo/auth-curity`) → `aud=llm-gateway`, `scope=llm:invoke`,
  subject = the same validated user token used for the MCP exchange, actor =
  agent SPIFFE JWT-SVID. Mirrors `mcp-client.ts` token acquisition + cache.
- Move `buildLlm` from module/startup scope into the request handler
  (copilot `server.ts` around the `generateText` call; specialist
  `executor.ts` `runRemediation` before the tool-loop) so each call carries the
  per-request user-bound token.
- `config.ts`: add `llmGatewayUrl`, `llmGatewayAudience` (default `llm-gateway`),
  `llmGatewayScope` (default `llm:invoke`); remove `azureEndpoint`,
  `azureApiVersion`; `llmProvider` default becomes `gateway`; `llmModel`
  default stays `gpt-4.1` (the Azure deployment name, now reached via the
  gateway).

### `k8s/curity/`

- `configmap.yaml`: add scope `llm:invoke` to the scopes block (small additive
  edit; the configmap is positionally significant).
- `procedures/token-exchange.js`: add `'llm-gateway': { scopes: ['llm:invoke'] }`
  to BOTH agents' `CLIENT_POLICY` entries
  (`https://copilot.localtest.me/...` and `https://specialist.localtest.me/...`).
  `allowedActors` unchanged. Keep `trailingComma: none` (Nashorn ES5.1).

### `k8s/workloads/agentgateway-config.yaml`

- New `/llm` route on the existing `:8080` listener:
  - `jwtAuth` (issuer `oauth-anonymous`, `audiences: [llm-gateway]`, in-cluster
    plain-HTTP JWKS URL, same loopback-safe form as the MCP routes);
  - `authorization.rules: [{ require: '"llm:invoke" in jwt.scope.split(" ")' }]`;
  - `backendAuth.key.value: $AZURE_OPENAI_API_KEY`,
    `location.header: { name: api-key, prefix: "" }`;
  - `backends[].ai.provider.azure: { resourceName, resourceType: openAI, model,
    apiVersion }`.
- Client `baseURL` and route `pathPrefix` must agree (`/llm`). Exact path
  translation for the azure provider is open item #1.

### `k8s/workloads/agentgateway.yaml` + agent manifests

- Gateway pod gains Azure creds via a new Secret `agentgateway-llm`
  (`AZURE_OPENAI_API_KEY`, plus whatever is needed for `resourceName`/endpoint).
- `agent-copilot.yaml` / `agent-specialist.yaml`: remove `AZURE_OPENAI_API_KEY`
  and `AZURE_OPENAI_ENDPOINT`; add `LLM_PROVIDER=gateway`,
  `LLM_GATEWAY_URL=http://agentgateway.mcp.svc.cluster.local:8080/llm`,
  `LLM_GATEWAY_AUDIENCE=llm-gateway`, `LLM_GATEWAY_SCOPE=llm:invoke`.

### `Makefile` / seed scripts

- `make seed-secrets`: seed Azure endpoint + key into the `agentgateway-llm`
  Secret instead of the agent Secrets. Derive the Azure `resourceName` from the
  endpoint host (`https://<resourceName>.openai.azure.com`).
- If `provider.azure.resourceName` does not support `$ENV` interpolation
  (open item #2), add a seed-time templating step for the gateway config
  (precedent: `scripts/embed-mkcert-ca.sh`, `embed-curity-procedures.sh`).

## Open items (resolved by spike — see `.superpowers/sdd/task-1-report.md`)

1. **Azure-provider path translation — PASS.** Spiked against the real seeded
   Azure endpoint (agentgateway v1.3.1, pinned digest
   `sha256:c3ce7b75da90fef70239befcc1c3adc05152d7b9dd21fcb8351178026a2c4381`,
   no jwtAuth, isolating the Azure hop). A streamed POST to
   `http://127.0.0.1:8080/llm/chat/completions` (OpenAI format, `stream:true`)
   returned real SSE `data: {...delta...}` chunks from Azure ending
   `data: [DONE]`. Gateway access log confirms the exact upstream the client
   used: `endpoint=aifoundryplayg9725967827.openai.azure.com:443 ... http.status=200
   protocol=llm gen_ai.provider.name=azure gen_ai.request.model=gpt-4.1`.
2. **`resourceName` injection — ENV.** Re-ran with
   `resourceName: $AZURE_RESOURCE_NAME` and `-e AZURE_RESOURCE_NAME=<resource>`;
   the streamed completion still succeeded end-to-end (same
   `endpoint=...openai.azure.com:443 http.status=200` log line), confirming
   `provider.azure.resourceName` supports `$ENV` interpolation. No seed-time
   templating step is needed.

## Testing

- **`make smoke`** gains an LLM beat:
  - a caller holding `llm:invoke` gets a completion through `/llm` (200 + body);
  - a caller lacking `llm:invoke` (or presenting a wrong-audience token) is
    **denied at the gateway** (403/401 originating at agentgateway, not Azure);
  - assert **no `AZURE_OPENAI_API_KEY` env exists on the agent pods** (grep the
    running pod spec/env) — proves the credential moved.
- **Unit (`packages/agent-runtime/src/llm.test.ts`)**: `gateway` mode builds a
  client with `baseURL`/bearer from the injected token; missing `accessToken`
  throws; `anthropic` mode still builds directly.
- **Trace check** (manual, in the runbook): the Grafana/Tempo trace for a driven
  request shows the `/llm` span with `gen_ai.*` attributes attributed to the
  user.

## Hardening learned during live bring-up (2026-07-06)

The build-time plan captured the *shape* of the hop but under-specified two things
that only surfaced against the live cluster. Both are now documented canonically in
`docs/design.md` §3.6 and `CLAUDE.md` facts #23/#24:

1. **`llm:invoke` propagation.** The plan granted the scope to the agent→gateway
   exchange policy but not the rest of the delegation chain. Because the exchange
   narrows `requested ∩ subject ∩ policy`, `llm:invoke` must be granted at **eight**
   places (global def; each agent's `llm-gateway` policy; the web-app client; the
   `<ephemeral-client>`; the web login scope; the **step-up re-auth scope**, which
   overrides the login default; and — for the specialist's calls during a restart —
   the copilot's `agent-specialist` delegation policy **and** its requested
   `SPECIALIST_SCOPE`). Symptoms when a link is missing: `invalid_scope: no scope
   intersects subject + policy`, or `No valid scope was requested` if a *client*
   isn't allowed to request it.
2. **Gateway external DNS.** agentgateway's Rust resolver can't reach the public
   Azure host under the pod's default `ndots:5` (fails `503 NoHealthyBackend`, "DNS
   resolution which failed", while glibc/Node succeed). Fixed with
   `config.dns.lookupFamily: V4Only` (Azure has no AAAA) + `edns0: true` (the
   multi-record A answer overflows 512-byte UDP without EDNS0). `ndots:1` alone is
   insufficient.

## Docs to update (part of the work, not a follow-up)

- `CLAUDE.md`: extend the topology diagram with the LLM egress hop; add a
  hard-won-fact entry for the LLM gateway (resourceType enum, single exchange /
  no shim, azure path-translation verification, api-key header).
- `docs/architecture.md`, `docs/design.md`, `docs/demo.md`: reflect the governed
  LLM hop, the new `llm-gateway` audience/scope, and the removed direct path.

## Rollback / safety

- New branch `feat/llm-gateway-egress`; no changes to the resource-server
  actor-chain enforcement, so the MCP/OBO paths are unaffected.
- Local dev remains possible via `LLM_PROVIDER=anthropic` without a gateway.
- Azure creds are seeded out-of-band (never committed), consistent with the
  repo's secret policy.
