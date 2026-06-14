# Copilot Instructions

## Project Overview

Pedagogically-staged demo of **AI agent authentication and authorization** on Kubernetes (KIND). Six phases progressively layer identity mechanisms:

| Phase | What lands | State |
|---|---|---|
| 1 | Web (Next.js BFF) + 1 agent + 1 MCP + Curity OIDC, bearer JWT only | ✅ |
| 2 | SPIRE + `spiffe-helper` sidecars + `packages/spiffe` | ✅ |
| 3 | Istio Ambient mesh (ztunnel L4 mTLS) | ✅ |
| 4a | RFC 8693 token exchange, SPIFFE JWT-SVID as `actor_token`, single OBO hop | ✅ |
| 4b | A2A 2nd hop (→ `agent-specialist` → `mcp-ops`), nested `act` per RFC 8693 | ✅ |
| 5 | RFC 9728 metadata, RFC 9470 step-up, role-based denial | ✅ |
| 6a | OTel traces with identity span attributes → Collector → Tempo → Grafana | ✅ |

**Scenario:** DevOps/SRE copilot — read-only observability, privileged restart/scale (requires MFA step-up), delegated ticket creation.

Read `docs/archive/implementation-plan.md` before proposing structural changes — many "obvious" simplifications are deliberately deferred to a later phase.

## Architecture

```
Browser ──https──▶ Web (Next.js BFF) ──HTTP+JWT──▶ agent-copilot ──MCP+JWT──▶ mcp-observability
                        │                              │
                        │                              └── A2A+JWT──▶ agent-specialist ──MCP+JWT──▶ mcp-ops
                        │
                        └── OIDC code+PKCE ───────────▶ Curity (sole token issuer)
```

- **Curity is the sole token issuer.** Every component validates JWTs against Curity's JWKS. Never mint tokens elsewhere.
- **Web app is BFF.** Browser holds httpOnly cookie; access token never leaves the server. `/api/agent` forwards user JWT cluster-internally.
- **Token exchange (Phase 4+):** Each hop exchanges the user token + its SPIFFE JWT-SVID as `actor_token` via Curity's RFC 8693 endpoint, producing a hop-specific token with growing `act` chain.
- **`packages/auth-curity`** owns all Curity verification rules (issuer, audience, clock skew, JWKS, token exchange). Don't duplicate these elsewhere.
- **MCP transport is Streamable HTTP.** Phase 5 adds session awareness for RFC 9470 step-up challenge state.
- **OTel (Phase 6a):** `packages/otel-bootstrap` is loaded via `node --import` in all Node apps. Identity attributes (`auth.sub`, `auth.act`, `auth.scope`, `auth.acr_name`, `auth.aud`, `auth.roles`) are stamped on spans by `packages/auth-curity`'s `decorateSpanWithIdentity()`. Workload identity (`spiffe.id`) is a resource attribute.

### Identity layers per phase

| Identity | Phase 1 | Phase 2 | Phase 4 | Phase 5 | Phase 6 |
|---|---|---|---|---|---|
| Human (Curity OIDC) | ✅ user JWT fwd | ✅ | ✅ as `sub` in exchanged token | ✅ ACR escalates | visible in traces |
| Workload (SPIFFE JWT-SVID) | — | ✅ delivered | ✅ as `actor_token` | ✅ | `spiffe.id` resource attr |
| OBO actor chain (`act`) | — | — | ✅ materializes | ✅ | `auth.act` span attr |

## Monorepo Structure

pnpm workspaces + Turborepo. Workspaces live in `apps/*` and `packages/*`:

- `apps/web` — Next.js App Router BFF (Auth.js v5, `@vercel/otel`)
- `apps/agent-copilot` — Frontline copilot agent (Vercel AI SDK + Express)
- `apps/agent-specialist` — Specialist agent for privileged ops (A2A protocol)
- `apps/mcp-observability` — MCP server for read-only logs/metrics
- `apps/mcp-ops` — MCP server for privileged operations (restart/scale), guarded by ACR + role
- `packages/auth-curity` — Curity OIDC + JWT verification + token exchange + identity span decorator
- `packages/spiffe` — SPIFFE identity helpers (verify SVID, read SPIFFE ID)
- `packages/otel-bootstrap` — OTel NodeSDK bootstrap (loaded via `--import`)
- `packages/a2a-helpers` — Agent-to-Agent protocol helpers (step-up error propagation)

## Commands

### TypeScript dev loop

```bash
pnpm install
pnpm turbo run build typecheck test              # all workspaces
pnpm --filter @ai-agents-demo/auth-curity test   # single package
pnpm --filter @ai-agents-demo/auth-curity test -- --watch  # vitest watch
```

`turbo.json` has `typecheck` depending on `build` so Next.js's `.next/types/**` exists when tsc reads it; don't remove that dependency.

### Kubernetes / infrastructure

