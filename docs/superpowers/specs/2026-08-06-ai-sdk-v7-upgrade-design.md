# Vercel AI SDK 4 → 7 upgrade

**Date:** 2026-08-06
**Branch:** `chore/ai-sdk-upgrade-analysis`
**Status:** design approved, awaiting implementation plan

## Goal

Move `ai` from 4.3.19 to 7.0.55 and both providers from 1.x to 4.x, with no
change to any externally observable behaviour: the same web-UI wire contract, the
same RFC 9470 step-up flow, the same gateway `/llm` request shape, the same
`make smoke` results.

Two optional improvements the upgrade unlocks — deleting `jsonSchemaToZod` and
wiring `@ai-sdk/otel` — are **explicitly out of scope** and tracked at the end of
this document. Keeping them out keeps the diff reviewable and keeps a green
`make smoke` attributable to the upgrade alone.

## Current state

| Package | Range | Locked | Target |
| --- | --- | --- | --- |
| `ai` | `^4.0.21` | 4.3.19 | `^7.0.55` |
| `@ai-sdk/openai` | `^1.3.24` | — | `^4.0.33` |
| `@ai-sdk/anthropic` | `^1.0.6` | — | `^4.0.33` |

Declared in `packages/agent-runtime/package.json`,
`apps/agent-copilot/package.json`, `apps/agent-specialist/package.json`.

Every import site:

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

1. `runRemediation` allocates a mutable box: `const stepUp: { err?: StepUpRequiredError } = {}`.
2. `buildStepUpInterceptingFetch` records onto the box in addition to throwing.
   It keeps throwing, so the tool call still fails rather than returning a bogus
   success to the model.
3. `runLlm` passes `stopWhen: [isStepCount(8), () => stepUp.err !== undefined]`,
   which halts the loop at the first step-up instead of letting the model retry
   into the same 401.
4. After `generateText` resolves, `runRemediation` checks the box **before**
   returning `{ kind: 'ok' }`, and returns `{ kind: 'step-up' }` if set.
5. The `catch` block keeps `findStepUp` as a belt-and-braces path (harmless, and
   still correct if a step-up ever surfaces outside a tool `execute`, e.g. from
   the `ops:write` exchange).

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

Fix: `createOpenAI({ baseURL, apiKey }).chat(cfg.llmModel)`. The provider docs
name this exact case — a custom `baseURL` pointing at an OpenAI-compatible
endpoint that implements Chat Completions but not Responses.

`@ai-sdk/openai-compatible`'s `createOpenAICompatible` was considered and
rejected for this change: it is arguably the more honest provider for a proxy
that is not OpenAI, but it is a fourth dependency and a second behavioural
variable in a diff that already has one. Note it as a follow-up.

Verification is in-cluster only: confirm the request reaching agentgateway is
still `POST /llm/chat/completions` and that `gen_ai.usage.*` still appears on the
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

1. **Delete `jsonSchemaToZod`** (`mcp-toolset.ts:131-158`). v5+ `inputSchema`
   accepts JSON Schema directly, so MCP's own `inputSchema` could pass through
   verbatim. The current converter is object-of-primitives only and silently
   drops enums, arrays, and nested objects from the tool contract the model sees.
   Removes 158 lines and improves tool fidelity — but it changes what the model
   is told, which does not belong in an upgrade diff.
2. **Wire `@ai-sdk/otel`.** The repo emits no `ai.*` spans today (no
   `experimental_telemetry` anywhere). v7 moves telemetry into a separate package
   and enables it once `registerTelemetry(new OpenTelemetry())` is called, which
   would nest `ai.generateText` / `ai.toolCall` under each agent's server span —
   valuable for a demo whose thesis is end-to-end traceability, and currently the
   one hop visible only through the gateway's own span.
3. **Consider `createOpenAICompatible`** for gateway mode instead of
   `createOpenAI(...).chat()`.
