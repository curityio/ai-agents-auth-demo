# Spec-shaped MCP clients and challenge completeness — design

Date: 2026-09-24
Branch: `feat/mcp-spec-shaped-clients`
Status: approved design, awaiting implementation plan

## 1. Goal

Bring the demo into line with the MCP authorization specification (revision
2026-07-28) everywhere except RFC 8707, which is deferred until Curity accepts
the `resource` parameter. Three gaps were measured against the spec on
2026-09-24:

1. The MCP servers' no-token and invalid-token 401 challenges carry no
   `resource_metadata` and no `scope`, and the invalid-token path emits
   non-RFC 6750 error codes (`expired_token`, `invalid_issuer`).
2. agentgateway's own 401 advertises
   `https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/...`,
   a URL that is neither routed at the edge nor served by the gateway (its
   routes match only the `/observability/mcp` and `/ops/mcp` prefixes).
3. The agents are not spec-shaped MCP clients. They do no discovery: the
   authorization server, token endpoint, scope and RFC 9728 document location are
   all static environment variables.

Success looks like this:

- An unauthenticated request to any MCP surface (origin servers or gateway)
  returns a 401 whose `WWW-Authenticate` names a reachable RFC 9728 document.
- Both agents learn the authorization server, token endpoint, scope and CIMD
  support from that chain at runtime, fail closed on any mismatch, and keep only
  the MCP server URL and the RFC 8693 `audience` as static per-server inputs.
- The RFC 8693 exchange itself, with its OBO log, `DENY` logging and span, is
  untouched.
- `make smoke` gains a discovery walk that proves the chain end to end.

## 2. Non-goals

- RFC 8707 `resource` parameter on token requests (Curity does not support it
  yet). The `audience` parameter stays and keeps its logical-name values.
- Changing token audiences from logical names (`mcp-gateway`) to resource URIs.
  That is the natural follow-up once RFC 8707 lands and would touch the Curity
  procedure, the gateway `audiences`, the shim and every smoke script.
- Deriving the agents' *inbound* validation inputs (`CURITY_ISSUER`,
  `CURITY_JWKS_URI`) from discovery. An agent is also a resource server for the
  token it receives and must be told whom it trusts. Deriving `jwks_uri` from
  the issuer's metadata is a possible follow-up.
- Web UI changes. The identity panels and ledger are untouched.
- The MCP spec's scope-based step-up (403 `insufficient_scope` → scope-union
  re-authorization). The demo's step-up is RFC 9470 and stays so, as
  `docs/design.md` already documents.
- Replacing `exchangeToken` with the SDK's `auth()` orchestrator (approach 2 in
  the brainstorm). Rejected because the token POST would leave
  `packages/auth-curity` and lose the OBO log and `DENY` exit that fact #31
  relies on.

## 3. Architecture

```
agent ──(1) POST, no token──▶ https://mcp-gateway.localtest.me/ops/mcp
      ◀─(2) 401 WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/ops/mcp"
      ──(3) GET resource_metadata URL──▶ gateway (served by mcpAuthentication)
      ◀─(4) { resource, authorization_servers:[curity issuer], scopes_supported:[ops:write], acr_values_supported:[mfa] }
      ──(5) GET https://curity.localtest.me/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous
      ◀─(6) { issuer, token_endpoint, client_id_metadata_document_supported:true, … }   (issuer-echo checked)
      ──(7) RFC 8693 exchange at token_endpoint (unchanged exchangeToken; actor=SVID; audience=mcp-gateway; scope from (2)/(4))
      ──(8) POST with Bearer ──▶ gateway ──▶ shim OBO hop ──▶ mcp-ops … (unchanged)
```

Steps 1 to 6 are new and live in one module in `packages/agent-runtime`. Step 7
is today's code with two inputs (token endpoint, scope) supplied by step 6 and
steps 2/4 instead of by environment variables. Step 8 is unchanged.

The agents reach the gateway through the Istio edge at a public HTTPS host, so
the URL the client uses is byte-identical to the `resource` the PRM advertises.
The gateway's `/llm` route and the `/last-token` passthroughs keep their
in-cluster URLs; only MCP traffic moves to the public host.

## 4. Components

### 4.1 `packages/agent-runtime/src/mcp-oauth-client.ts` (new)

Built on the v2 SDK's exported helpers, never on hand-rolled header parsing:
`extractWWWAuthenticateParams`, `discoverOAuthProtectedResourceMetadata`,
`discoverAuthorizationServerMetadata`, `assertSecureTokenEndpoint`.

