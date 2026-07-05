# Architecture

This document describes the **as-built** system: an end-to-end demonstration of
authentication and authorization for AI agents running on Kubernetes. It is the
canonical reference for *what exists and how the pieces fit together*. For
module-level implementation detail see [`design.md`](design.md); to run and
present the system see [`demo.md`](demo.md).

> The system was built up across pedagogical phases (1 → 6). Those phase notes
> live in [`archive/phases/`](archive/phases/) as a historical build-log; this
> document supersedes them for the current state.

---

## 1. What the system is

A DevOps/SRE **copilot**: a user asks an AI agent to investigate and remediate
an incident. The agent reads observability data and — for privileged actions —
delegates to a specialist agent that restarts workloads. Every hop is
authenticated and authorized, and the user's identity plus the full chain of
acting agents is provable at the resource that finally touches the cluster.

The demo's thesis: **three independent identity planes, enforced together.**

| Plane | Question it answers | Mechanism |
|---|---|---|
| **Human** | *On whose behalf?* | Curity OIDC user token → propagated as `sub` through every exchange |
| **Workload** | *Which software is acting?* | SPIFFE JWT-SVID per pod → presented as the `actor_token`; recorded in the nested `act` chain |
| **Assurance** | *How strongly did the human authenticate?* | `acr` claim (RFC 9470 step-up); privileged actions require `acr=mfa` |

These ride on top of Istio Ambient **mTLS** (transport identity) and Kubernetes
**RBAC** (what the final actor may touch). No single mechanism is trusted alone.

---

## 2. Component responsibilities

| Component | Namespace | Port | Responsibility |
|---|---|---|---|
| **web** | `web` | 3000 | Next.js BFF. OIDC login (Auth.js + Curity), httpOnly session cookie, forwards the user token to the copilot. The access token never reaches the browser. |
| **agent-copilot** | `agents` | 8081 | Front-line AI agent (Vercel AI SDK + Azure OpenAI). Validates the user token; exchanges it for hop-scoped `aud=mcp-gateway` tokens to reach `mcp-observability` (read) **via the agentgateway** (`/observability/mcp` path), or for an `agent-specialist` token (privileged, over A2A). It no longer exchanges directly to `mcp-observability`. |
| **agent-specialist** | `agents` | 8082 | Privileged **LLM agent** (Vercel AI SDK + Azure OpenAI). Exposes an A2A endpoint that takes a natural-language remediation goal. Acquires an `aud=mcp-gateway` token (scope `obs:read ops:write`) and reaches both MCP servers **through the agentgateway** (`/ops/mcp` + `/observability/mcp`), running a tool-using LLM loop to inspect, act, and verify (`get_deployment` to read; `restart_deployment`/`set_deployment_image`/`scale_deployment` to write). All authz gates fire **outside** the LLM loop: the `ops:write` exchange (role + scope gate) and the `acr=mfa` step-up pre-check both run **before** the model is ever invoked. |
| **mcp-observability** | `mcp` | 8080 | MCP server (Streamable HTTP), read tier. Validates the OBO token, then exchanges it again to call `obs-api`. Thin client — holds no data and no cluster credentials. |
| **mcp-ops** | `mcp` | 8080 | MCP server, privileged tier. Validates the OBO token (incl. step-up), then exchanges it to call `ops-api`. Thin client. |
| **obs-api** | `apis` | 8084 | Resource server backing the read tier. Validates the token (accepting **two** actor chains — copilot reading directly, or specialist reading while remediating), then reads pods/logs and deployment state from the `prod` namespace via its own narrowly-scoped Kubernetes RBAC (`get,list` on pods and deployments). |
| **ops-api** | `apis` | 8083 | Resource server backing the privileged tier. Validates the token (full actor chain + step-up), then `patch`es deployments in `prod` via its own RBAC. |
| **Curity Identity Server** | `curity` | 8443 | The **sole** token issuer. OIDC for the user; RFC 8693 token exchange for every agent/MCP hop; hosts the SPIFFE-aware token-exchange procedure. |
| **SPIRE** (server/agent/CSI) | `spire*` | — | Issues and rotates SPIFFE JWT-SVIDs (5-minute TTL) to every workload via a `spiffe-helper` sidecar. |
| **Istio Ambient** (ztunnel/cni/istiod) | `istio-system` | — | Transparent ztunnel L4 mTLS for all in-mesh traffic. |
| **Istio edge gateway** | `istio-ingress` | 80/443 | Terminates TLS for `app`/`curity`/`grafana`, the two agents' CIMD hosts (`copilot`/`specialist`), and the two MCP hosts (`mcp-ops`/`mcp-observability`, so their RFC 9728 metadata is browsable); the single ingress into the cluster. |
| **agentgateway** (+ co-located `exchange-shim`) | `mcp` | 8080 | The MCP front door for BOTH MCP servers. One listener with two path-scoped routes (`/observability/mcp` → mcp-observability, `/ops/mcp` → mcp-ops). Validates the caller's `aud=mcp-gateway` JWT, applies **coarse per-tier scope authz** (per-route `ops:write`/`obs:read`) and filters `tools/list` by that tier scope — it does *not* split ops tools by role (the `set_deployment_image`=`sre` split is enforced downstream at mcp-ops) — and for each tool-call drives an `extAuthz` call to the co-located `exchange-shim` (`:8090`, same pod), which performs the RFC 8693 OBO exchange using the gateway's SPIFFE JWT-SVID as the `actor_token` and swaps the narrowed downstream token onto the request. Inserts one `act` position (`…/ns/mcp/sa/agentgateway`). Does *not* enforce the `act` chain or step-up (those stay in the resource-server middleware). |
| **OTel Collector → Tempo → Grafana** | `observability` | — | Distributed tracing. Identity attributes ride on the spans so the whole OBO chain is visible in one trace. |
| **prod** sample workloads | `prod` | — | The deployments the copilot observes and restarts (e.g. a CrashLoopBackOff target). |

