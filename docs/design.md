# Design

Module-level technical reference for the implementation. Read
[`architecture.md`](architecture.md) first for the system overview; this
document covers *how each module is built*, its interfaces, and the decisions
behind it.

The repository is a pnpm + Turborepo monorepo. Two trees matter:

- **`apps/`** — deployable services (each has a `Dockerfile`).
- **`packages/`** — shared `@ai-agents-demo/*` libraries consumed by the apps.

```
apps/        web  agent-copilot  agent-specialist
             mcp-observability  mcp-ops  obs-api  ops-api  exchange-shim
packages/    auth-curity  spiffe  otel-bootstrap  a2a-helpers  agent-runtime
k8s/         curity  spire  istio  observability
             workloads (incl. agentgateway)  prod  kind
scripts/     bootstrap + smoke-test shell scripts
```

---

## 1. Shared packages

### `@ai-agents-demo/auth-curity`

The single owner of every "what Curity expects" rule. Nothing else in the repo
re-implements issuer/audience/JWKS logic.

| File | Exports | Responsibility |
|---|---|---|
| `verify.ts` | `verifyJwt(token, {issuer, audience, jwksUri})` → `VerifiedJwt` | Validates signature against cached JWKS, `iss`, `aud`, `exp` (with clock skew); returns the payload plus a parsed `scopes` Set. Surfaces the standard OIDC `acr` claim. |
| `oidc.ts` | `getOidcConfig(issuer)` | Fetches/normalizes the OIDC discovery document. |
| `exchange.ts` | `exchangeToken(params)` → `ExchangeTokenResult` | Performs the RFC 8693 call (see §3.1). Wraps it in an `auth.token_exchange` span. Client auth is a discriminated `clientAuth` — `basic` or `private_key_jwt`. |
| `cimd.ts` | `createCimdIdentity({privateKeyPkcs8Pem, clientId})` → `CimdIdentity` | For the ephemeral agents: derives the public JWK + `kid` (RFC 7638 thumbprint) from the PKCS8 key; produces the `metadataDocument()` + `jwks()` the agent self-hosts. |
| `identity-span.ts` | `buildIdentityAttributes()`, `decorateSpanWithIdentity()` | Pure builder + active-span stamp for the `auth.*` span attributes, including the flattened `act[]` chain. |
| `errors.ts` | `CurityAuthError`, `CurityAuthErrorCode` | Typed error with an OAuth-style `code`; maps Curity's wire errors (incl. its `access_denied`→`invalid_request` sanitization) back to clean codes. |

### `@ai-agents-demo/spiffe`

Reads SPIFFE JWT-SVIDs that the `spiffe-helper` sidecar materializes to disk.

| File | Exports | Responsibility |
|---|---|---|
| `svid-source.ts` | `SpiffeJwtSvidSource({audiences:[{audience, filePath}]})`, `.getSvid(aud)` | Reads + caches the compact JWT-SVID for a given audience; re-reads on rotation (5-min TTL). Used to obtain the `actor_token`. |
| `read-spiffe-id.ts` | `readSpiffeId(file)` | Synchronous `sub` extractor used by `otel-bootstrap` to set the `spiffe.id` resource attribute at SDK init. |

### `@ai-agents-demo/otel-bootstrap`

Boot-time OpenTelemetry wiring for the plain-Node services. Loaded via
`node --import @ai-agents-demo/otel-bootstrap`.

| File | Responsibility |
|---|---|
| `telemetry.ts` | NodeSDK + HTTP/fetch auto-instrumentation + OTLP/proto exporter + composite W3C/B3 propagator. |
| `resource.ts` | Builds the OTel `Resource`: `service.name`, `service.namespace`, and `spiffe.id` (read from the SVID file). |

### `@ai-agents-demo/a2a-helpers`

Thin wrapper around agent-to-agent communication so the SDK shape is owned in
one place.

| File | Responsibility |
|---|---|
| `server.ts` | A2A task endpoint factory used by `agent-specialist`. |
| `client.ts` | A2A client used by `agent-copilot` to call the specialist with a forwarded Bearer token. |
| `step-up-error.ts` | Structured carrier for an RFC 9470 challenge so a downstream 401 survives the A2A boundary (the SDK otherwise swallows executor throws) — the challenge is **message-encoded**. |

### `@ai-agents-demo/agent-runtime`

Shared LLM-agent plumbing consumed by **both** agents, so the model-provider
wiring and the MCP→tool adapter live in one place. `agent-copilot` was refactored
onto it (its `llm.ts` is now a thin wrapper and its `mcp-client.ts` re-exports
from this package); `agent-specialist` depends on it directly.

| File | Exports | Responsibility |
|---|---|---|
| `llm.ts` | `buildLlm(cfg, opts?)` | Provider wiring — selects the Vercel AI SDK model by `LLM_PROVIDER` (`gateway` **default**: an OpenAI-compatible client pointed at agentgateway's `/llm` route, requires a per-request `opts.accessToken`; `anthropic`/`ollama` alternatives). The old `azure` provider (direct `@ai-sdk/azure`) is gone — see §3.6. |
| `mcp-toolset.ts` | `openMcpToolset({url, bearerToken, …})` → `McpToolset`, `jsonSchemaToZod` | Connects to an MCP server over Streamable HTTP with a Bearer token, converts each MCP tool's JSON-Schema input into a Zod schema, and exposes them as a Vercel AI SDK `ToolSet`. `.close()` tears the connection down. An optional `fetchImpl` lets the caller intercept responses (e.g. the specialist's step-up interceptor). |

---

## 2. Applications

### Tiers

```
web (BFF)  →  agent-copilot  ─┬─ MCP ─→ agentgateway ─→ mcp-observability ─→ obs-api ─→ K8s
                              └─ A2A ─→ agent-specialist ─→ agentgateway ─┬─→ mcp-ops ─→ ops-api ─→ K8s
                                                                          └─→ mcp-observability ─→ obs-api ─→ K8s

agent-copilot / agent-specialist ─ LLM ─→ agentgateway (/llm) ─→ Azure OpenAI
```