```ts
export interface McpAuthDiscovery {
  serverUrl: string;                 // as configured, trailing slash stripped
  resourceMetadataUrl: string;       // where the PRM was fetched from
  resourceMetadata: OAuthProtectedResourceMetadata & { acr_values_supported?: string[] };
  authorizationServer: string;       // authorization_servers[0]
  authorizationServerMetadata: AuthorizationServerMetadata;
  tokenEndpoint: string;
  scope: string;                     // selected per §4.1.2
  discoveredAt: number;
}

export async function discoverMcpAuthorization(
  serverUrl: string,
  opts?: { fetchImpl?: typeof fetch; challenge?: Response; force?: boolean },
): Promise<McpAuthDiscovery>;

export interface McpAuthProvider extends AuthProvider /* SDK: token(), onUnauthorized() */ {
  acquire(): Promise<string>;        // discovery (cached) + exchange
  discovery(): McpAuthDiscovery | undefined;
}

export function createMcpAuthProvider(opts: {
  serverUrl: string;
  exchange: (d: { tokenEndpoint: string; scope: string; discovery: McpAuthDiscovery }) => Promise<string>;
  fetchImpl?: typeof fetch;
}): McpAuthProvider;
```

#### 4.1.1 Discovery sequence

1. If a cached entry for `serverUrl` exists, is younger than 10 minutes and
   `force` is not set, return it.
2. Otherwise, unless a `challenge` response was handed in, send one
   unauthenticated `POST serverUrl` with a minimal JSON-RPC body
   (`{"jsonrpc":"2.0","id":0,"method":"ping"}`) and `accept:
   application/json, text/event-stream`. Anything but a 401 is an error
   (`discovery_failed`). This is the spec's step 1; the gateway's
   `mcpAuthentication` answers before body parsing, so the body content is
   irrelevant.
3. Parse the 401 with `extractWWWAuthenticateParams`. If `resourceMetadataUrl`
   is present, fetch the PRM from it. Otherwise call
   `discoverOAuthProtectedResourceMetadata(serverUrl)`, which probes the
   path-based well-known URL and then the root, in the spec's order.
4. Validate the PRM: `resource`, after stripping one trailing slash, must equal
   `serverUrl` after the same normalization. Mismatch → `resource_mismatch`.
   `authorization_servers` must be a non-empty array; the first entry is used.
5. Call `discoverAuthorizationServerMetadata(authorizationServer)`. The SDK
   tries the RFC 8414 path-insertion form first, then OIDC discovery, and
   rejects a document whose `issuer` does not echo the URL. `undefined` (no
   document) → `discovery_failed`.
6. Require `client_id_metadata_document_supported === true`; the agents are
   CIMD ephemeral clients and have no other registration path. Missing or false
   → `cimd_unsupported`.
7. `token_endpoint` must be present and pass `assertSecureTokenEndpoint`.
8. Select scope (§4.1.2). Cache and return.

`grant_types_supported` is logged but not enforced: Curity's metadata omits the
token-exchange grant even though it is enabled (observed 2026-09-24).

#### 4.1.2 Scope selection

The spec's order, with no configured default:

1. `scope` from the 401 challenge, if present.
2. Otherwise `scopes_supported` from the PRM, space-joined.
3. Otherwise fail with `scope_unavailable`. A client that cannot learn what to
   ask for must not guess.

#### 4.1.3 Provider behaviour

- `acquire()`: `discoverMcpAuthorization(serverUrl)` then `exchange(...)`. Stores
  the token; returns it. Errors propagate unchanged (`CurityAuthError` from the
  exchange keeps its code so the specialist's `invalid_scope` → step-up mapping
  still works).
- `token()`: returns the stored token, or `undefined` if `acquire()` has not run.
- `onUnauthorized({ response })`: if the challenge's `error` is
  `insufficient_user_authentication`, throw a `CurityAuthError` with code
  `step_up_required` carrying the raw `WWW-Authenticate` value in its message,
  and do not exchange or retry. This is defence in depth: the specialist's
  intercepting fetch runs in front of the transport and converts the same 401
  into a `StepUpRequiredError` first, so this branch is only reachable if that
  wrapper is absent. Otherwise re-run discovery with `force: true` and the
  received response as the `challenge`, exchange again, store the new token.
  The SDK transport then retries the request once and surfaces a second 401 as
  an error.
