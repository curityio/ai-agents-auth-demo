# Vercel AI SDK 4 → 7 upgrade

**Date:** 2026-08-06
**Branch:** `chore/ai-sdk-v7-upgrade`
**Status:** implemented and verified. `make smoke` passes in full and both agents'
LLM loops were driven end to end in cluster. One case remains structurally
unverifiable for reasons that predate this work — see
[Verification status](#verification-status).

## Goal

Move `ai` from 4.3.19 to 7.0.55 and both providers from 1.x to 4.x, with no
change to any externally observable behaviour: the same web-UI wire contract, the
same RFC 9470 step-up flow, the same gateway `/llm` request shape, the same
`make smoke` results.

Deleting `jsonSchemaToZod` was initially out of scope and was then folded in on
request, after the upgrade had been verified green on its own — so a `make smoke`
regression remains attributable. Wiring `@ai-sdk/otel` stays out of scope and is
tracked at the end of this document.

## Current state

| Package | Range | Locked | Target |
| --- | --- | --- | --- |
| `ai` | `^4.0.21` | 4.3.19 | `^7.0.55` |
| `@ai-sdk/openai` | `^1.3.24` | — | `^4.0.33` |
| `@ai-sdk/anthropic` | `^1.0.6` | — | `^4.0.33` |

Declared in `packages/agent-runtime/package.json`,
`apps/agent-copilot/package.json`, `apps/agent-specialist/package.json`.

Every import site (as found before the upgrade):

| File | Uses |
| --- | --- |
| `packages/agent-runtime/src/llm.ts` | `createOpenAI`, `createAnthropic`, `LanguageModelV1` |
| `packages/agent-runtime/src/mcp-toolset.ts:72` | `tool({ description, parameters, execute })`, `ToolSet` |
| `apps/agent-copilot/src/server.ts:233` | `generateText`, step mapping |
| `apps/agent-specialist/src/executor.ts:281` | `generateText`, `ToolSet`, step mapping |
| `apps/agent-specialist/tests/executor.test.ts` | `ToolExecutionError` (3 tests) |

`apps/web` does not import the AI SDK. `packages/agent-runtime/src/llm.test.ts`
and `mcp-toolset.test.ts` touch the SDK only indirectly.

## Peer requirements at v7 — all already satisfied

- `zod: ^3.25.76 || ^4.1.8`. Installed zod is 3.25.76. **The deliberate zod-3
  (agents) / zod-4 (MCP servers) split described in CLAUDE.md fact #26 survives
  untouched** — v7 does not force zod 4.
- `node >=22`. Already the floor (`make tools-check`).
- ESM-only. All twelve workspace packages that import `ai` are already
  `"type": "module"`; `apps/web` is not, and does not import `ai`.

## Design

### 1. Step-up propagation must stop relying on a thrown error

This is the one change that alters control flow rather than names.

`ToolExecutionError` was removed in v5, and thrown tool errors no longer
propagate: an error raised inside a tool's `execute` becomes a `tool-error`
content part, the tool loop continues, and `generateText` **resolves**. There is
no setting that restores abort-and-propagate.

`apps/agent-specialist/src/executor.ts` depends on the old behaviour.
`buildStepUpInterceptingFetch` throws `StepUpRequiredError` from inside a tool's
`execute`; the `catch` at line 162 recovers it with `findStepUp`, walking the
`.cause` chain, and returns `{ kind: 'step-up' }`. Post-upgrade that `catch`
never fires. The step-up challenge is handed to the model instead, the model
narrates a failure, and the A2A reply becomes `kind: 'ok'` with a fabricated
summary. **The browser never receives the RFC 9470 challenge, so the MFA prompt
never appears** — the centrepiece of the demo fails, and fails quietly.

The existing unit tests will not catch this, though not for the obvious reason.
They construct `ToolExecutionError` by hand, so they fail to *compile* once the
class is gone — which looks like the compiler saving us. It isn't: the tempting
repair is to swap in a plain `Error` with `.cause`, which makes the suite green
again while testing a path production can no longer reach. Only `make smoke`'s
step-up case observes the real behaviour.

Replacement mechanism, per remediation call:

1. `runRemediation` allocates a mutable sink:
   `const stepUpSink: { err?: StepUpRequiredError } = {}`.
2. `buildStepUpInterceptingFetch(scope, sink?)` records onto the sink in addition
   to throwing. It keeps throwing, so the tool call still fails rather than
   returning a bogus success to the model.
3. `runLlm` gains a `stopEarly?: () => boolean` parameter, which the real
   implementation passes as `stopWhen: [isStepCount(8), stopEarly]`. That halts
   the loop at the first step-up instead of letting the model retry into the same
   401. It is named `stopEarly` rather than `stopWhen` so the injected dep does
   not have to know the SDK's `Arrayable<StopCondition>` type — `RemediationDeps`
   stays SDK-agnostic apart from `ToolSet`.
4. `runRemediation` checks the sink in both exits from the LLM block: before
   returning `{ kind: 'ok' }`, and in the `catch` before returning
   `specialist_failure`. The second is not redundant — the SDK swallows the
   step-up throw, but an unrelated later failure could still escape with the sink
   already set, and a genuine step-up must win over a generic error.
5. **`findStepUp` is deleted.** Now that nothing wraps the error, walking a
   `.cause` chain has no reachable input; keeping it would be a path no test
   could honestly exercise and a false suggestion that the throw route still
   works. The `ops:write` exchange's own step-up is already handled separately
   and deterministically by `stepUpFromMetadata` at step 1 of `runRemediation`,
   so nothing is left uncovered.

This is a better fit for the architecture than what it replaces: CLAUDE.md states
that the specialist's authz gates run outside the LLM loop, and this moves the
step-up decision out of it too.

`findStepUp`'s three tests stay but are rewritten against a plain
`Error` with `StepUpRequiredError` on `.cause` — `ToolExecutionError` no longer
exists to construct. New tests cover the box path: a `runLlm` that resolves
normally while the box is set must yield `kind: 'step-up'`.

### 2. Gateway mode must pin Chat Completions explicitly

Since v5, calling the provider instance as a function uses the **Responses API**.
`packages/agent-runtime/src/llm.ts:31` builds the gateway model as
`createOpenAI({ baseURL, apiKey })(model)`, which would begin POSTing
`/llm/responses`. agentgateway's `/llm` route is chat-completions-shaped
(`resourceType: openAI`), and it is the only source of `gen_ai.usage.*` token
accounting (CLAUDE.md fact #29), which parses that shape.

Fix: replace `@ai-sdk/openai` with `@ai-sdk/openai-compatible` and build the
gateway model with `createOpenAICompatible({ name, baseURL, apiKey })(model)`.
That provider targets Chat Completions unconditionally — it has no Responses
implementation to fall back to — so the endpoint cannot drift again on a future
major. It is also the honest description of what the gateway is: an
OpenAI-compatible proxy in front of Azure, not OpenAI.

`createOpenAI(...).chat(model)` was the alternative and is a smaller diff, but it
keeps a provider whose default is wrong for us and whose correctness depends on
remembering `.chat()` at every call site. Since `buildLlm` is the single
construction point either way, taking the compatible provider now avoids touching
this file twice.

The `anthropic` branch keeps `@ai-sdk/anthropic` unchanged — it talks to
Anthropic directly and is unaffected.

**`buildLlm`'s unit test must assert the request path**, not just the provider
name. A test that only checks `model.provider` cannot distinguish
`/chat/completions` from `/responses`, which is exactly how this regression would
have shipped. Inject a stub `fetch` through the provider's `fetch` option, call
`doGenerate`, and assert the URL ends in `/chat/completions`.

Also verify in-cluster: confirm the request reaching agentgateway is still
`POST /llm/chat/completions` and that `gen_ai.usage.*` still appears on the
gateway span in Grafana. Nothing about CLAUDE.md fact #24 (`config.dns` tuning
for the external Azure host) changes.

### 3. Mechanical renames

Run the codemods in sequence over the three affected workspaces, then review
every hunk by hand:

```bash
npx @ai-sdk/codemod v5 packages/agent-runtime apps/agent-copilot apps/agent-specialist
npx @ai-sdk/codemod v6 packages/agent-runtime apps/agent-copilot apps/agent-specialist
npx @ai-sdk/codemod v7 packages/agent-runtime apps/agent-copilot apps/agent-specialist
```

Expected changes, split by whether the compiler will catch them. Verified
directly against `ai@7.0.55`'s published `dist/index.d.ts` rather than inferred
from the migration guides.

**Hard breaks — `tsc` fails, cannot ship by accident:**

| Old | New | Site |
| --- | --- | --- |
| `parameters:` | `inputSchema:` | `mcp-toolset.ts:74` |
| `maxSteps: 6` | `stopWhen: isStepCount(6)` | `server.ts:240` |
| `maxSteps: 8` | `stopWhen: isStepCount(8)` | `executor.ts:286` |
| `tc.args` | `tc.input` | `server.ts:251`, `executor.ts:294` |
| `tr.result` | `tr.output` | `server.ts:252`, `executor.ts:295` |
| `LanguageModelV1` | `LanguageModel` | `llm.ts:3,17` |
| `ToolExecutionError` | — (removed) | `tests/executor.test.ts:2` |

`maxSteps` and `ToolExecutionError` are absent from the v7 type surface
entirely, and `StaticToolCall` now carries `input` with no `args` alias. So every
row above is a compile error.

**Deprecated but still functional — rename for hygiene, not necessity:**

| Old | New | Note |
| --- | --- | --- |
| `system:` | `instructions:` | `Prompt.system` is `@deprecated`, still typed |
| `stepCountIs` | `isStepCount` | `stepCountIs` is exported as an alias |

Use `LanguageModel`, not `LanguageModelV3`. Pinning to a versioned spec type is
what made this a code change at all; the unversioned alias survives future spec
bumps.

`step.finishReason` still exists, so the third field of the step mapping is
unchanged. `StopCondition` is
`(options: { steps: Array<StepResult> }) => boolean | PromiseLike<boolean>`, which
is what makes the custom predicate in section 1 legal.

**The risk profile follows from this split:** the compiler catches every rename,
including the *import* of `ToolExecutionError`. What it cannot catch is section
1's control-flow change — the code still compiles once that import is removed,
and the tests still pass, while the step-up path silently stops working. That
asymmetry is why `make smoke` is a required gate and not a formality.

### 4. What deliberately does not change

- **The web-UI wire contract.** `server.ts:245` and `executor.ts:290` normalize
  SDK steps into `{ name, args }` / `{ name, result }` before they reach the
  browser (`apps/web/src/app/chat.tsx:40-42`). Only the right-hand side of that
  mapping moves; `apps/web` needs no edit, and neither does
  `apps/web/src/app/preview/page.tsx`.
- **The gateway-403 → `{ error: 'forbidden' }` path** (`mcp-toolset.ts:99`,
  CLAUDE.md fact #27). It *returns* a result rather than throwing, so v5's
  tool-error change does not touch it.
- **`intent.ts`.** Deterministic; `generateObject`'s v6 deprecation is
  irrelevant.
- **Non-step-up thrown tool errors.** `mcp-toolset.ts:98` re-throws anything that
  is not a 403. Those now become `tool-error` parts the model can react to
  instead of aborting the turn — a behaviour change, and an improvement. Only the
  step-up case needed rescuing from it.

## Verification

In order. Each step must pass before the next.

1. `pnpm install` — confirm the lockfile resolves `ai@7.x`, providers at `4.x`,
   and that zod stays at 3.25.76 for the agents and 4.x for the MCP servers.
2. `pnpm turbo run build typecheck test` — the whole workspace, not just the
   three packages. `turbo.json`'s `typecheck`-depends-on-`build` ordering matters
   here because `agent-runtime`'s emitted `.d.ts` is what the agents typecheck
   against.
3. `make images apply` then `make status`. Reloaded `:dev` images do **not**
   restart pods on their own — roll out the three affected deployments
   explicitly, or the smoke run silently tests stale code.
4. `make smoke`. The step-up/role-denial case is the gate for finding 1; the LLM
   case is the gate for finding 2.
5. Manual: drive a restart as alice in the browser, confirm the MFA prompt still
   appears, and confirm the Trace tab still renders tool calls and results.
6. Grafana: confirm `gen_ai.usage.*` is still present on the agentgateway `/llm`
   span.

## Verification status

Done:

- `pnpm turbo run build typecheck test` — 39/39 tasks, 244 tests, output clean.
- `packages/agent-runtime/src/tool-errors.test.ts` characterizes the SDK itself
  against the **real** `generateText`: a throw from a tool's `execute` resolves
  rather than rejecting, and surfaces as a `tool-error` content part. This is the
  premise the sink rests on, so it is now asserted rather than assumed.
- `llm.test.ts` asserts the outbound request path is `/llm/chat/completions` and
  that the exchanged token is the bearer. Measured out-of-tree beforehand for
  contrast: `createOpenAI()(model)` → `/llm/responses`, `.chat()` and
  `createOpenAICompatible()` → `/llm/chat/completions`.
- Both agent images rebuilt, `kind load`ed, and **rolled out** (reloaded `:dev`
  images do not restart pods on their own). Both pods `2/2 Running`, clean startup
  logs, `/healthz` + `/.well-known/oauth-client` + `/.well-known/jwks.json` all 200.
  This is the check that matters for v7's ESM-only requirement: the agents load
  under `node --import @ai-agents-demo/otel-bootstrap` in the real runtime.
- `make routing-check` — all 8 targets still wired.

- **`make smoke` — all suites passed** (alice, `acr=mfa`, roles `sre`+`oncall`):
  OBO; A2A including the depth-2 act chain, the gateway's inserted position and all
  three negatives; step-up alice-mfa; LLM egress (Azure 200 with `usage`); MCP
  protocol with **both tiers negotiating 2026-07-28** plus cross-tier denial;
  gateway authz namespace confinement and `set_deployment_image` for an `sre`
  caller. The pre-existing SKIPs are unrelated to this change and need other
  logins: alice-pwd (see below), bob, carol.
- **Both agents' LLM loops driven end to end through `POST /chat`.** This is what
  no smoke script covers — the scripts exercise the token and gateway layers
  directly, never the tool loop.
  - Read path: 3 steps, `get_deployment` → `list_pods` → final prose.
  - Privileged path: 4 steps, a real inspect→act→verify —
    `get_deployment` → `restart_deployment` → `get_deployment`, with the
    deployment's `generation` going 1 → 2 and the verify step observing it.
  - **On both paths every `toolCalls[].args` and `toolResults[].result` came back
    populated**, which is the only way to confirm the `tc.input` / `tr.output`
    remap: those are read through `as` casts, so a wrong field name yields
    `undefined` in the Trace tab rather than a type error.
- **Step-up relay end to end:** a restart requested with a token lacking
  `ops:write` returned `HTTP 401` with `{kind:'step-up', acrValues:'mfa',
  scope:'ops:write'}` — the deterministic pre-check path at step 1 of
  `runRemediation`.

Not verifiable, and not newly so: **the sink firing on a real mid-loop 401.** That
needs a token with `ops:write` but `acr != mfa`, and no UI journey produces one —
the step-up re-auth itself demands `acr_values=mfa`. `scripts/smoke-stepup.sh`
documents this and skips its `[2/4]` case for the same reason, which is why that
assertion was already dormant before this upgrade. The sink is therefore covered by
`executor.test.ts` plus the SDK characterization test, and the step-up *response*
plumbing is confirmed by the 401 above; only the specific mid-loop trigger is
unobserved.

Also note the gateway cannot be used to distinguish the two LLM paths directly: its
JWT policy runs before routing, so `/llm/chat/completions` and `/llm/responses`
both answer `403` without a token.

## Documentation

- CLAUDE.md gains one hard-won fact covering both red findings: thrown tool
  errors no longer propagate (and why the step-up box exists), and
  `openai()` defaulting to the Responses API against a chat-completions gateway.
  Both are exactly the "don't relearn this the hard way" shape.
- CLAUDE.md fact #22 mentions `@ai-sdk/azure` being gone from `buildLlm`; extend
  the same bullet with the `.chat()` pin so the two facts sit together.
- `docs/design.md`'s agent-runtime section: update the `buildLlm` /
  `openMcpToolset` descriptions if they name `parameters` or `maxSteps`.

## Out of scope (follow-ups)

1. **Wire `@ai-sdk/otel`.** The repo emits no `ai.*` spans today, and nothing is
   broken by their absence: there was no `experimental_telemetry` before the
   upgrade either, so this is purely additive and there is no deprecation nag.
   v7 moved telemetry into a separate package, enabled globally once
   `registerTelemetry(new OpenTelemetry())` runs — no call-site changes needed.

   What it would add over what we already have: agentgateway's `/llm` span already
   carries `gen_ai.usage.*` (fact #29). Missing is the *in-agent* view — per-step
   spans, tool names, tool-execution timing, and which agent ran the loop — none of
   which the gateway can see. Token usage would then appear in both places.

   Four things established by reading the package, before anyone starts:

   - **Where to register is the real design question.** `otel-bootstrap` is a
     dependency of seven services and only two (`agent-copilot`,
     `agent-specialist`) have `ai`. Adding `@ai-sdk/otel` there would pull `ai` +
     `@ai-sdk/provider` into `exchange-shim`, `mcp-observability`, `mcp-ops`,
     `obs-api` and `ops-api`. Register in each agent's entrypoint instead, or behind
     a separate subpath export only the agents import.
   - **`recordInputs`/`recordOutputs` default to ENABLED**, so prompts, tool
     arguments and tool results become span attributes in Tempo. This is *not* a
     credential leak — the exchanged `aud=llm-gateway` JWT is attached inside the
     provider's fetch, not via the prompt or the `headers` option — but user
     questions and cluster state would be exported. Make it a deliberate choice.
   - **Use `OpenTelemetry`, not `LegacyOpenTelemetry`.** Both are exported. The
     former follows GenAI SemConv and gates header emission behind an option that
     defaults to `false`; the latter reproduces the old `ai.*` span shape and emits
     `ai.request.headers.*` **ungated**. There are no existing dashboards to stay
     compatible with, so there is no reason to take the legacy one.
   - **Keep `ai` and `@ai-sdk/otel` in lockstep** — hygiene, not a hazard.
     `@ai-sdk/otel@1.0.56` depends on `ai` at an exact `7.0.56` (a real dependency,
     not a peer). With our `^7.0.55` a fresh install dedupes to one copy; under skew
     you get two, with `@ai-sdk/otel` loading its own. Verified that this does *not*
     silently break registration: the only runtime value it imports from `ai` is a
     pure helper, and `registerTelemetry` is called from the app's own instance, with
     the integration duck-typed. The cost is a duplicated install plus a patch-level
     event-shape mismatch risk. Bump `ai` to `^7.0.56` when adding it, and assert a
     single `ai@` entry in the store.

   Ordering: `registerTelemetry` must run after `otel-bootstrap`'s NodeSDK has set
   the global tracer provider and before the first `generateText`. `node --import
   @ai-agents-demo/otel-bootstrap` already guarantees that if registration happens in
   the agent entrypoint. Fact #28's ESM-patching trap does **not** apply here — this
   is explicit API, not module patching.

## Follow-up landed: `jsonSchemaToZod` deleted

Replaced by `mcpInputSchema`, which wraps the server's advertised document with the
SDK's `jsonSchema()` helper and passes it through **verbatim**.

The old converter handled "object of primitives" only. Everything else was dropped
silently: enums, arrays and nested objects collapsed to `z.unknown()`, and all
constraints were lost. Concretely, `mcp-ops` declares `replicas` as
`integer, 0–20` and `reason` as `maxLength 512`; the model saw a bare number and an
unbounded string, so it could propose 50 replicas and discover the limit only from a
server-side rejection. Reshaping a contract the server already publishes also meant
maintaining a second copy of it that drifts.

**Trade-off, accepted deliberately:** `jsonSchema()` performs no validation without a
`validate` function, so the model's arguments are no longer checked inside the agent.
That check was never the security boundary — `mcp-ops` and `mcp-observability`
validate every call with zod 4, and the gateway's `Mcp-Param-Namespace` authz rule
fails closed on anything it cannot read. What changes is *where* a malformed call is
caught: the server returns an error result the model can act on, rather than the SDK
rejecting locally. Adding a JSON Schema validator would mean a new dependency (ajv)
heavier than the 28 lines removed.

`x-mcp-header` (SEP-2243, hard-won fact #27) is unaffected either way: the
`Mcp-Param-Namespace` header is derived by the MCP *client* from the server-advertised
schema, never from what the agent hands the LLM. Passing the document through now also
means that annotation is visible to the model rather than stripped — harmless.

Covered by five tests in `mcp-toolset.test.ts` asserting the constraints the old
converter dropped, using the real `scale_deployment` schema.
