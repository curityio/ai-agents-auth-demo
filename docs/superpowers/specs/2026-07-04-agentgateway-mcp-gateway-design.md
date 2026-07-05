# agentgateway as a federated MCP gateway + new OBO hop

**Date:** 2026-07-04
**Branch:** `feat/agentgateway-mcp-gateway`
**Status:** Design — pending user review

## Summary

Replace the Istio ambient waypoint (`k8s/istio/mcp-l7-authz.yaml`) in front of the
MCP servers with a standalone, Apache-2.0 [agentgateway](https://agentgateway.dev)
deployment acting as a **federated MCP gateway**. agentgateway aggregates the two
MCP servers behind one endpoint, does per-tool CEL-based authorization (including
tool-list filtering the waypoint could not do), and becomes a **new RFC 8693
on-behalf-of hop**: it narrows a broad `aud=mcp-gateway` caller token down to the
per-backend audience (`mcp-observability`/`mcp-ops`) and scope (`obs:read`/`ops:write`),
presenting the gateway's SPIFFE JWT-SVID as `actor_token` so Curity nests it into
the `act` chain.

Because agentgateway's config/CEL is deliberately sealed off from disk and env (it
cannot read the rotating SVID file at request time), the RFC 8693 exchange is
executed by a **thin, co-located SPIFFE-aware shim** that agentgateway drives via
`extAuthz`. The shim reuses `packages/auth-curity`, keeping that package the single
owner of Curity rules.

## Motivation

The current waypoint (`mcp-l7-authz.yaml`) does coarse early-deny: valid Curity JWT
+ caller SPIFFE identity + audience + scope. Its own comments document two hard
limits — it **cannot read the JSON-RPC body** (so no per-tool authz) and cannot
carry the RFC 9470 step-up challenge. Using agentgateway as an Istio *waypoint*
would require the enterprise ambient integration, but the **standalone** agentgateway
proxy is OSS and purpose-built for MCP. It closes the per-tool gap and, by becoming a
real OBO hop, extends the demo's least-privilege / provable-delegation thesis rather
than merely relocating it.

## Decisions (locked with user)

1. **Replace the waypoint.** agentgateway is the sole L7 gate in front of the MCP
   servers. `mcp-l7-authz.yaml` and the `istio.io/use-waypoint` labels are removed.
   The JWT `act`-chain + step-up enforcement in the resource-server middleware stays
   authoritative (it always was — it is JWT-based, transport-independent).
2. **Per-tool RBAC by role (refined 2026-07-05).** The `/ops/mcp` tier requires
   `ops:write` for every tool (restores the mcp-ops write-tier invariant), then splits
   tools by **role**, hierarchical (`sre` ⊇ `oncall`): `restart_deployment`/`scale_deployment`
   need any write role (`oncall` OR `sre`); `set_deployment_image` needs `sre`. Tools the
   caller can't call are filtered from `tools/list` and denied on `call_tool` — a body-aware,
   per-tool decision the waypoint provably could not make. `roles` is already a propagated
   token claim, so **no new Curity scopes** are needed; the only Curity change is widening the
   exchange role gate to accept `sre` OR `oncall` for `ops:write` (was `sre`-only), and adding
   a demo user `carol=[oncall]` to exercise the split (restart yes / set-image denied).
   *Superseded the earlier "set_deployment_image needs an extra claim" idea, which was a no-op
   because `ops:write` already implies `sre` via the exchange role gate.*
   The **read tier is symmetric**: `/observability/mcp` requires `obs:read` for every read tool
   (`list_pods`/`get_pod_logs`/`get_deployment`); reads are unprivileged, so no role gate. Net:
   every tool on both tiers is scope-gated at the gateway, and writes are additionally role-split.