The two MCP servers (`mcp-observability`, `mcp-ops`) are **thin clients**: they
authenticate the caller and re-exchange the token to a backend resource server
(`obs-api`, `ops-api`). The backend servers live in their own `apis` namespace —
separate from the thin clients in `mcp` — and are the only components holding
Kubernetes API credentials, each bound to a minimal RBAC Role in the `prod`
namespace.

---

## 3. Deployment topology

```mermaid
flowchart TB
  subgraph browser["Browser"]
    U["Alice / Bob"]
  end

  subgraph ingress_ns["istio-ingress namespace"]
    GW["Istio edge gateway<br/>(TLS termination)"]
  end

  subgraph web_ns["web namespace (ambient)"]
    W["web — Next.js BFF"]
  end

  subgraph agents_ns["agents namespace (ambient)"]
    A1["agent-copilot"]
    A2["agent-specialist"]
  end

  subgraph mcp_ns["mcp namespace (ambient)"]
    GWY["agentgateway<br/>(JWT + per-tier scope authz)<br/>+ exchange-shim (OBO)"]
    M1["mcp-observability"]
    M2["mcp-ops"]
  end

  subgraph apis_ns["apis namespace (ambient)"]
    B1["obs-api"]
    B2["ops-api"]
  end

  subgraph prod_ns["prod namespace"]
    V["sample deployments"]
  end

  subgraph curity_ns["curity namespace"]
    C["Curity Identity Server"]
  end

  subgraph spire_ns["spire namespaces"]
    S["SPIRE server + agent"]
  end

  subgraph external["External (HTTPS egress)"]
    LLM["Azure OpenAI<br/>(LLM — gpt-4.1)"]
  end

  U -- "OIDC code+PKCE / https" --> GW
  GW --> W
  W -- "user token (Bearer)" --> A1
  A1 -- "A2A (OBO token)" --> A2
  A1 -- "MCP (aud=mcp-gateway)" --> GWY
  A2 -- "MCP (aud=mcp-gateway)" --> GWY
  A1 -- "LLM tool-calling<br/>(read: observe path)" --> LLM
  A2 -- "LLM tool-calling<br/>(remediation: inspect→act→verify)" --> LLM
  GWY -- "/observability/mcp<br/>(shim OBO → obs:read)" --> M1
  GWY -- "/ops/mcp<br/>(shim OBO → ops:write)" --> M2
  M1 -- "Bearer (re-exchanged)" --> B1
  M2 -- "Bearer (re-exchanged)" --> B2
  B1 -- "list pods / logs (RBAC)" --> V
  B2 -- "patch deployment (RBAC)" --> V
  W -- "OIDC code+PKCE login" --> C
  A1 & A2 & M1 & M2 -- "RFC 8693 exchange" --> C
  B1 & B2 & A1 & A2 & M1 & M2 -. "JWT-SVID (sidecar)" .- S
```

