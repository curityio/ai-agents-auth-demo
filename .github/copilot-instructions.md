# Copilot Instructions

Condensed guidance for this repository. `CLAUDE.md` at the repo root is the full,
authoritative version (architecture + 34 hard-won facts); read it before proposing
structural changes, together with `docs/architecture.md` and `docs/design.md`.
The "Phase N" build-log framing is historical and archived under
`docs/archive/` — don't reintroduce it into code or current docs.

## Project overview

A runnable demo of **AI agent authentication and authorization** on Kubernetes
(KIND). A DevOps/SRE copilot reads observability data and restarts/scales/re-images
workloads on a user's behalf; every hop is authenticated (SPIFFE), least-privilege
(RFC 8693 token exchange with scope/audience narrowing), MFA-gated for privileged
actions (RFC 9470 step-up), and traceable (OTel → Tempo → Grafana).

```
Browser ─https─▶ web (Next.js BFF) ─user token─▶ agent-copilot ─┬─ MCP ─▶ agentgateway ─▶ mcp-inspect ─▶ inspect-api ─▶ K8s API (prod)
                                                                └─ A2A ─▶ agent-specialist ─┬─ MCP ─▶ agentgateway ─▶ mcp-ops          ─▶ ops-api ─▶ K8s API (prod)
                                                                  (LLM, cross-tier)         └─ MCP ─▶ agentgateway ─▶ mcp-inspect ─▶ inspect-api ─▶ K8s API (prod)
        agent-copilot / agent-specialist ─ LLM ─▶ agentgateway (/llm; aud=llm-gateway, scope llm:invoke; holds the only provider key) ─▶ LLM provider
        every agent/MCP/LLM hop ⇄ Curity (RFC 8693 exchange; SPIFFE JWT-SVID as actor_token)
```

- **Curity is the sole token issuer.** Validate JWTs against Curity's JWKS; never
  mint tokens elsewhere.
- **The web app is a BFF.** Browser holds an httpOnly cookie; the access token
  never leaves the server. Its identity panels are fed by debug routes
  (`/spiffe-id`, `/last-token`, `/tools` on the workloads; `/api/obo-chain`,
  `/api/spiffe-identities`, `/api/tools`, `AUTH_DEBUG`-gated `/api/tokens` on the
  BFF) — see `CLAUDE.md` fact #34 before touching them.
- **Every agent/MCP hop performs an RFC 8693 exchange** presenting its SPIFFE
  JWT-SVID as `actor_token`; Curity narrows scope + audience, nests the workload
  into `act`, and stamps `may_act` (who may present the token next).
  `packages/auth-curity` owns *every* "what Curity expects" rule — don't duplicate it.
- **Client auth is split by tier.** The two agents are **CIMD ephemeral clients**
  (`client_id` = a self-hosted HTTPS metadata URL, `private_key_jwt`); the MCP
  servers and `agentgateway` are static `client_secret_basic` clients.
- **Both agents are LLM agents (Vercel AI SDK v7).** The copilot is front-line; the
  specialist is a privileged cross-tier agent holding **two** `aud=mcp-gateway`
  tokens (`ops:write` first — role gate + ACR TIA — then `inspect:read`) and running an
  inspect → act → verify loop. Its authz gates run **before** the LLM loop
  (`apps/agent-specialist/src/executor.ts`, `runRemediation`). Shared plumbing is
  `packages/agent-runtime` (`buildLlm`, `openMcpToolset`).
- **All model calls go through agentgateway's `/llm` route** (`@ai-sdk/openai-compatible`,
  NOT `@ai-sdk/openai`). The gateway holds the only upstream key; the provider
  (OpenAI/Anthropic/Gemini/Azure) is generated from `.demo.env` — `docs/llm-providers.md`.
- **agentgateway is the MCP front door** for both MCP servers (`aud=mcp-gateway`,
  path-routed `/inspect/mcp` + `/ops/mcp`, coarse per-tier scope authz +
  `tools/list` filtering). Its co-located `exchange-shim` performs the per-tool-call
  OBO exchange and inserts `…/ns/mcp/sa/agentgateway` into every `act` chain. The
  `set_deployment_image`=`sre` split is authoritative at **mcp-ops**; the gateway's
  HTTP-layer `authorization` rule (keyed on `Mcp-Name`) is a first line only.
- **MCP servers are thin clients** that re-exchange to `inspect-api`/`ops-api` (ns
  `apis`), the only workloads with Kubernetes credentials (minimal RBAC in `prod`).
- **Resource servers enforce, in order:** Bearer → JWT valid → scope → `act`
  present → exact actor chain → (privileged) `acr=mfa`.