3. **~~One federated endpoint~~ → REVISED to two path-scoped routes on one listener.**
   Original intent was a single `/mcp` endpoint aggregating both servers. The Task 5 spike
   (run against the real agentgateway **v1.3.1**, the latest OSS release) proved
   `mcp.tool.target` is **not exposed inside the `extAuthz` policy CEL**, so a single
   federated route cannot select the per-backend exchange audience per tool-call. Confirmed
   against the ecosystem: Solo.io's own reference (christian-posta/agent-auth-istio-keycloak)
   puts token exchange in a separate STS called by the agents and applies **no per-backend
   auth** on its federated MCP route — single-endpoint per-backend narrowing is not a
   supported OSS pattern. **Decision of record:** two path-scoped routes on ONE listener —
   `/observability/mcp` → mcp-observability, `/ops/mcp` → mcp-ops — each with a static
   downstream audience. Per-tool RBAC + `tools/list` filtering + the OBO hop are fully
   preserved; only the single aggregated tool namespace is given up.
4. **Gateway as a new RFC 8693 hop.** Agents mint `aud=mcp-gateway`; the gateway
   re-exchanges per backend, adding itself to the `act` chain. This intentionally
   requires Curity changes.
5. **Exchange via a SPIFFE-aware shim.** agentgateway cannot read the rotating SVID at
   request time (verified — see Spike), so it drives the exchange through `extAuthz`
   to a co-located shim that reads `/run/spiffe/curity-actor.jwt` and reuses
   `packages/auth-curity`.

## Spike result (feasibility, completed 2026-07-04)

- **agentgateway backend token-exchange is fully templated.** The `extAuthz.protocol.http`
  block lets you compose the entire RFC 8693 POST body via CEL `form.encode({...})`,
  so `actor_token`/`actor_token_type` are addable form params and `audience` can be
  computed by CEL. Client auth is a composed `Authorization: Basic base64(id:secret)`.
- **But CEL cannot source the rotating SVID.** The CEL function set is fixed
  (`json, base64.*, form.encode, unvalidatedJwtPayload, …`) with **no** `file()`/`read()`/`secret()`.
  The `env` context exposes only a curated subset (`gateway`, `namespace`, `podName`),
  and agentgateway does **not** expand env vars from YAML. The static client secret can
  be baked in, but the SVID rotates on a short TTL and cannot.
- **Conclusion:** a faithful actor-chain hop needs a co-located component that can read
  the rotating file. Hence the shim. agentgateway's *native* backend token-exchange is
  therefore **not** used; the shim performs the exchange, and agentgateway consumes the
  returned token.

## Architecture

### Before (transparent waypoint)

```
agent-copilot ──(aud=mcp-observability)──┐
                                          ├─HBONE→ mcp-waypoint(Envoy) → mcp-observability / mcp-ops → obs/ops-api
agent-specialist ─(aud=mcp-ops + obs)────┘   coarse JWT/aud/scope/mTLS-principal deny
```

### After (federated gateway + new OBO hop)

```
agent-copilot ────(aud=mcp-gateway, obs:read)──────────┐
                                                        │  ┌─ POST /exchange (subject=caller, actor=SVID, aud=mcp-observability, obs:read) ─┐
                                                        ▼  │                                                                                 ▼
agent-specialist ─(aud=mcp-gateway, obs:read+ops:write)─┤  shim (packages/auth-curity)  ◀── extAuthz ──  agentgateway ──(aud=mcp-observability)→ mcp-observability → obs-api
                                                        │                                    │ per-tool CEL RBAC  ──(aud=mcp-ops)───────────→ mcp-ops          → ops-api
                                                        └────────────────────────────────────┘ + federation/routing
```

- **Deployment:** `agentgateway` Deployment + Service in the **`mcp` namespace**,
  in-mesh (ztunnel keeps L4 mTLS). Two containers: `agentgateway` (config from a
  ConfigMap) and `exchange-shim` (Node, reuses `packages/auth-curity`), plus a
  **spiffe-helper** sidecar writing the SVID to `/run/spiffe/curity-actor.jwt`
  (same pattern as the agents/MCP servers). The gateway SA gets a `ClusterSPIFFEID`
  → `spiffe://demo.curity.local/ns/mcp/sa/agentgateway`.
- **Federation vs. routing (validation item — see Risks):** target design is a
  single MCP listener with two `mcp.targets` (`observability`, `ops`); the per-tool
  audience for the exchange is computed from the MCP context (`mcp.tool.target`).
  If the `mcp` CEL context is unavailable inside the `extAuthz` policy, fall back to
  two path-scoped routes on one listener (`/observability`, `/ops`), each passing a
  fixed `x-target-audience` header to the shim. Both preserve the "one endpoint"
  intent; the fallback loses per-tool tool-list federation only.