The arrows above are the request/OBO flow. The edge gateway also terminates TLS
for the `curity`, `copilot`/`specialist` (CIMD), and `mcp-ops`/`mcp-observability`
hosts purely so their discovery/`.well-known` documents (Curity OIDC metadata, the
agents' CIMD metadata + JWKS, the MCP servers' RFC 9728 protected-resource
metadata) are reachable over a trusted TLS cert. Those are *metadata* paths — the
actual agent→MCP→API calls stay in-mesh over ztunnel mTLS, never through the edge.

**LLM calls.** Both agents drive their tool-calling loops against **Azure OpenAI**
over HTTPS **egress** (out of cluster) — `agent-copilot` for the read/observe
path and `agent-specialist` for the privileged inspect→act→verify remediation.
These are the only calls that leave the cluster; no user or workload token is sent
to the LLM — the agents hold their MCP/API OBO tokens separately and only pass the
model tool *schemas* and the user's natural-language request.

**Mesh membership.** `web`, `agents`, `mcp`, and `apis` are enrolled in the Istio
Ambient dataplane (ztunnel L4 mTLS). `curity`, `spire*`, and `observability`
stay **out of mesh** by design: Curity
terminates external TLS and must keep a stable discovery URL; SPIRE and the
observability stack are infrastructure, not demo workloads.

**Trust domain.** All workload identities live under
`spiffe://demo.curity.local`, with IDs of the form
`spiffe://demo.curity.local/ns/<namespace>/sa/<serviceaccount>`.

---

## 4. The two delegation chains

Every agent/MCP hop performs an **RFC 8693 token exchange** against Curity,
presenting its SPIFFE JWT-SVID as the `actor_token`. Curity narrows the scope
and audience and nests the calling workload into the token's `act` claim. The
result is a per-hop token that (a) is only valid at the next audience, (b)
carries only the scopes that audience accepts, and (c) records the entire chain
of acting workloads.

The caller authenticates to Curity differently per tier. The two **agents** are
**CIMD ephemeral clients** (Client ID Metadata Documents): their `client_id` is a
self-hosted HTTPS URL Curity dereferences for a metadata document + JWKS, and they
authenticate with an asymmetric **`private_key_jwt`** assertion — no shared client
secret. The **MCP servers** remain static `client_secret_basic` clients. Either way,
the `actor_token` (SPIFFE JWT-SVID) and the `act`-chain enforcement are identical.

### 4.1 Read path (observability)