`agentgateway` (ns `mcp`) is the MCP front door for both MCP servers — the agents
target `aud=mcp-gateway` and pick a path (`/observability/mcp`, `/ops/mcp`); its
co-located `exchange-shim` sidecar performs the per-backend OBO exchange (§2, §3.5).
It is also the **LLM egress gateway**: both agents exchange for
`aud=llm-gateway`/`scope=llm:invoke` and call its OpenAI-compatible `/llm` route,
which holds the only Azure OpenAI credential in the system (§3.6).

| App | Stack | Inbound | Outbound | Auth role |
|---|---|---|---|---|
| **web** | Next.js App Router, Auth.js | Browser (session cookie) | `agent-copilot` (Bearer user token) | BFF; OIDC client `web-app`. No SPIFFE ID (not a workload actor). |
| **agent-copilot** | Express + Vercel AI SDK (via `@ai-agents-demo/agent-runtime`; `LLM_PROVIDER` `gateway` default, also `anthropic`/`ollama`) | Bearer user token | `agentgateway` (`aud=mcp-gateway`, `aud=llm-gateway`), `agent-specialist` | Validates user token; **CIMD ephemeral exchange client** (`private_key_jwt`; self-hosts its metadata + JWKS). Reaches `mcp-observability` **through the agentgateway** (no longer directly). Routes any privileged write goal (restart/image-update/scale) to the specialist over A2A, forwarding the user's NL goal verbatim. Also exchanges a token to `aud=llm-gateway`/`scope=llm:invoke` (single exchange, no shim/act-chain) and drives its tool-calling loop against agentgateway's `/llm` route rather than Azure directly (§3.6). |
| **agent-specialist** | Express + Vercel AI SDK (via `@ai-agents-demo/agent-runtime`) + A2A server | A2A + Bearer | `agentgateway` (`aud=mcp-gateway`, `aud=llm-gateway`) | Privileged **LLM agent**. Validates the OBO token; **CIMD ephemeral exchange client** (`private_key_jwt`). Acquires one `aud=mcp-gateway` token (scope `obs:read ops:write`) and reaches both MCP servers **through the agentgateway** (paths `/ops/mcp` + `/observability/mcp`), opens both toolsets, and runs a tool-using LLM loop. Core orchestration is a testable `runRemediation` (deps injected); the A2A adapter wraps it. All authz gates are **outside** the LLM loop — see §2 below. Like the copilot, its model calls are exchanged to `aud=llm-gateway`/`scope=llm:invoke` and routed through agentgateway's `/llm` route (§3.6). |
| **agentgateway** | agentgateway v1.4.1 (OSS, pinned) + co-located `exchange-shim` sidecar | Bearer (`aud=mcp-gateway`) on `/observability/mcp` \| `/ops/mcp`; Bearer (`aud=llm-gateway`) on `/llm` | `mcp-observability`, `mcp-ops`, Azure OpenAI | MCP front door **and** LLM egress gateway. For MCP: validates the caller's JWT, applies **coarse per-tier scope authz** (per-route `ops:write`/`obs:read`) + `tools/list` filtering, and for each tool-call calls the shim (`extAuthz`) for the per-backend OBO exchange, then swaps the narrowed token onto the request. Inserts one `act` position (`…/ns/mcp/sa/agentgateway`). Does *not* split ops tools by role (the `set_deployment_image`=`sre` split is enforced at mcp-ops), nor enforce the `act` chain or step-up. For `/llm`: validates `aud=llm-gateway` + `llm:invoke`, then injects the Azure API key upstream — no shim, no `act`-chain (§3.6). |
| **exchange-shim** | Node/TypeScript (Express); `@ai-agents-demo/auth-curity` + `@ai-agents-demo/spiffe` | `extAuthz` from agentgateway (`:8090`, same pod) | Curity token endpoint | Performs the RFC 8693 exchange: reads the gateway's rotating SPIFFE JWT-SVID (`/run/spiffe/curity-actor.jwt`) as `actor_token`, subject = the caller's `aud=mcp-gateway` token, audience/scope derived **server-side** from an audience→scope allow-list (never caller-supplied). Returns a token-endpoint-shaped JSON body. Exists because agentgateway's CEL cannot read the rotating SVID file. |
| **mcp-observability** | Express + MCP Streamable HTTP (SDK v2, revision 2026-07-28 only — §3.7) | Bearer OBO token (from the gateway) | `obs-api` | Validate → re-exchange → forward. Thin client. Tools: `list_pods`, `get_logs`, `get_deployment` (read). |
| **mcp-ops** | Express + MCP Streamable HTTP (SDK v2, revision 2026-07-28 only — §3.7) | Bearer OBO token (from the gateway) | `ops-api` | Validate (+step-up) → re-exchange → forward. Thin client. Tools: `restart_deployment`, `set_deployment_image`, `scale_deployment` (write). Enforces the fine-grained role split the gateway can't: denies `set_deployment_image` for callers whose `roles` lack `sre` (`Config.setImageRequiredRoles`, default `['sre']`, env `SET_IMAGE_REQUIRED_ROLES`), returning a legible role-denial before the ops-api hop. |
| **obs-api** | Express + `@kubernetes/client-node` | Bearer | K8s API (`prod`) | Resource server; `GET /pods`, `GET /pods/:name/logs`, `GET /deployments/:name` (image/replicas/rollout status). RBAC `get,list` on pods and deployments. Accepts **two** actor chains (see §2 middleware). |
| **ops-api** | Express + `@kubernetes/client-node` | Bearer | K8s API (`prod`) | Resource server; `POST /restart`, `POST /set-image` (strategic-merge patch; container name == deployment name), `POST /scale` — each patches a deployment. |

### Resource-server middleware

`mcp-{observability,ops}` and `{obs,ops}-api` share one middleware shape
(`src/auth-middleware.ts`). In order, each request must pass:

1. **Bearer present** → else 401 `invalid_token`.
2. **`verifyJwt`** (sig/iss/aud/exp) → decorate the active span with identity.
3. **Required scope** (`obs:read` or `ops:write`) → else 403 `insufficient_scope`,
   with `scope` **and** `resource_metadata` on the challenge (MCP 2026-07-28 asks for
   the latter "for consistency with 401 responses").
4. **`act` present** → else 403 `act_required` (no direct user invocation allowed).
5. **Exact actor chain** — `walkActChain()` flattens the nested `act` outer→inner;
   length and per-position SPIFFE-ID regex must match the expected chain. Most
   servers pin a **single** chain (`expectedActorChain`) and emit fine-grained
   codes (`act_chain_length` / `act_chain_order` / `act_chain_unknown`). **obs-api
   is the exception:** it accepts **multiple** chains (`expectedActorChains`, a
   `RegExp[][]`) via `chainMatchesAny()` — copilot reading directly *or* the
   specialist reading while it remediates — and collapses to one `act_chain` code
   (per-position diagnostics are ambiguous when several chains are valid).
6. **(Privileged tier only) RFC 9470 step-up** — `acr === 'mfa'` → else 401
   `insufficient_user_authentication` with `acr_values=mfa` + `resource_metadata`.

> **Note — step-up is ours, not MCP's.** MCP's authorization chapter (through
> `2026-07-28`) defines step-up purely in terms of *scopes*: a 403
> `insufficient_scope` challenge and a client-side scope union. It has no notion of
> authentication strength. Step 6 is RFC 9470 layered on top, and the
> `acr_values_supported` field our RFC 9728 documents advertise is likewise
> non-standard — it is borrowed from OpenID Provider metadata, which RFC 9728 does
> not define for protected resources. Both are deliberate demo-local extensions: an
> off-the-shelf MCP client will honour the 403/`scope` path but will not know what to
> do with `acr_values`. See `apps/mcp-*/src/protected-resource-metadata.ts`.

Expected chain(s) per service (outer = most recent actor):

| Service | Expected chain(s) |
|---|---|
| `mcp-observability` | *(no act-chain enforced in its own middleware; obs-api enforces downstream)* |
| `obs-api` | `[mcp-observability, agentgateway, agent-copilot]` **or** `[mcp-observability, agentgateway, agent-specialist, agent-copilot]` |
| `mcp-ops` | `[agentgateway, agent-specialist, agent-copilot]` |
| `ops-api` | `[mcp-ops, agentgateway, agent-specialist, agent-copilot]` |

agentgateway's `/llm` route is not in this table — it enforces `aud=llm-gateway` +
`llm:invoke` but no `act`-chain at all (see §3.6).

### The specialist's remediation loop (`runRemediation`)

`agent-specialist`'s orchestration core (`src/executor.ts`) is a single testable
function, `runRemediation`, with all I/O injected as deps (token acquisition, MCP
toolset opening, the LLM call, RFC 9728 metadata fetch). The A2A adapter
(`buildExecutor`) wires the real deps and publishes the result onto the event
bus. **Every authorization gate sits outside the LLM loop**, in this fixed order:

1. **Empty-goal guard** — reject before any token exchange or MCP connection.
2. **WRITE token first** — exchange for `ops:write` to `mcp-ops`. This is where
   the **role gate** (`sre`) and **scope gate** fire; an unauthorized caller is
   denied here, before the model runs. An `invalid_scope` is reshaped into a
   step-up challenge.