### Request flow (per tool-call)

1. Agent presents `aud=mcp-gateway` token to agentgateway.
2. agentgateway validates it (`mcpAuthentication`: issuer=Curity public URL,
   `aud=mcp-gateway`, `jwks`=in-cluster Curity Service DNS over plain HTTP — the same
   loopback-safe URL the waypoint used).
3. agentgateway applies per-tool CEL RBAC (equivalence rules + the `set_deployment_image`
   showcase filter/deny).
4. agentgateway calls the shim via `extAuthz`, forwarding the caller token and a
   computed target audience.
5. Shim reads the current SVID, calls Curity `exchangeToken({ subjectToken: caller,
   actorToken: SVID, audience: <target>, scope: <obs:read|ops:write> })`, returns the
   narrowed token.
6. agentgateway sets `Authorization: Bearer <narrowed>` and forwards to the backend
   MCP server, which re-exchanges to the API as today.

## Token / identity model

### Audiences and scopes

| Client (Curity `CLIENT_POLICY` key) | Exchanges to audience | Scopes |
|---|---|---|
| `https://copilot.localtest.me/.well-known/oauth-client` | `mcp-gateway` | `obs:read` |
| (copilot, unchanged) | `agent-specialist` | `obs:read`, `ops:write` |
| `https://specialist.localtest.me/.well-known/oauth-client` | `mcp-gateway` | `obs:read`, `ops:write` |
| `mcp-gateway` (new, `client_secret_basic`) | `mcp-observability` | `obs:read` |
| `mcp-gateway` (new) | `mcp-ops` | `ops:write` |

The specialist mints a single `aud=mcp-gateway` token carrying both scopes; the
**gateway narrows per tool**. The `sre`-role gate on `ops:write` still fires at the
specialist's exchange (roles ride in the token), and `acr=mfa` is re-emitted through
the gateway's exchange, so step-up survives to ops-api unchanged.

The gateway authenticates to Curity as `client_secret_basic` client id `mcp-gateway`
(matches the MCP-server tier). Its SVID is the `actor_token`; its `allowedActors`
regex is `^spiffe://demo\.curity\.local/ns/mcp/sa/agentgateway$`.

### act-chain growth (+1 gateway position)

The gateway inserts one position into every `act` chain that traverses it. Only
middleware that pins a chain changes; **mcp-observability is scope-only and is
untouched.**

| Enforcer | File | Before | After |
|---|---|---|---|
| mcp-ops | `apps/mcp-ops/src/config.ts` | `[specialist, copilot]` | `[gateway, specialist, copilot]` |
| obs-api (path A) | `apps/obs-api/src/config.ts` | `[obs-mcp, copilot]` | `[obs-mcp, gateway, copilot]` |
| obs-api (path B) | `apps/obs-api/src/config.ts` | `[obs-mcp, specialist, copilot]` | `[obs-mcp, gateway, specialist, copilot]` |
| ops-api | `apps/ops-api/src/config.ts` | `[ops-mcp, specialist, copilot]` | `[ops-mcp, gateway, specialist, copilot]` |

`gateway` = `SPIFFE_ID('mcp', 'agentgateway')`. The Curity exchange procedure's actor
sub-prefix check already accepts `…/ns/mcp/sa/*`, so the SVID passes; the per-position
chain regexes in the resource servers are what grow.

## Component: exchange-shim

- **Purpose:** given a caller token + a target audience, perform the RFC 8693 exchange
  with the gateway's SVID as `actor_token`, return the narrowed token. One clear job.
- **Interface:** minimal HTTP endpoint compatible with agentgateway's `extAuthz`
  protocol (request carries the caller `Authorization` + a target-audience header;
  response yields the token agentgateway swaps in). Exact shape confirmed against the
  `backend-oauth` example during implementation.
- **Dependencies:** `packages/auth-curity` (`exchangeToken`), the SVID file
  (`/run/spiffe/curity-actor.jwt`, read fresh per request), the gateway client secret
  (env, from an out-of-band Secret), Curity JWKS/issuer config.