```mermaid
sequenceDiagram
    participant U as Alice
    participant W as web (BFF)
    participant A1 as agent-copilot
    participant Cu as Curity
    participant GW as agentgateway (+shim)
    participant M1 as mcp-observability
    participant B1 as obs-api
    participant K as K8s API (prod)

    U->>W: login (OIDC) + "what's failing?"
    W->>A1: Bearer user-token (aud: agent-copilot)
    A1->>Cu: exchange(subject=user, actor=copilot-SVID,<br/>aud=mcp-gateway, scope=obs:read)
    Cu-->>A1: token aud=mcp-gateway, act=[copilot]
    A1->>GW: MCP tools/call (list_pods) /observability/mcp + Bearer
    Note over GW: validate aud=mcp-gateway + obs:read tier authz<br/>shim: exchange(subject=that token, actor=gateway-SVID,<br/>aud=mcp-observability, scope=obs:read)
    Cu-->>GW: token aud=mcp-observability, act=[gateway, copilot]
    GW->>M1: MCP tools/call (narrowed token)
    M1->>Cu: exchange(subject=that token, actor=obs-mcp-SVID,<br/>aud=obs-api, scope=obs:read)
    Cu-->>M1: token aud=obs-api, act=[obs-mcp, gateway, copilot]
    M1->>B1: GET /pods + Bearer
    B1->>K: list pods / read logs (RBAC: get,list)
    K-->>B1: pod data
    B1-->>M1: pods
    M1-->>GW: tool result
    GW-->>A1: tool result
    A1-->>W: answer
    W-->>U: answer
```

### 4.2 Privileged path (LLM remediation) — A2A + step-up

The copilot forwards the user's natural-language goal (e.g. *"roll order-service
back to v1.4 and restart it"*) to the specialist over A2A. The specialist is an
**LLM agent**: it acquires *both* an `ops:write` write token and an `obs:read`
read token up front, opens both MCP toolsets, and lets the model plan across
tiers — read current state, apply a write, re-read to verify. Crucially, the
authz gates run **before** the LLM: the write-token exchange (role + scope) and
the deterministic `acr=mfa` step-up pre-check both fire first, so an
unauthorized or un-stepped-up request is rejected without ever invoking the model.

```mermaid
sequenceDiagram
    participant U as Alice (sre)
    participant A1 as agent-copilot
    participant Cu as Curity
    participant A2 as agent-specialist
    participant GW as agentgateway (+shim)
    participant M1 as mcp-observability
    participant M2 as mcp-ops
    participant B1 as obs-api
    participant B2 as ops-api
    participant K as K8s API (prod)

    A1->>Cu: exchange(subject=user, actor=copilot-SVID,<br/>aud=agent-specialist, scope=obs:read ops:write)
    Note over Cu: role gate — ops:write requires role sre OR oncall
    Cu-->>A1: token aud=agent-specialist, act=[copilot]
    A1->>A2: A2A task (NL goal) + Bearer
    Note over A2: BEFORE the LLM runs —
    A2->>Cu: exchange → aud=mcp-gateway, scope=obs:read ops:write (role+scope gate)
    Cu-->>A2: token aud=mcp-gateway, act=[specialist, copilot]
    Note over A2: deterministic acr=mfa pre-check<br/>→ 401 step-up here if not MFA, LLM never runs
    Note over A2: opens both MCP toolsets via the gateway,<br/>generateText(maxSteps=8) plans inspect→act→verify
    A2->>GW: MCP get_deployment /observability/mcp (aud=mcp-gateway)
    Note over GW: obs:read tier authz + shim OBO<br/>exchange → aud=mcp-observability, act +gateway
    GW->>M1: MCP get_deployment (narrowed token)
    M1->>B1: GET /deployments (re-exchanged)
    B1->>K: get deployment (RBAC get,list)
    K-->>B1: image / replicas / rollout status
    B1-->>M1: deployment
    M1-->>GW: tool result
    GW-->>A2: tool result (current image)
    A2->>GW: MCP set_deployment_image / restart_deployment /ops/mcp (aud=mcp-gateway)
    Note over GW: coarse ops:write tier gate + shim OBO<br/>(lists ALL ops tools) exchange → aud=mcp-ops, act +gateway
    GW->>M2: MCP set_deployment_image / restart_deployment (narrowed token)
    Note over M2: enforces scope + act-chain + acr=mfa;<br/>set_deployment_image requires role sre (denies non-sre)
    M2->>Cu: exchange → aud=ops-api, scope=ops:write
    Cu-->>M2: token act=[ops-mcp, gateway, specialist, copilot]
    M2->>B2: POST /set-image then POST /restart (re-exchanged)
    B2->>K: patch deployment (RBAC patch)
    K-->>B2: ok
    B2-->>M2: ok
    M2-->>GW: tool result
    GW-->>A2: tool result
    A2->>GW: MCP get_deployment — verify rollout (/observability/mcp)
    GW->>M1: MCP get_deployment (narrowed token)
    M1-->>GW: updated state
    GW-->>A2: updated state
    A2-->>A1: summary of what changed
```