- Discovery emits one `DISCOVER` OBO log line on a cold or forced run (§4.5).
  Cache hits are silent.

The discovery cache is process-global and keyed by `serverUrl`; a provider
instance is created per toolset open (tokens are per subject and must not be
shared across users). The cache is exported for tests via `_resetDiscoveryCache`.

### 4.2 `openMcpToolset` (changed)

`bearerToken: string` becomes `authProvider: AuthProvider`. The transport is
built with `{ authProvider, fetch: opts.fetchImpl }` and no static
`authorization` header; the SDK attaches the bearer per request from
`token()`. The OBO `CALL` line still prints the token summary, taken from
`authProvider.token()` after `client.connect()`. `cachePartition` is still the
token's `sub`.

### 4.3 Authorization-server metadata for non-MCP hops

`packages/agent-runtime/src/authorization-server.ts` (new, small):

```ts
export async function resolveAuthorizationServer(issuer: string, opts?): Promise<{ tokenEndpoint: string; metadata: AuthorizationServerMetadata }>;
```

Same SDK helper, same 10-minute cache, same issuer-echo and CIMD checks as
§4.1.1 steps 5 to 7. Used by the exchanges that have no MCP server to discover
from: both agents' `llm-token.ts` (audience `llm-gateway`) and the copilot's
`specialist-client.ts` (audience `agent-specialist`). This is what lets
`CURITY_TOKEN_ENDPOINT` go away without leaving two sources of truth.

### 4.4 Agents

**Config.** Removed from both `config.ts` and both manifests:
`CURITY_TOKEN_ENDPOINT`, `MCP_OBSERVABILITY_SCOPE`, `MCP_OPS_SCOPE`,
`MCP_OPS_RESOURCE_METADATA_URL`, `MCP_OPS_METADATA_URL`. Kept:
`CURITY_ISSUER`, `CURITY_JWKS_URI` (inbound validation), `AGENT_CLIENT_ID`,
`CURITY_AGENT_PRIVATE_KEY_PEM`, `MCP_*_URL`, `MCP_*_AUDIENCE`, the LLM and
specialist audience/scope values. `MCP_OBSERVABILITY_URL` and `MCP_OPS_URL`
change to `https://mcp-gateway.localtest.me/observability/mcp` and
`https://mcp-gateway.localtest.me/ops/mcp`.

**Token helpers.** `obtainMcpToken` (copilot), `obtainOpsToken` and
`obtainObsToken` (specialist) gain `tokenEndpoint` and `scope` parameters and
drop their reads of `cfg.curityTokenEndpoint` / `cfg.*Scope`. The
`private_key_jwt` `assertionAudience` is the discovered token endpoint, as
today. The copilot's `TokenExchangeCache` key uses the discovered scope.
`recordLastExchange` semantics are unchanged (probes still pass `false`).

**Call sites.** Where an agent currently calls `obtainXToken` then
`openMcpToolset({ bearerToken })`, it now builds
`createMcpAuthProvider({ serverUrl, exchange })`, calls `await provider.acquire()`
at the same point in the flow (so the specialist's ops exchange still runs
before the `acr` pre-check and before any toolset opens), then
`openMcpToolset({ authProvider: provider, ... })`. The copilot's existing
"invalidate cache and retry once on MCP 401" logic is removed; the provider's
`onUnauthorized` covers it.

**Specialist step-up.** `stepUpFromMetadata` takes the discovery for the ops
server (`provider.discovery()`, or a fresh `discoverMcpAuthorization` if the
exchange failed before one existed) and builds the `StepUpRequiredError` from
`resourceMetadata.acr_values_supported[0]`, the selected scope and
`resourceMetadataUrl`. `fetchResourceMetadata` and its cache are deleted. The
`Config.requiredAcr` fallback stays for the deterministic pre-check.