- **MCP is Streamable HTTP, SDK v2, revision 2026-07-28 ONLY.** No 2025 fallback —
  the absence is a security property (`CLAUDE.md` fact #26).

## Monorepo structure

pnpm 9 (via corepack) + Turborepo. `apps/*` are deployable services (each with a
Dockerfile); `packages/*` are shared `@ai-agents-demo/*` libraries.

- `apps/web` — Next.js App Router BFF (Auth.js v5, `@vercel/otel`); identity panels
- `apps/agent-copilot` — front-line agent; CIMD client; deterministic intent gate
- `apps/agent-specialist` — privileged cross-tier LLM agent; A2A server; CIMD client
- `apps/mcp-inspect` / `apps/mcp-ops` — thin MCP servers (zod 4)
- `apps/inspect-api` / `apps/ops-api` — resource servers holding the K8s credentials
- `apps/exchange-shim` — agentgateway's extAuthz sidecar (Express; see fact #28)
- `packages/auth-curity` — JWT verify, RFC 8693 exchange, CIMD, identity spans, OBO log
- `packages/agent-runtime` — `buildLlm` + MCP→AI-SDK toolset adapter
- `packages/spiffe`, `packages/otel-bootstrap`, `packages/a2a-helpers`
- `k8s/` — curity (configmap + procedures), spire, istio, telemetry, workloads, prod, kind
- `scripts/` — bootstrap + smoke tests; `Makefile` is the lifecycle entry point

## Commands

```bash
pnpm install
pnpm turbo run build typecheck test                 # all workspaces
pnpm --filter @ai-agents-demo/auth-curity test      # one package

make tools-check     # node>=22, pnpm, docker, kind, kubectl, helm, mkcert
make demo            # full platform on a fresh KIND cluster (prompts for license + LLM key up front)
make images          # build all 8 app images and kind load them
make apply           # manifests + embed procedures + embed mkcert CA + routing
make routing         # re-patch hostAliases + mkcert CA (re-run after cluster recreation)
make status          # pod health (includes routing-check)
make smoke           # routing-check + OBO + A2A + step-up/role-denial + LLM + MCP-revision + gateway-authz
make configure-llm   # switch LLM provider after editing .demo.env
make help            # everything else
```

`turbo.json` has `typecheck` depending on `build` (Next.js `.next/types/**`); keep it.

**First-time setup:** `./license.json` → `make demo` → create the alice/carol/bob
accounts (+ TOTP) through the login flow per `docs/curity-seed.md` → open
`https://app.localtest.me`. Setup + troubleshooting: `README.md`.

## Key conventions

- **Secrets are never inline in workload YAML** (`kubectl apply` would clobber real
  values). Use `make seed-*`. The Curity license and the LLM key are gitignored
  local files (`license.json`, `.demo.env`).
- **Hostnames are `*.localtest.me`** — not `nip.io`/`127.0.0.1` (Curity's RFC 8252
  loopback canonicalization breaks the `iss` check).
- **Pods reach Curity via hostAliases** injected by `scripts/cluster-routing.sh`
  (`make routing`); a partial run yields `invalid_token` with an empty reason.
- **`k8s/curity/configmap.yaml` is a full XML export** — small additive edits only.
  Procedures are embedded as Base64 from `k8s/curity/procedures/*.js` by
  `make curity-procedures` (edit the `.js`). Nashorn (ES5.1) validates them at boot:
  no trailing commas in calls (`.prettierrc` pins `trailingComma: "none"` there).
- **`rollout restart deploy/curity` wipes the in-memory HSQLDB** — re-seed users.
  Prefer an `idsh` `load merge` for config changes (fact #33).
- **TypeScript:** ES2022, NodeNext, strict, ESM, vitest. zod 3 in the agents,
  zod 4 in the MCP servers — deliberate, not drift.
- **macOS bash is 3.2** — no `declare -A`.
- **Docker:** `.dockerignore` (`**/node_modules`) is load-bearing; Next standalone
  needs `outputFileTracingRoot`; probes hit `/healthz` / `/api/health`, never
  `/api/whoami`.
- **OTel:** `node --import @ai-agents-demo/otel-bootstrap` in every plain-Node app;
  `apps/web` uses `@vercel/otel`; agentgateway exports natively (`config.tracing`).
  Call `decorateSpanWithIdentity()` after JWT verification. Tempo query API is
  `:3200`, retention 30 min.
- **Docs:** Mermaid needs quoted subgraph names / labels with special chars; a bare
  `;` in sequence-diagram text breaks the parse.

## Pitfalls to check before "fixing" something

1. Auth.js v5 `getToken()` needs `secureCookie: true` behind HTTPS.
2. `ClusterSPIFFEID.spec.className` must be `spire-spire`; the SPIRE hardened chart
   needs `spire`, `spire-server`, `spire-system` to pre-exist.
3. `spiffe-helper` writes SVIDs mode 0600 → app containers run as UID 1000.
4. `acr` is written procedurally (Curity rejects a custom claim *definition* named
   `acr`); the standard claim flows end to end.
5. `roles` and `acr` must be re-emitted on every exchange hop.
6. `llm:invoke` must be granted at **eight** places (`docs/design.md` §3.6).
7. `may_act` is enforced *behind* `allowedActors` — a naive negative test proves
   nothing (fact #25).
8. Don't restore `legacy: 'stateless'` / `mode: 'auto'` in MCP wiring (fact #26).
9. A gateway 403 arrives as a transport error; `openMcpToolset` converts it to a
   factual result and the specialist's system prompt relays it — keep instructions
   out of tool results (fact #27).
10. Since ai@5 a throw inside a tool's `execute` does not propagate — the
    specialist's `StepUpSink` is what carries a mid-flight MFA challenge out (fact #30).
11. Denials are logged from ONE exit per component (`exchangeToken`'s catch,
    the `runRemediation` wrapper) — don't move `DENY` to individual throw sites (fact #31).
12. KIND node disk fills with `:dev` images — `make doctor`; a `kind load` failing
    inside a pipe is silent.

## Key docs

- `CLAUDE.md` — architecture + all hard-won facts (authoritative)
- `docs/architecture.md` · `docs/design.md` — the canonical docs; `README.md` — setup
- `docs/curity-seed.md` — offline Curity checklist; `docs/llm-providers.md` — LLM vendor switch
- `docs/archive/` — historical phase notes and the original implementation plan