If Alice (`[sre, oncall]`) authenticated with password only, the specialist's
deterministic pre-check (or `mcp-ops`) returns **401
`insufficient_user_authentication`** with `acr_values=mfa`; the web app drives
an MFA step-up at Curity, and the retried request carries `acr=mfa`. If
**Bob** (`[developer]`, no `ops:write` role) attempts the same, Curity's procedure
denies the very first exchange with `access_denied` — strong authentication (he
can MFA) is not the same as authorization (he lacks the role). The `ops:write`
role gate accepts `sre` **or** `oncall`; that gate makes
`restart_deployment`/`scale_deployment` available to any `ops:write` caller
(`oncall` or `sre`). The finer `set_deployment_image` = `sre`-only split is
enforced **downstream at `mcp-ops`**, not at the gateway — the gateway lists all
ops tools for any `ops:write` caller. So **Carol** (`[oncall]`, forced login-MFA)
can restart or scale, and *sees* `set_deployment_image` in `tools/list`, but the
call is refused at `mcp-ops` (a legible role-denial the specialist relays).

---

## 5. Trust relationships

| Relying party | Trusts | Verifies via |
|---|---|---|
| Browser | Istio edge gateway TLS | mkcert local CA |
| web / agents / MCP / APIs | Curity-issued JWTs | Curity JWKS (signature, `iss`, `aud`, `exp`, scope) |
| Curity (token exchange) | SPIFFE JWT-SVIDs as `actor_token` | **SPIRE's JWKS fetched at runtime** from the SPIRE OIDC Discovery Provider, verified inside the procedure (refetched on an unknown `kid`, so key rotation self-heals) |
| Curity (client auth) | the two agents' published signing keys | each agent's self-hosted **CIMD** metadata doc + JWKS, fetched over the mkcert-trusted gateway, used to verify the `private_key_jwt` assertion |
| Curity | the user | OIDC login (HTML form + TOTP) |
| Each resource server | the OBO actor chain | per-position SPIFFE-ID regex over the nested `act` claim |
| ztunnel (Ambient) | peer workloads | Istio mTLS (istiod-issued certs — a distinct trust domain from SPIRE, but the same shared root) |
| obs-api / ops-api | their own right to touch the cluster | Kubernetes RBAC — a Role/RoleBinding in `prod` bound to their `apis`-namespace ServiceAccounts |

**Two identity systems at different layers, one shared root of trust.** Istio
Ambient's mTLS uses istiod-issued workload certs for *transport* identity
(trust domain `cluster.local`); SPIRE issues JWT-SVIDs used as *application-layer*
`actor_token`s in the OAuth exchange (trust domain `demo.curity.local`). The two
trust domains are deliberately separate — but both CAs are **intermediates signed
by one cluster root**: istiod via the Istio plug-in CA (`cacerts`), SPIRE via its
`disk` UpstreamAuthority. So every X.509 in the cluster — transport certs and
X.509-SVIDs alike — chains to a single root, while the layers stay cleanly apart.

> *Why a shared root rather than SPIRE issuing Istio's certs directly?* In Istio
> **Ambient**, ztunnel obtains workload certs from istiod; consuming SPIRE-issued
> certs directly is a Solo.io enterprise feature, not upstream OSS. The shared-root
> pattern is the OSS-reachable way to get one trust anchor across both planes.