**`/tools` probes.** Both tools routes use the same provider path with
`recordLastExchange: false` inside their `exchange` callbacks, so the
contract tests that pin "probes are not flows" (fact #34) keep passing.

### 4.5 OBO log

`OboKind` gains `'DISCOVER'`. Emitted once per cold or forced discovery:

```
┌─ 2026-09-24T05:37:15.123Z INFO [agent-specialist] DISCOVER → https://mcp-gateway.localtest.me/ops/mcp
│ resource_metadata : https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp
│ resource          : https://mcp-gateway.localtest.me/ops/mcp
│ authorization srv : https://curity.localtest.me/oauth/v2/oauth-anonymous
│ token endpoint    : https://curity.localtest.me/oauth/v2/oauth-token
│ scope selected    : ops:write (from scopes_supported)
│ cimd supported    : true
│ trace : <traceId> ▸ <spanId>
└─
```

`formatOboLog` stays pure; the new kind is a string variant only.

### 4.6 MCP servers (`apps/mcp-observability`, `apps/mcp-ops`)

`auth-middleware.ts`, three edits each, order of checks unchanged:

| Case | Before | After |
|---|---|---|
| No `Bearer` | `Bearer realm="<aud>"` | `Bearer realm="<aud>", scope="<requiredScopes>", resource_metadata="<cfg.resourceMetadataUrl>"` |
| `verifyJwt` throws `CurityAuthError` | `Bearer error="<code>", error_description="<msg>"` | `Bearer realm="<aud>", error="invalid_token", error_description="<code>: <msg>", resource_metadata="<cfg.resourceMetadataUrl>"` |
| Missing `act.sub` (obs) | `Bearer error="invalid_token", …` | adds `resource_metadata` |

The JSON body keeps `error: <code>` so existing callers that read the body see
the specific code; only the header is normalized to RFC 6750. The 403
`insufficient_scope` and the RFC 9470 401 already carry `resource_metadata` and
are unchanged. `ops-api`'s challenge is unchanged (not an MCP surface).

### 4.7 agentgateway config (`k8s/workloads/agentgateway-config.yaml`)

- Both MCP routes add a second match:
  `- path: { exact: /.well-known/oauth-protected-resource/observability/mcp }`
  and the `/ops/mcp` equivalent. The gateway's `apply_token_validation` skips
  authn for well-known paths and `protected_resource_metadata` serves the
  document, but only once the request matches a route (verified in v1.4.1
  `mcp/auth.rs` and `examples/mcp-authentication/config.yaml`).
- Ops route `resourceMetadata` gains `acrValuesSupported: [mfa]`. Extra keys are
  flattened into the document and converted to snake_case
  (`types/agent.rs` `ResourceMetadata::to_rfc_json`).
- `mcpAuthorization` on the ops route must not reject the well-known GET. The
  well-known request carries no JWT and never reaches the MCP layer (it is
  answered in `apply_token_validation`'s early return), so no rule change is
  expected; the smoke test in §6 proves it.
- The sentinel-delimited LLM block is untouched; `make apply` re-renders it.

### 4.8 Edge, certificates, routing

- `Makefile`: `HOST_MCP_GATEWAY ?= mcp-gateway.localtest.me`; the endpoints
  printout lists both gateway PRM URLs.
- `scripts/mkcert-bootstrap.sh`: add the host.
- `scripts/apply-tls-secrets.sh`: `mcp-gateway.localtest.me|istio-ingress|mcp-gateway-tls`.
- `k8s/istio/gateway-edge.yaml`: an HTTPS server for the host with that
  credential, and a VirtualService routing all paths to
  `agentgateway.mcp.svc.cluster.local:8080`.
- `scripts/cluster-routing.sh`: `RESOURCE_HOSTS` gains `mcp-gateway.localtest.me`
  (web fetches the PRM from the browser challenge), and `extra_hosts_for` returns
  it for `agents/agent-copilot` and `agents/agent-specialist` (they now call the
  gateway by that name). Both already receive the mkcert CA mount for Curity.
  `verify_routing` covers the new aliases, so `make routing-check` fails on
  drift.

### 4.9 Docs

- `CLAUDE.md`: fact #21 (gateway PRM now served and reachable; well-known route
  matches are load-bearing), fact #34 (specialist step-up reads the gateway PRM),
  new fact for the discovery module and the removed env vars, `make
  smoke-mcp-discovery` in the command list.
- `docs/design.md`: new subsection under the agents for the discovery flow and
  the fail-closed rules; config table updated.
- `docs/architecture.md`: standards table adds RFC 8414 and client-side
  RFC 9728; topology note that MCP traffic enters the gateway via the edge.
- `docs/demo.md`: endpoints list and troubleshooting entry for a dangling
  `resource_metadata` (routing-check).

## 5. Error handling

All failures are loud and specific; nothing degrades to a guessed default.

| Condition | Where | Result |
|---|---|---|
| Probe returns non-401 | discovery step 2 | `CurityAuthError('discovery_failed')`, agent answers 502 `mcp_unavailable` |
| PRM fetch fails or `resource` ≠ server URL | steps 3–4 | `resource_mismatch` / `discovery_failed`, 502 |
| AS metadata missing or issuer echo mismatch | step 5 | SDK `IssuerMismatchError` or `discovery_failed`, 502 |
| `client_id_metadata_document_supported` not true | step 6 | `cimd_unsupported`, 502 |
| Non-HTTPS token endpoint | step 7 | SDK `InsecureTokenEndpointError`, 502 |
| No scope from challenge or PRM | step 8 | `scope_unavailable`, 502 |
| Exchange refused | `exchange` callback | unchanged: `CurityAuthError` with Curity's code; `invalid_scope` still maps to the RFC 9470 step-up in the specialist |
| 401 after re-acquire | transport | SDK error surfaces; copilot answers 502 `mcp_unavailable` as today |
| RFC 9470 401 | intercepting fetch, else `onUnauthorized` | `StepUpRequiredError`; never retried |

The `DENY` log rule from fact #31 is preserved: discovery failures are logged
by the single `catch` in `acquire()`, not at each throw site.

## 6. Testing

**Unit (vitest, fake `fetch`):**

- `mcp-oauth-client.test.ts`: header path; well-known fallback when the 401
  has no `resource_metadata`; `resource` mismatch throws; AS issuer mismatch
  throws (SDK); CIMD flag absent throws; scope from challenge beats
  `scopes_supported`; neither → throws; cache hit makes no HTTP calls; `force`
  refetches; `onUnauthorized` re-acquires once and rethrows an
  `insufficient_user_authentication` challenge without exchanging.
- `authorization-server.test.ts`: happy path, issuer mismatch, cache.
- `mcp-toolset.test.ts`: transport receives `authProvider`; no static header.
- Middleware tests in both MCP servers: the three headers of §4.6, parsed with
  a small helper rather than string-matched, and the body still carries the
  specific code.
- Agent tests: config loads without the removed env vars; `obtainMcpToken` /
  `obtainOpsToken` use the supplied endpoint and scope; `stepUpFromMetadata`
  reads `acr_values_supported` from discovery; the `/tools` probe contract
  tests still see no recorded exchange.
- `obo-log` rendering test for `DISCOVER`.

**Shell contract (`make test-scripts`):** the rendered gateway config contains
both well-known matches and `acrValuesSupported`; `apply-tls-secrets.sh` and
`cluster-routing.sh` list the new host.

**Smoke (`scripts/smoke-mcp-discovery.sh`, wired into `make smoke`):** against
the live cluster, for each of the two gateway routes: unauthenticated POST →
401 with `resource_metadata`; GET it → 200, `resource` equals the route URL,
`authorization_servers[0]` present, ops route has `acr_values_supported`; GET
the RFC 8414 path-insertion URL → `issuer` echoes,
`client_id_metadata_document_supported` is `true`, `token_endpoint` is HTTPS.
Then both origin servers: unauthenticated POST → 401 with `resource_metadata`
and `scope`; a garbage bearer → 401 with `error="invalid_token"`. Finally the
existing `smoke-obo` and `smoke-a2a` runs prove the agents still complete a
read and a restart through the new URLs.

**Manual:** `kubectl logs` on an agent shows exactly one `DISCOVER` block per
server after a restart, then `EXCHANGE`/`CALL` as before.

## 7. Implementation notes and risks

- The agents now traverse the Istio edge to reach the gateway. The ingress is
  the same one Curity and the CIMD hosts are reached through, so the hostAlias
  and CA mechanics are proven. Traces gain an ingress span in front of the
  gateway span; `docs/demo.md`'s span walkthrough should mention it.
- `kind load` does not restart pods (memory: kind-load-needs-rollout-restart).
  After `make images`, rollout-restart both agents and both MCP servers, and
  `make apply` for the gateway config, edge and routing.
- Existing smoke scripts keep `GATEWAY_BASE` in-cluster and are unaffected.
- The zod-3/zod-4 split is untouched; the new module imports only the SDK
  client package, already a dependency of `agent-runtime`.
- Nothing is committed on this branch until the user asks.

## 8. Follow-ups (not in this change)

1. RFC 8707 `resource` parameter once Curity supports it, then audiences as
   resource URIs.
2. Derive `CURITY_JWKS_URI` from the issuer's metadata (`jwks_uri`).
3. Surface `DISCOVER` in the web UI's ledger.
4. `CLAUDE.md` points at `docs/archive/`, which does not exist; the material is
   under `docs/superpowers/`.