3. **Deterministic `acr=mfa` pre-check** — if the inbound token isn't MFA-backed,
   return an RFC 9470 step-up challenge **before the LLM is ever invoked** (the
   challenge is built from `mcp-ops`'s RFC 9728 metadata, falling back to config).
4. **READ token + open both toolsets** — exchange for `obs:read` to
   `mcp-observability` (no MFA), then open *both* MCP toolsets; a partial-open
   failure still closes whatever connected.
5. **Run the LLM** — `generateText` (`maxSteps: 8`) over the merged toolset
   (`get_deployment` read + `restart_deployment`/`set_deployment_image`/
   `scale_deployment` write). The system prompt (`system-prompt.ts`) directs an
   inspect→act→verify loop. The specialist holds **two tokens** for the whole run.

---

## 3. Internal workflows

### 3.1 RFC 8693 token exchange (`exchangeToken`)

Each agent/MCP client `POST`s to Curity's token endpoint with:

```
grant_type            = urn:ietf:params:oauth:grant-type:token-exchange
subject_token         = <inbound Curity token>          subject_token_type=...:access_token
actor_token           = <this workload's SPIFFE JWT-SVID>  actor_token_type=...:jwt
audience              = <single target audience>
scope                 = <requested scopes>
requested_token_type  = ...:access_token
```

Client authentication is a discriminated `clientAuth` parameter
(`packages/auth-curity/src/exchange.ts`):

- **`private_key_jwt`** (the two agents — CIMD ephemeral clients): a short-lived
  assertion (`iss`=`sub`=`client_id` URL, `aud`=token endpoint, 60 s, unique `jti`)
  is signed with the agent's RSA key and sent as `client_assertion`. The public key
  is published at the agent's self-hosted JWKS; `createCimdIdentity` (`cimd.ts`)
  derives both the JWK and the assertion `kid` (RFC 7638 thumbprint) from the one
  PKCS8 key, so there is no public/private drift.
- **`basic`** (default — the MCP servers): `client_secret_basic` as before.

Errors are normalized to `CurityAuthError` codes. Notably, a procedure-thrown
`access_denied` is sanitized by Curity to `invalid_request` with the original
code prefixed into the description; `exchange.ts` reclassifies it back so the
role-gate denial surfaces as a clean `access_denied` rather than a generic 502.

### 3.2 The Curity token-exchange procedure

`k8s/curity/procedures/token-exchange.js` is the policy brain. Together with the
authorization-code procedure `authorization-code.js` (which stamps the standard
`acr` claim onto the login token — see §7), both are embedded as Base64 into the
Curity configmap by `scripts/embed-curity-procedures.sh` (`make curity-procedures`).
On each exchange the token-exchange procedure:

1. **Verifies the `actor_token`** (SPIFFE JWT-SVID) with **jose4j** against
   **SPIRE's JWKS fetched at runtime** (`httpsGet()`) from the SPIRE OIDC
   Discovery Provider — the resolver is cached across invocations and refetched on
   an unknown `kid`, so a fresh cluster or SPIRE key rotation needs no snapshot —
   requiring `aud = https://curity.localtest.me/oauth/v2/oauth-token` and a `sub`
   under `spiffe://demo.curity.local/ns/`. (Curity's built-in
   `getPresentedActorToken()` expects a server-issued actor, so the raw form param
   is read directly.)
2. **Looks up a per-client policy** (`CLIENT_POLICY`) keyed by client ID
   (`context.getClient().getId()` — for the ephemeral agents this is their
   `client_id` URL), with an `allowedActors` regex (the exact SPIFFE ID the
   client may present) and a `perAudience` map.
3. **Confines audience + scope:** the requested audience must be in `perAudience`;
   the issued scope is `requested ∩ subject ∩ policy(audience)`. **Scopes are
   keyed by audience** so a client can't pull a privileged scope under an
   unprivileged audience.
4. **Role gate:** if `ops:write` is requested and the subject lacks role `sre`
   **or** `oncall`, fail `access_denied`. (Fine-grained per-tool role splitting —
   e.g. `set_deployment_image` for `sre` only — is applied downstream at
   **mcp-ops**, not the gateway; see §3.5.)
5. **Nests `act`:** if the subject token already carries an `act`, wrap it under
   the new actor (`{sub: thisActor, act: priorChain}`); else `{sub: thisActor}`.
   Innermost = oldest.
5b. **Enforces and re-stamps `may_act`** (RFC 8693 §4.4). The subject token names
   the single workload permitted to act for it; the procedure requires the verified
   actor SVID to match before issuing, then stamps a **narrowed** `may_act` on the
   issued token naming whoever legitimately presents it next (`perAudience.mayAct`).
   This is a second, independent source of truth alongside `allowedActors`: that one
   is server config keyed by the *requesting client*, this one is a grant carried in
   the token and keyed by the *subject*, so a config mistake alone cannot widen
   delegation. `act` records who **did** act (audit); `may_act` grants who **may**
   act next (authorization). Terminal audiences (`llm-gateway`, `obs-api`, `ops-api`)
   carry none — nothing exchanges those onward — and an absent claim means
   unconstrained, so tokens minted before the claim existed still work out their
   lifetime. The login token's `may_act` (naming `agent-copilot`) is stamped by
   `authorization-code.js`. Surfaced in OBO logs via `summarizeJwt().mayAct`.

6. **Propagates** `acr` and `roles` onto the issued token so step-up and the
   role gate work at every hop of the chain.

The per-client policy as configured:

| Client (`CLIENT_POLICY` key) | Audience → scopes | Allowed actor SPIFFE ID |
|---|---|---|
| `https://copilot.localtest.me/.well-known/oauth-client` | `mcp-gateway`→`obs:read`; `agent-specialist`→`obs:read ops:write llm:invoke`; `llm-gateway`→`llm:invoke` | `…/ns/agents/sa/agent-copilot` |
| `https://specialist.localtest.me/.well-known/oauth-client` | `mcp-gateway`→`obs:read ops:write`; `llm-gateway`→`llm:invoke` | `…/ns/agents/sa/agent-specialist` |
| `mcp-gateway` | `mcp-observability`→`obs:read`; `mcp-ops`→`ops:write` | `…/ns/mcp/sa/agentgateway` |
| `mcp-ops` | `ops-api`→`ops:write` | `…/ns/mcp/sa/mcp-ops` |
| `mcp-observability` | `obs-api`→`obs:read` | `…/ns/mcp/sa/mcp-observability` |

### 3.3 SVID delivery

A `spiffe-helper` (v0.11.0) sidecar in every workload pod fetches a JWT-SVID for
audience `https://curity.localtest.me/oauth/v2/oauth-token` and writes it to
`/run/spiffe/curity-actor.jwt` (5-min TTL, shared memory `emptyDir`). The sidecar
runs as UID 1000 to match the `node` user so the app can read its own SVID
(the helper writes mode 0600 with no override knob in this version).

### 3.4 Identity tracing

After `verifyJwt`, every service calls `decorateSpanWithIdentity(verified)`,
stamping `auth.sub/scope/acr/aud/roles/act[]` onto the active HTTP span.
`spiffe.id` is a resource attribute (same for all of a service's spans).
`exchangeToken` opens an `auth.token_exchange` child span recording the
requested vs issued scope — making scope narrowing visible in the trace.

### 3.5 The agentgateway + exchange-shim (MCP front door)

`agentgateway` (`k8s/workloads/agentgateway-config.yaml`, ns `mcp`, Service
`agentgateway.mcp.svc.cluster.local:8080`) is the single MCP front door for both
MCP servers, replacing the former Istio ambient waypoint.

- **One audience, one gateway.** Both agents now target a single Curity audience,
  **`mcp-gateway`** (confidential `client_secret_basic` client), rather than the MCP
  servers directly. The gateway validates that JWT (issuer
  `https://curity.localtest.me/oauth/v2/oauth-anonymous`; JWKS fetched from the
  in-cluster plain-HTTP URL `http://curity.curity.svc.cluster.local:8443/oauth/v2/oauth-anonymous/jwks`).
- **Path-routed, not federated.** ONE listener (`:8080`) exposes TWO path-scoped
  routes — `/observability/mcp` → mcp-observability and `/ops/mcp` → mcp-ops. It is
  path-routed (not a single federated `/mcp`) because agentgateway **v1.3.1** (latest
  OSS) does not expose `mcp.tool.target` inside its `extAuthz` CEL scope, so
  per-backend audience narrowing can't be done on one federated endpoint. Callers
  pick the path.
- **Coarse tier authorization (per-tier scope, not per-tool role).**
  `mcpAuthorization` filters `tools/list` and gates calls by the **tier scope** of
  the route: `/ops/mcp` requires `ops:write`, `/observability/mcp` requires
  `obs:read`. The gateway does **not** split ops tools by role — it lists and
  allows *all* ops tools (`restart_deployment`/`scale_deployment`/
  `set_deployment_image`) for any `ops:write` caller. It can't do the finer split
  because agentgateway couples `tools/list` visibility to call-authorization: a
  tool it won't let you call is also *hidden* from `tools/list`, so gating
  `set_deployment_image` here would hide it from an `oncall` caller and the
  specialist LLM (never seeing the tool) would loop silently instead of surfacing a
  denial. The `set_deployment_image` = `sre`-only split is therefore enforced
  downstream at **mcp-ops** (`Config.setImageRequiredRoles`, default `['sre']`; see
  §2 mcp-ops), which checks the caller's `roles` claim before the ops-api hop and
  returns a legible role-denial the specialist relays. Demo users:
  alice=`[sre, oncall]` (password-only → step-up demo), bob=`[developer]` (denied
  `ops:write` at the Curity exchange), carol=`[oncall]` (forced login-MFA; can
  restart/scale, and *sees* `set_deployment_image` in `tools/list` but the call is
  refused at mcp-ops).
- **extAuthz → exchange-shim = the OBO hop.** For each tool-call the gateway makes
  an `extAuthz` call to the co-located **`exchange-shim`** (`apps/exchange-shim`,
  `:8090`, same pod). The shim performs the RFC 8693 exchange — reading the gateway's
  rotating SPIFFE JWT-SVID from `/run/spiffe/curity-actor.jwt` (spiffe-helper
  sidecar) as the `actor_token`, the caller's `aud=mcp-gateway` token as the subject,
  and a per-backend audience/scope derived **server-side** from an audience→scope
  allow-list (never caller-supplied) — reusing `@ai-agents-demo/auth-curity`
  `exchangeToken` + `@ai-agents-demo/spiffe`. It returns a token-endpoint-shaped JSON
  body; the gateway swaps the returned narrowed token onto the request and forwards
  to the origin MCP server. **The shim exists because agentgateway's CEL cannot read
  the rotating SVID file**, so the exchange is done in a co-located sidecar.
- **`act`-chain position.** The exchange nests the gateway's SPIFFE ID
  (`spiffe://demo.curity.local/ns/mcp/sa/agentgateway`) as one new `act` position, so
  every downstream chain grows by it (see the actor-chain table in §2).
- **What it does NOT do (unchanged from the waypoint's limits).** It does not enforce
  `acr`/step-up (RFC 9470) or match the nested `act` chain — those stay in the
  resource-server middleware. The RFC 9470 step-up 401 still originates at
  mcp-ops/ops-api and passes back through the gateway. Source identity at the gateway
  is the JWT audience (`aud=mcp-gateway`), not mTLS SPIFFE identity.

### 3.6 LLM egress via agentgateway (`/llm`)

Both agents route every Azure OpenAI call through agentgateway's OpenAI-compatible
`/llm` route (`/llm/chat/completions`) instead of calling Azure directly.

- **One exchange, no shim, no `act`-chain.** Each agent exchanges the user's
  access token (subject) + its SPIFFE JWT-SVID (actor) for `aud=llm-gateway`,
  `scope=llm:invoke` — a single RFC 8693 call, the same shape as any other hop.
  Unlike the MCP routes, there is **no `extAuthz`/`exchange-shim` call and no
  `act`-chain match** on `/llm`: Azure sits outside the Curity/SPIFFE trust
  domain, so there is no downstream workload identity to nest into `act` — it's
  a one-hop credential swap (a user-authorized JWT in, an Azure api-key out),
  not a delegation chain.
- **Gateway route config** (`k8s/workloads/agentgateway-config.yaml`): `jwtAuth`
  validates `aud=llm-gateway` (same issuer/JWKS as the MCP routes — issuer
  `https://curity.localtest.me/oauth/v2/oauth-anonymous`, JWKS from the
  in-cluster plain-HTTP `.../oauth-anonymous/jwks`); an `authorization` rule
  (`'"llm:invoke" in (jwt.scope.split(" "))'`) gates the scope; `backendAuth.key`
  injects the Azure credential as header `api-key` (prefix `""`, **not**
  `Authorization: Bearer`); the backend is `ai:` provider `azure` with
  `resourceType: openAI` (lowercase-o), `resourceName: $AZURE_RESOURCE_NAME`,
  `model: gpt-4.1`, `apiVersion: "2024-04-01-preview"`.
- **The gateway holds the only Azure key.** `AZURE_OPENAI_API_KEY` +
  `AZURE_RESOURCE_NAME` come from the `agentgateway-llm` Secret (ns `mcp`),
  seeded out-of-band by `make seed-llm-secret` (which derives
  `AZURE_RESOURCE_NAME` from the endpoint host). The agents no longer hold
  `AZURE_OPENAI_API_KEY` — it was removed from `agent-copilot.yaml` /
  `agent-specialist.yaml`, and the old per-agent `agent-*-llm` secrets are gone.
- **`buildLlm` gateway mode** (`packages/agent-runtime/src/llm.ts`):
  `buildLlm(cfg, { accessToken })` builds an OpenAI-compatible client
  (`@ai-sdk/openai`) with `baseURL` pointed at the `/llm` route and `apiKey` set
  to the exchanged `aud=llm-gateway` JWT — sent as the OpenAI
  `Authorization: Bearer`, which the gateway validates and swaps for the Azure
  api-key upstream. `LLM_PROVIDER` is now `gateway | anthropic | ollama`
  (`azure` removed); default `LLM_PROVIDER=gateway`, model `gpt-4.1`.
- **`obtainLlmToken`** (per-app `apps/agent-{copilot,specialist}/src/llm-token.ts`,
  mirrors `obtainMcpToken`, TTL-cached 60 s keyed on sub/scope/audience/acr):
  `agent-copilot` obtains the token per-request in `server.ts` **before**
  opening the MCP toolset, so a token failure returns `502 llm_unavailable`
  without leaking a toolset connection. `agent-specialist` threads the token
  through its `runLlm` dependency (a new `accessToken` param) — obtained inside
  `runRemediation`, within the same try/finally that closes the MCP toolsets.
  Both build the model per-request (no client cached across requests).
- **Curity.** New `llm:invoke` scope; both agents' `perAudience` policy in
  `token-exchange.js` gained `'llm-gateway': { scopes: ['llm:invoke'] }` (see the
  policy table in §3.2). There is **no new Curity client** for this hop —
  `llm-gateway` is just an audience the gateway validates; since the route does
  no re-exchange, it needs no client secret or shim.

#### `llm:invoke` is a user-delegated scope — it must be granted at every hop that narrows it

`llm:invoke` originates in the **user's** access token (the LLM call is
on-behalf-of the user) and is then narrowed down the delegation chain by RFC 8693
exchanges. Curity's exchange procedure computes `requested ∩ subject ∩ policy` at
each hop (`token-exchange.js`), so the scope drops out of the chain the moment any
one link omits it. Granting it end-to-end touches **eight** places — miss one and
the exchange fails with `invalid_scope: no scope intersects subject + policy` (or,
if the *client* isn't allowed to request it, Curity's `No valid scope was
requested`). The full grant map:

| # | Where | Purpose |
|---|-------|---------|
| 1 | `configmap.yaml` global `<scopes>` | the scope exists at all |
| 2 | `token-exchange.js` `perAudience` `llm-gateway → llm:invoke` (both agents) | an agent may narrow to it for `aud=llm-gateway` |
| 3 | `configmap.yaml` **web-app** client `<scope>llm:invoke` | the user's login token *may* carry it |
| 4 | `configmap.yaml` **`<ephemeral-client>`** `<scope>llm:invoke` | the agents (CIMD clients) may *request* it in an exchange |
| 5 | `apps/web/src/auth.ts` login `scope` | the user token *does* carry it after login |
| 6 | `apps/web/src/app/chat.tsx` step-up re-auth `scope` | the **post-MFA** token keeps it (the step-up scope string *overrides* the login default — omitting it silently strips `llm:invoke` on the privileged path) |
| 7 | `token-exchange.js` `perAudience` `agent-specialist → …llm:invoke` (copilot) | the copilot→specialist **delegation** token carries it |
| 8 | copilot `SPECIALIST_SCOPE` (`agent-copilot.yaml` env + `config.ts` default) | the copilot *requests* it in the A2A delegation exchange |

  Rows 1–5 cover the copilot's direct `/llm` calls (read flow); 6–8 additionally
  cover the specialist's `/llm` calls during a privileged remediation (restart
  flow), because the specialist's *subject* token is the `aud=agent-specialist`
  token the copilot mints for it.

- **External DNS egress for the gateway.** The `/llm` backend is a public Azure
  host, so agentgateway must resolve an external name — unlike every other backend
  (all in-cluster `*.svc.cluster.local`). agentgateway's Rust (hickory) resolver
  inherits the pod's `resolv.conf` (`ndots:5`, cluster search domains) and, with
  defaults, fails on the external host with `503 "backends required DNS resolution
  which failed" (NoHealthyBackend)` where glibc/Node succeed. Two causes, both
  fixed via the config schema's top-level `config.dns` block
  (`k8s/workloads/agentgateway-config.yaml`): the Azure host has **no AAAA record**
  (`ENODATA`) so `lookupFamily: V4Only` drops the IPv6 lookup, and its A answer is a
  CNAME chain + several records that overflows the 512-byte UDP limit so
  `edns0: true` lets CoreDNS return it whole (without EDNS the truncated response is
  not recovered). In-cluster backends are unaffected (single small A records).

### 3.7 MCP protocol revision (2026-07-28) and era negotiation

The MCP servers and clients run the **v2 SDK** —
`@modelcontextprotocol/server`, `/client` and `/node`, which replaced the single
`@modelcontextprotocol/sdk` package. The wire protocol is revision **2026-07-28**,
whose relevant change here is that it **removes sessions**: no `initialize`
handshake, no `Mcp-Session-Id`, and a per-request `_meta` envelope instead. A
client opens with a `server/discover` probe and every subsequent request carries
`MCP-Protocol-Version`, `Mcp-Method` and — on `tools/call` — `Mcp-Name: <tool>`.

**Serving.** Each MCP server builds one `createMcpHandler(factory, { legacy:
'reject' })` and mounts it through `toNodeHandler`. The factory runs **once per
HTTP request** and is handed the caller's `AuthInfo`, which is where the
per-request `subject_token` comes from — nothing is shared between requests, so a
token can never outlive the exchange it was minted for.

**Authentication seam.** The SDK deliberately never reads credentials from
headers; it takes them as pass-through `AuthInfo` on `req.auth`. `authMiddleware`
therefore publishes the validated bearer (and, for mcp-ops, the caller's `roles`,
which the `set_deployment_image` gate needs) there after its own checks pass. The
authorization model is unchanged by the migration — scope, `act`-chain and step-up
are all still enforced in the middleware, ahead of any MCP dispatch.

**No 2025 fallback — and the absence is load-bearing.** Servers reject 2025-era
callers and clients pin `versionNegotiation: { mode: { pin: '2026-07-28' } }`. This
is not housekeeping: a 2025 hop carries **no `Mcp-Name` header**, and the gateway's
per-tool authorization rules key on exactly that header. A silent downgrade would
therefore not merely lose features, it would open an authorization gap — the tool
name the gateway is meant to gate on would simply cease to exist, while every call
kept succeeding. Pinning converts that into a loud connect failure.

During the migration both sides *did* run permissive (`legacy: 'stateless'` +
`mode: 'auto'`), because agentgateway sat in the middle and its support was
unverified; a gateway that only spoke 2025 had to degrade the hop rather than break
it. Once v1.4.1 was confirmed to negotiate 2026-07-28 on both tiers, the permissive
setting became pure downside and was removed. The lesson worth keeping: *a
compatibility fallback that silently disables an authorization input is a
vulnerability, not a courtesy.*

`make smoke-mcp-protocol` (`scripts/smoke-mcp-protocol.sh`) is the only check that
observes the revision negotiated *end to end*, through the gateway, with the real
v2 client — it hard-fails on anything but 2026-07-28 and re-checks tier filtering
and cross-tier denial. Because the servers' own support is pinned by
`apps/mcp-*/tests/mcp-http.test.ts`, a mismatch there indicts the gateway rather
than the origin. Note this also binds **external** clients: MCP Inspector
(`make inspect-obs`/`inspect-ops`) must speak 2026-07-28 or it is refused at
connect.

**Response caching.** Revision 2026-07-28 adds cacheable results (`ttlMs` /
`cacheScope`). It is inert here: the client default TTL is `0`, so nothing is served
from cache unless a server sends an explicit hint, and `tools/call` is never
cacheable at all. `tools/list` *is* cacheable and *is* identity-dependent in this
topology (the gateway filters it per tier), so `openMcpToolset` sets
`cachePartition` to the token's `sub` — belt-and-braces, to keep the identity
boundary correct if a shared cache store or a server-side hint is ever introduced.

---

## 4. Configuration model

Configuration is **all environment variables** (12-factor); each service has a
`config.ts` that reads + defaults them. There is no config file baked into images.

Representative variables (see `k8s/workloads/*.yaml` for the authoritative set):

| Variable | Used by | Meaning |
|---|---|---|
| `CURITY_ISSUER` | all | OIDC issuer (`…/oauth/v2/oauth-anonymous`) |
| `CURITY_JWKS_URI` | all validators | JWKS endpoint for verification |
| `CURITY_TOKEN_ENDPOINT` | exchange clients | `…/oauth/v2/oauth-token` |
| `*_AUDIENCE` / `MCP_AUDIENCE` / `API_AUDIENCE` | validators | the audience this server accepts |
| `REQUIRED_SCOPES` | resource servers | scope gate |
| `REQUIRED_ACR` | `mcp-ops`, `ops-api` | step-up requirement (`mfa`) |
| `<DOWNSTREAM>_URL` / `_AUDIENCE` / `_SCOPE` | exchange clients | the next hop's address, exchange audience, requested scope |
| `AGENT_CLIENT_ID` + `CURITY_AGENT_PRIVATE_KEY_PEM` | the two agents | CIMD client_id URL + RSA key for `private_key_jwt` |
| `*_CLIENT_ID` + secret | MCP exchange clients | `client_secret_basic` credentials |
| `LLM_PROVIDER` / `LLM_MODEL` + `LLM_GATEWAY_URL` / `_AUDIENCE` / `_SCOPE` | the two agents | LLM backend selection (`gateway` default → agentgateway's `/llm` route, `aud=llm-gateway`, `scope=llm:invoke`; `anthropic`/`ollama` alternatives). The agents hold no Azure credential. |
| `AZURE_OPENAI_API_KEY` / `AZURE_RESOURCE_NAME` | agentgateway only (`agentgateway-llm` Secret, ns `mcp`) | the only Azure OpenAI credential in the system — never present on the agent pods |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`, `SPIFFE_SVID_PATH` | all | tracing + workload-identity attribute |

**Secrets are never inline in workload manifests.** `kubectl apply` is idempotent
by desired state, so re-applying a Deployment that embeds a Secret would clobber
real values. All credentials are seeded out-of-band via `make seed-*`
(see [`demo.md`](demo.md)) — including the Azure OpenAI key, which lives solely
in the `agentgateway-llm` Secret (`make seed-llm-secret`, folded into
`make seed-secrets`).

---

## 5. Deployment model

- **Images.** Eight app images built from a shared monorepo build context (the
  `Dockerfile`s `COPY` the workspace and `pnpm install` once). `make images`
  builds all eight — the seven services plus `exchange-shim` — and `kind load`s
  them. `.dockerignore` excludes host
  `node_modules` (pnpm host-absolute symlinks otherwise break the container build).
- **Manifests.** Plain YAML under `k8s/workloads/`. Each workload = Deployment +
  Service + ServiceAccount + a `spiffe-helper` sidecar + the SVID/CSI volumes.
  `make apply` applies Curity, the prod namespace, all workloads (including the
  agentgateway), the `ClusterSPIFFEID` CRs, the edge gateway routes, and the
  observability config, then runs `make routing`.
- **MCP front door (agentgateway).** `k8s/workloads/agentgateway-config.yaml`
  deploys the standalone **agentgateway** in the `mcp` namespace with its co-located
  `exchange-shim` sidecar — the MCP front door for both MCP servers (see §3.5). It
  replaces the former Istio ambient waypoint (`k8s/istio/mcp-l7-authz.yaml`, now
  deleted); `mcp-ops`/`mcp-observability` no longer carry `istio.io/use-waypoint`,
  and the MCP authz path no longer needs the Kubernetes Gateway API CRDs /
  `istio-waypoint` GatewayClass. Fine-grained `act`-chain + step-up stay in the
  resource servers.
- **Platform via Helm.** SPIRE (hardened chart, three namespaces), Istio Ambient
  (base/istiod/cni/ztunnel + gateway), Tempo, and Grafana — all driven
  by `make platform`.
- **Post-deploy routing.** `scripts/cluster-routing.sh` patches each app pod with
  a `hostAlias` for `curity.localtest.me` → the **istio-ingress** ClusterIP and
  mounts the mkcert root CA (pods can't reach the public `localtest.me` loopback,
  and must trust the gateway cert to fetch JWKS). It also gives the **Curity** pod
  a hostAlias for `copilot`/`specialist.localtest.me` so Curity can dereference the
  agents' CIMD documents. Curity trusts those hosts' TLS via the mkcert CA embedded
  in its config server-truststore (`make curity-truststore`, run by `make apply`) —
  not `NODE_EXTRA_CA_CERTS`, which only reaches the Node app pods.

---

## 6. Integration points

| Integration | Mechanism | Refresh trigger |
|---|---|---|
| **SPIRE → Curity** (actor trust) | Procedure fetches SPIRE's JWKS at runtime from the OIDC Discovery Provider | No manual step — keys are fetched per `kid` and refetched on a cache miss, so SPIRE key rotation self-heals. |
| **Procedure → Curity config** | `embed-curity-procedures.sh` Base64-injects the JS into the configmap | `make curity-procedures` (run automatically by `make apply`) |
| **mkcert CA → Curity truststore** | `embed-mkcert-ca.sh` embeds the mkcert root CA (with its real key `<size>`) into the configmap's `<server-truststore>` | `make curity-truststore` (run by `make apply`); machine-specific, re-run after `make certs` |
| **Curity → agent CIMD docs** | Curity dereferences each agent's `client_id` URL (metadata + JWKS) via the `cimd-fetch` http-client over the gateway | per token exchange (no manual refresh) |
| **Edge gateway → Curity** | re-encrypt upstream with `insecureSkipVerify` (Curity's pod cert is self-signed) | static |

---

## 7. Key implementation decisions

- **Curity is the sole issuer.** Every token — user and exchanged — comes from
  Curity. No component mints its own.
- **SPIFFE as `actor_token`, not as transport.** SPIRE JWT-SVIDs are
  application-layer OAuth credentials; Istio mTLS is the separate transport
  plane. Two identity systems, two layers — but **one shared root CA**: istiod's
  signing cert (Istio plug-in CA `cacerts`) and SPIRE's server CA (disk
  `UpstreamAuthority`) are both intermediates under a single cluster root, so all
  X.509 chains to one anchor. The roots are generated locally and seeded
  out-of-band (`make gen-ca` / `seed-istio-ca` / `seed-spire-ca`); the root key is
  never pushed to the cluster. (Direct SPIRE→ztunnel issuance needs enterprise
  Istio; shared-root is the OSS equivalent.)
- **Thin MCP servers + backend resource servers.** MCP servers hold no cluster
  credentials; only `obs-api`/`ops-api` do, behind minimal RBAC. This is the
  third OBO hop and keeps the blast radius of a compromised MCP small.
- **Standard `acr` claim, written procedurally.** Curity rejects a custom claim
  *definition* named `acr` (reserved), but a token procedure can set
  `accessTokenData.acr` / `tokenData.acr` directly. The auth-code procedure
  (`acr-passthrough`) sets it at login; the exchange procedure re-emits it on
  every hop — so the standard OIDC claim flows end-to-end with no custom claim.
- **Fetch the SPIRE JWKS at runtime** (rather than embedding a snapshot) — the
  token-exchange procedure runs on Nashorn and reaches the SPIRE OIDC Discovery
  Provider over an in-cluster hop (`httpsGet()`, using Java interop for TLS with
  the provider's own name), caches the jose4j resolver across invocations, and
  refetches on an unknown `kid`. So a fresh cluster or a SPIRE key rotation
  self-heals with no manual snapshot step (the earlier `make spire-jwks-snapshot`
  tooling is gone).
- **A2A step-up is message-encoded** because the A2A SDK swallows executor
  throws; the structured 401 challenge rides in the task message instead.
- **No external policy engine (OPA/Cedar).** Authorization is expressed in
  Curity claims/procedure + JWT claim checks at each resource server.

### Descoped / deferred

- **RFC 9396 RAR** — Curity supports `authorization_details` only for Verifiable
  Credential Issuance; the stock authorize endpoint rejects general RAR before a
  token procedure runs. The originally-planned delegated change-ticket beat is
  therefore not implemented.
- **RFC 8705 cert-bound tokens** and **DPoP** — tracked follow-ons; bearer +
  mesh mTLS is the current posture.
- **Real observability data** — `mcp-observability`/`obs-api` read live pods from
  `prod` via Kubernetes RBAC; there is no canned-fixture read tier.

---

## 8. Operational considerations

- **Cluster recreation invalidates ClusterIPs** → re-run `make routing`. SPIRE
  key rotation is handled automatically — the procedure refetches SPIRE's JWKS
  on an unknown kid.
- **`kubectl rollout restart deploy/curity` wipes the in-memory HSQLDB** → users
  (alice/bob + TOTP) must be re-seeded per [`curity-seed.md`](curity-seed.md).
- **Tempo retention is 30 minutes** (ephemeral demo storage) — query traces
  within ~25 minutes of driving the demo, or empty TraceQL results will look
  like a broken pipeline when it's just expiry.
- **Health probes are unauthenticated** (`/healthz`, `/api/health`); the
  Collector drops their spans via a `filter/health` processor so they don't
  swamp the trace view.
- **Testing.** Each package/app ships vitest unit tests (`*.test.ts`); the
  end-to-end auth behavior is covered by `make smoke` (OBO, A2A, step-up +
  role-denial, and — via `make smoke-llm`, folded into the `smoke` aggregate —
  the LLM egress: a positive `aud=llm-gateway` chat completion, a negative
  denial of an `aud=mcp-gateway` caller at the gateway, and an assertion that
  `AZURE_OPENAI_API_KEY` is absent from the agent pods). `pnpm turbo run build
  typecheck test` runs the full check.

---

## See also

- [`architecture.md`](architecture.md) — system overview, topology, trust model.
- [`demo.md`](demo.md) — runbook + presenter script.