```bash
make tools-check         # preflight: node>=20, pnpm, docker, kind, kubectl, helm, mkcert
make demo                # spin up KIND + certs + nginx ingress + namespaces + TLS secrets
make images              # build all 5 TS images and kind load them
make apply               # apply manifests, then auto-run routing patches
make routing             # patch hostAliases + mkcert CA into app pods (re-run if cluster recreated)
make seed-web-secret     # prompt for CURITY_CLIENT_SECRET, generate AUTH_SECRET
make seed-llm-secret     # prompt for AZURE_OPENAI_ENDPOINT + API key
make observability-install  # deploy Tempo + Grafana + OTel Collector
make doctor              # read-only Docker + KIND disk audit
make reset               # tear down cluster + reclaim docker build cache
```

**First-time setup order:** put your Curity license at `./license.json` → `make demo` (gathers inputs up front, then installs platform + secrets + license + images + manifests unattended) → seed the alice/bob accounts in Curity per `docs/curity-seed.md` → open `https://app.localtest.me`.

## Key Conventions

### Phase discipline

Each phase has strict boundaries. Don't add Istio config to fix Phase 1 issues, or token exchange before Phase 4. Update `docs/archive/implementation-plan.md` if boundaries need to shift.

### Secrets management

Secrets with real credentials are **never** embedded inline in deployment YAMLs (`kubectl apply` overwrites real values with placeholders). Use `make seed-*` or `kubectl create secret` out-of-band. Credential files are `.gitignore`'d.

### Hostnames

All public hostnames use `*.localtest.me` (resolves to 127.0.0.1). Do **not** use `*.nip.io` or `*.localhost` — Curity's RFC 8252 loopback canonicalization breaks issuer validation with those.

### Pod-to-Curity networking

Pods can't reach `curity.localtest.me` natively (127.0.0.1 = pod itself). `scripts/cluster-routing.sh` (via `make routing`) injects hostAliases pointing to the Istio edge gateway ClusterIP and mounts the mkcert root CA. Re-run `make routing` if the cluster is recreated (ClusterIPs change).

### TypeScript

- Target: ES2022, module: NodeNext, strict mode
- Prettier: single quotes, trailing commas, 100 char width, 2-space indent
- All packages use ESM (`"type": "module"`)
- Tests use Vitest

### Docker

- `.dockerignore` is load-bearing — keeps host `node_modules` (pnpm symlinks) out of builds
- Next.js standalone output needs `outputFileTracingRoot` set to monorepo root for workspace deps
- `/api/health` or `/healthz` is the unauthenticated probe target (not `/api/whoami`)
- Node apps use a SVID-wait loop in CMD: waits for SPIFFE helper to write the JWT-SVID before starting

### Shell scripts

macOS bash is 3.2 — don't use `declare -A` (associative arrays). Use parallel arrays or IFS-split strings.

### Curity configuration

`k8s/curity/configmap.yaml` is a full XML export. The XML schema is positionally significant — small edits are safer than re-arranging blocks. Reload via `kubectl rollout restart deploy/curity -n curity`. Token exchange procedures live at `k8s/curity/procedures/`.

### OTel / Observability

- `packages/otel-bootstrap` is injected via `node --import @ai-agents-demo/otel-bootstrap` in Dockerfiles (not runtime config)
- `apps/web` uses `@vercel/otel` (Next.js instrumentation hook), NOT otel-bootstrap
- Identity attributes are set via `decorateSpanWithIdentity()` from `packages/auth-curity` — call it after JWT verification succeeds
- MCP spans additionally set `mcp.tool` and `mcp.resource_metadata_url`
- Grafana dashboard at `grafana.localtest.me`, Tempo datasource on port 3200

## Critical Pitfalls

1. **Auth.js v5 requires `secureCookie: true` explicitly** when behind HTTPS (no autodetection from req.url)
2. **SPIRE hardened chart** needs three pre-existing namespaces: `spire`, `spire-server`, `spire-system`
3. **`ClusterSPIFFEID.spec.className` must be `spire-spire`** — controller silently skips otherwise
4. **`spiffe-helper` writes SVIDs mode 0600** — sidecar must run as same UID (1000) as main container
5. **Curity reserves `acr`** — the auth-context claim is `acr_name` (value is still the ACR string like `mfa`)
6. **`roles` must propagate through every token-exchange hop** — without re-emitting, the 2nd hop sees empty roles and falsely denies
7. **KIND node disk fills easily** — run `make doctor` or `crictl rmi --prune` inside the node to reclaim; Tempo has memory limits (384Mi) to prevent OOM

## Key docs

- `docs/archive/implementation-plan.md` — phase-by-phase roadmap with exit criteria
- `docs/architecture.md` — north-star + per-phase diagrams
- `docs/curity-seed.md` — offline Curity setup checklist (clients, scopes, accounts, claims)
- `docs/phases/*.md` — per-phase design docs and known limitations