---

## 6. Security boundaries

The system fails closed at multiple independent gates. Each resource server runs
the same middleware shape (`apps/{mcp-ops,ops-api,…}/src/auth-middleware.ts`):

| Gate | Read tier (`mcp-observability` → `obs-api`) | Privileged tier (`mcp-ops` → `ops-api`) |
|---|---|---|
| **Bearer present** | ✅ | ✅ |
| **JWT valid** (sig/iss/aud/exp) | ✅ aud `mcp-observability` / `obs-api` | ✅ aud `mcp-ops` / `ops-api` |
| **Required scope** | `obs:read` | `ops:write` |
| **`act` chain present** | ✅ (no direct user call) | ✅ |
| **Exact chain length + order** | `[obs-mcp, agentgateway, copilot]` **or** `[obs-mcp, agentgateway, specialist, copilot]` (obs-api — multi-chain) | `[ops-mcp, agentgateway, specialist, copilot]` (ops-api) |
| **RFC 9470 step-up** (`acr=mfa`) | — (read is unprivileged) | ✅ at **both** hops (defense in depth) |
| **Role gate** (`sre`/`oncall` for `ops:write`) | — | ✅ Curity gates `ops:write` on `sre` OR `oncall` at exchange time; the finer `set_deployment_image` = `sre`-only split is enforced at **mcp-ops** (denies non-`sre`), not the gateway |
| **Kubernetes RBAC** | `get`/`list` pods + pods/log **and** `get`/`list` deployments in `prod` | `patch` deployments in `prod` |

Boundary properties worth calling out:

- **MCP front door (agentgateway + exchange-shim).** Before any request reaches the
  `mcp-ops`/`mcp-observability` pods, the standalone **agentgateway** in the `mcp`
  namespace (`k8s/workloads/agentgateway-config.yaml`) validates the caller's
  `aud=mcp-gateway` JWT (keys fetched live from Curity's in-cluster JWKS URL) and
  does **coarse tier authorization** — the `/ops/mcp` route requires `ops:write`,
  the `/observability/mcp` route requires `obs:read` — filtering `tools/list` by
  that tier scope and denying calls that fall outside the caller's scope/identity.
  It deliberately does **not** split ops tools by role: it lists and allows *all*
  ops tools (`restart_deployment`/`scale_deployment`/`set_deployment_image`) for
  any `ops:write` caller. (agentgateway couples `tools/list` visibility to
  call-authorization, so gating `set_deployment_image` here would *hide* it from an
  `oncall` caller and the specialist LLM would loop silently rather than surface a
  denial; that finer split is therefore enforced downstream at `mcp-ops`.) It is
  path-routed — `/observability/mcp` → mcp-observability, `/ops/mcp` → mcp-ops —
  because agentgateway v1.3.1 does not expose `mcp.tool.target` in its `extAuthz`
  CEL scope, so per-backend audience narrowing can't be done on a single federated
  endpoint. For each tool-call the gateway drives an `extAuthz` call to the
  co-located **exchange-shim** (`apps/exchange-shim`, same pod), which performs the
  RFC 8693 OBO exchange — presenting the gateway's SPIFFE JWT-SVID as `actor_token`,
  the caller's token as subject, and a **server-derived** per-backend audience/scope
  (from an allow-list, never caller-supplied) — and hands back the narrowed token the
  gateway swaps onto the request. This inserts one `act` position
  (`…/ns/mcp/sa/agentgateway`). It deliberately does **not** enforce the `act`
  chain or step-up — those stay in the resource-server middleware below, because the
  gateway's generic deny cannot carry the RFC 9470 `WWW-Authenticate` challenge the
  step-up flow needs, nor match the nested `act.act.sub` chain (the step-up 401 still
  originates at mcp-ops/ops-api and passes back through the gateway).
- **Audience confinement.** Each exchanged token names exactly one audience.
  A token minted for `mcp-observability` is rejected by `mcp-ops` and vice-versa,
  so a leaked read-tier token cannot drive a write.
- **Scope-by-audience caps.** Curity's procedure keys allowed scopes *by
  audience*, so `agent-copilot` cannot obtain `ops:write` for the read-only
  `mcp-observability` audience even though it legitimately needs `ops:write`
  when forwarding to `agent-specialist`.
- **Chain integrity.** The nested `act` chain is pinned per position. A
  truncated or spliced chain (e.g. presenting a mid-chain token directly to a
  deeper server) fails the length/order check.
- **Least-privilege blast radius.** Only `obs-api`/`ops-api` hold cluster
  credentials, scoped to one namespace and a handful of verbs. Compromising a
  thin MCP server yields no standing cluster access.
---

## 7. Observability

Every service is OpenTelemetry-instrumented and exports OTLP to a Collector,
which forwards to Tempo; Grafana reads Tempo via TraceQL. A single user request
becomes **one distributed trace** spanning all hops, with two identity layers
stamped onto the spans.

```mermaid
flowchart LR
  subgraph apps["instrumented services"]
    W["web (@vercel/otel)"]
    A["agent-copilot / agent-specialist"]
    M["MCP servers + obs-api / ops-api"]
  end
  subgraph obs_ns["observability namespace (out of mesh)"]
    COL["OTel Collector"]
    T["Tempo"]
    G["Grafana"]
  end
  W -- "OTLP/HTTP :4318" --> COL
  A -- "OTLP/HTTP :4318" --> COL
  M -- "OTLP/HTTP :4318" --> COL
  COL -- "OTLP/gRPC :4317" --> T
  G -- "TraceQL" --> T
  P["presenter"] -- "https://grafana.localtest.me" --> G
```

| Layer | Attribute kind | Attributes | Source |
|---|---|---|---|
| **Human** | span attributes | `auth.sub`, `auth.scope`, `auth.acr`, `auth.aud`, `auth.roles`, `auth.act[]` | `decorateSpanWithIdentity()` in `packages/auth-curity`, stamped at JWT validation; `auth.act[]` grows along the chain |
| **Workload** | resource attribute | `spiffe.id` | `packages/otel-bootstrap`, read from the SVID file at SDK init |
| **Exchange** | span (`auth.token_exchange`) | `auth.exchange.audience`, `…scope`, `…client_id`, `…issued_scope` | `exchangeToken()` in `packages/auth-curity` |
| **MCP** | span attributes | `mcp.tool`, `mcp.resource_metadata_url` | the MCP `POST /` handler |

The six plain-Node services (both agents, both MCP servers, both backend APIs)
load `@ai-agents-demo/otel-bootstrap` via `node --import`; `apps/web` (Next
standalone, CommonJS) uses `@vercel/otel`.
Trace context propagates on the wire via a composite W3C + B3 propagator, so
the spans stitch into a single trace.

---

## 8. Standards used

| RFC / spec | Where it shows up |
|---|---|
| **OIDC / OAuth 2.0** | Curity issues the user token (code + PKCE) |
| **RFC 8693** token exchange | every agent/MCP hop; nested `act` per §4.1 |
| **CIMD** (Client ID Metadata Documents draft) + **RFC 7523** `private_key_jwt` | the two agents authenticate as ephemeral clients — `client_id` is a self-hosted metadata URL, auth is an asymmetric signed assertion |
| **SPIFFE / SPIRE** | per-workload JWT-SVID, presented as `actor_token` |
| **RFC 9470** step-up | `acr=mfa` required for `ops:write`; `WWW-Authenticate: insufficient_user_authentication` |
| **RFC 9728** protected-resource metadata | MCP/API `.well-known/oauth-protected-resource`, echoed in step-up challenges |

---

## See also

- [`design.md`](design.md) — module-level implementation reference.
- [`demo.md`](demo.md) — the end-to-end runbook and presenter script.
- [`curity-seed.md`](curity-seed.md) — offline Curity setup checklist.