- **Not responsible for:** JWT validation, RBAC, routing, tool filtering — all owned by
  agentgateway.

## Change inventory

| Area | Change |
|---|---|
| `k8s/workloads/agentgateway.yaml` (new) | Deployment (agentgateway + exchange-shim + spiffe-helper), Service, ConfigMap (agentgateway config), SA |
| `k8s/spire/…` | `ClusterSPIFFEID` for the `agentgateway` SA in `mcp` (className `spire-spire`) |
| `apps/exchange-shim/` (new) | Thin Node service reusing `packages/auth-curity` |
| `k8s/istio/mcp-l7-authz.yaml` | **Removed**; `istio.io/use-waypoint` labels stripped from `k8s/workloads/mcp-*.yaml` |
| `k8s/workloads/agent-copilot.yaml` | `MCP_OBSERVABILITY_URL` → gateway; `MCP_OBSERVABILITY_AUDIENCE` → `mcp-gateway` |
| `k8s/workloads/agent-specialist.yaml` | `MCP_*_URL` → gateway; audiences → `mcp-gateway` (single token, both scopes) |
| `apps/mcp-ops/src/config.ts` | `expectedActorChain` +1 (`gateway`) |
| `apps/obs-api/src/config.ts` | both `expectedActorChains` +1 (`gateway`) |
| `apps/ops-api/src/config.ts` | `expectedActorChain` +1 (`gateway`) |
| `k8s/curity/procedures/token-exchange.js` | New `mcp-gateway` `CLIENT_POLICY` entry; copilot/specialist retargeted to `mcp-gateway` |
| `k8s/curity/configmap.yaml` | New `mcp-gateway` `client_secret_basic` client (additive edit) |
| `Makefile` / `scripts/cluster-routing.sh` | Seed gateway client secret + SPIFFE key; hostAlias so the gateway pod reaches Curity |
| `docs/architecture.md`, `docs/design.md` | New hop in the two OBO chains + gateway topology |
| `make smoke` | Assert federated `tools/list` filters `set_deployment_image`; act-chain shows the gateway; step-up still challenges |

## Risks & validation items

1. **`mcp` CEL context inside `extAuthz` (validate early).** True per-tool federation
   needs `mcp.tool.target`/`mcp.tool.name` available in the `extAuthz` policy so the
   gateway can pick the audience per tool-call. If not available, use the path-scoped
   two-route fallback (documented above). Decide in the first implementation step.
2. **Step-up passthrough.** The RFC 9470 `401 + WWW-Authenticate` from ops-api must
   survive agentgateway unaltered. Low risk (transparent response), but `make smoke`
   must assert it.
3. **extAuthz ⇄ shim contract.** The exact request/response shape agentgateway's
   `extAuthz` expects (how it reads the returned token, header vs. body) is confirmed
   against the `backend-oauth` example when wiring the shim.
4. **Curity client persistence.** Add the `mcp-gateway` client via the **configmap**,
   not the UI, so it survives `rollout restart` (HSQLDB is in-memory).
5. **Pod → Curity routing.** The gateway pod needs the `curity.localtest.me` hostAlias
   + mkcert CA, same as every other backend (`scripts/cluster-routing.sh`).

## Testing & rollback

- **Unit:** shim exchange (mock Curity), CEL rule intent captured in fixtures.
- **Integration (`make smoke`):** OBO read + A2A write still succeed; act-chain now
  includes the gateway at every hop that pins it; `tools/list` for the base role omits
  `set_deployment_image`; role-denial + step-up unchanged.
- **Rollback:** re-apply `mcp-l7-authz.yaml`, restore `use-waypoint` labels, revert
  agent env + the four `config.ts` chains + the procedure/configmap client. The change
  is a swap of one L7 layer for another; fully reversible.

## Out of scope

- Granular per-tool scopes in Curity (Q2 "full matrix" was declined).
- Migrating the MCP servers' own audience (backends keep `mcp-observability`/`mcp-ops`).
- Any change to the A2A hop (copilot→specialist) or the web BFF.
