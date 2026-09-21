# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## What this repo is

A complete, runnable demo of **AI agent authentication and authorization** on
Kubernetes (KIND). A DevOps/SRE copilot reads observability data and restarts
workloads on a user's behalf; every hop is authenticated (SPIFFE), least-
privilege (RFC 8693 token exchange with scope/audience narrowing), MFA-gated for
privileged actions (RFC 9470 step-up), and traceable (OTel → Tempo → Grafana).

**Read the canonical docs before proposing structural changes:**

- [`docs/architecture.md`](docs/architecture.md) — system overview, topology, the
  two OBO chains, trust model, security boundaries.
- [`docs/design.md`](docs/design.md) — module breakdown, interfaces, workflows,
  configuration & deployment model, key decisions.
- [`docs/demo.md`](docs/demo.md) — runbook + presenter script + troubleshooting.

The system was built in pedagogical phases (1 → 6). Those notes are now
historical and now archived under [`docs/archive/`](docs/archive/) (phase notes,
superpowers specs, and the original implementation plan) — a build-log, not the
current spec. The canonical docs above supersede them. Don't reintroduce
"Phase N" framing into code or current docs.

## Architecture you should know before touching code

```
Browser ─https─▶ web (Next.js BFF) ─user token─▶ agent-copilot ─┬─ MCP ─▶ agentgateway ─▶ mcp-observability ─▶ obs-api ─▶ K8s API (prod)
                                                                └─ A2A ─▶ agent-specialist ─┬─ MCP ─▶ agentgateway ─▶ mcp-ops          ─▶ ops-api ─▶ K8s API (prod)
                                                                  (LLM, cross-tier)         └─ MCP ─▶ agentgateway ─▶ mcp-observability ─▶ obs-api ─▶ K8s API (prod)
        agent-copilot / agent-specialist ─ LLM ─▶ agentgateway (/llm; aud=llm-gateway, require llm:invoke; backendAuth.key=Azure key) ─▶ Azure OpenAI
        agentgateway = MCP front door (aud=mcp-gateway; coarse per-tier scope authz + tools/list filter; extAuthz→exchange-shim OBO hop)
        (the set_deployment_image=sre role split is authoritative at mcp-ops; the gateway's HTTP-layer `authorization` rule is a first line only — see #27)
                          every agent/MCP/LLM hop ⇄ Curity (RFC 8693 exchange; SPIFFE JWT-SVID as actor_token)
```

- **Curity is the sole token issuer.** Every token — user and exchanged — comes
  from Curity. Validate JWTs against Curity's JWKS; never mint tokens elsewhere.
- **Web app is a BFF.** Browser holds an httpOnly cookie; the access token never
  leaves the server.
- **The web UI's identity panels are fed by debug routes** — `/spiffe-id`,
  `/last-token` and `/tools` on the workloads; `/api/obo-chain`,
  `/api/spiffe-identities?flow=`, `/api/tools` and the `AUTH_DEBUG`-gated
  `/api/inspect` on the BFF. They mint real tokens for display, and the chain view
  has rules that break silently — see fact #34 and `docs/design.md` §2
  *Visibility surfaces* before touching them.
- **Each agent/MCP hop performs an RFC 8693 token exchange**, presenting its
  SPIFFE JWT-SVID as the `actor_token`. Curity narrows scope+audience and nests
  the workload into the token's `act` claim. `packages/auth-curity` owns the
  exchange and *every* "what Curity expects" rule — don't duplicate it.
- **Client authentication is split by tier.** The two agents (`agent-copilot`,
  `agent-specialist`) are **CIMD ephemeral clients** — their `client_id` is an
  HTTPS URL they self-host (`https://{copilot,specialist}.localtest.me/.well-known/oauth-client`)
  that Curity dereferences for a metadata document + JWKS; they authenticate with
  a **`private_key_jwt`** assertion (no shared secret). The MCP servers
  (`mcp-observability`/`mcp-ops`) remain static `client_secret_basic` clients.
  `packages/auth-curity` (`exchange.ts` `clientAuth`, `cimd.ts`) owns both paths.
- **Both agents are LLM agents (Vercel AI SDK).** `agent-copilot` is the
  front-line agent; `agent-specialist` is a privileged **cross-tier LLM agent**
  (NOT a deterministic adapter): it takes a natural-language goal over A2A, holds
  *two* tokens (`ops:write` to `mcp-ops` + `obs:read` to `mcp-observability`),
  and runs a tool-using inspect→act→verify loop. Its authz gates (the `ops:write`
  exchange = role+scope gate, and a deterministic `acr=mfa` step-up pre-check) run
  **outside/before** the LLM loop — see `apps/agent-specialist/src/executor.ts`
  (`runRemediation`). Shared LLM plumbing lives in `packages/agent-runtime`
  (`buildLlm` provider wiring + `openMcpToolset`/`mcpInputSchema` MCP→AI-SDK
  adapter); both agents depend on it (copilot's `llm.ts`/`mcp-client.ts` are thin
  re-exports). Every model call is now routed through agentgateway's `/llm`
  route rather than called directly — see hard-won fact #22; the old
  direct-to-Azure path (`@ai-sdk/azure` in `buildLlm`) is gone. The gateway model is
  built with `@ai-sdk/openai-compatible`, deliberately NOT `@ai-sdk/openai` — see
  fact #30.
- **MCP servers are thin clients.** `mcp-observability`/`mcp-ops` (in the `mcp`
  namespace) validate the caller then re-exchange to a backend resource server
  (`obs-api`/`ops-api`, in the separate `apis` namespace). Only the backend APIs
  hold Kubernetes credentials, behind minimal RBAC in `prod` (obs-api: get/list
  pods + logs **and** get/list deployments; ops-api: patch deployments). obs-api
  accepts **two** actor chains (`expectedActorChains`/`chainMatchesAny`), both of
  which include the gateway: `[mcp-observability, agentgateway, agent-copilot]`
  (copilot reads directly) and
  `[mcp-observability, agentgateway, agent-specialist, agent-copilot]`
  (specialist reads while remediating).
- **Resource servers enforce, in order:** Bearer → JWT valid → required scope →
  `act` present → exact actor-chain (length + per-position SPIFFE-ID regex) →
  (privileged tier) `acr=mfa` step-up. The role gate (`sre` for `ops:write`)
  is enforced by Curity's procedure at exchange time.
- **MCP transport is Streamable HTTP** (`@modelcontextprotocol/{client,server,node}@2`),
  stateless, protocol revision **2026-07-28 only** (no 2025 fallback — the absence is
  load-bearing) — see hard-won fact #26 before touching any MCP wiring.

## Critical hard-won facts (don't relearn these the hard way)

1. **All public hostnames use `*.localtest.me`** (not `*.nip.io`/`127.0.0.1`).
   Curity's RFC 8252 loopback canonicalization normalizes any `127.0.0.1`
   substring to `localhost`, breaking the RFC 9207 `iss` check. `localtest.me`
   is a wildcard resolver to 127.0.0.1 with neither substring.

2. **Auth.js v5's `getToken({req, secret})` needs `secureCookie: true`** behind
   HTTPS — v5 dropped v4's autodetection, so the default `false` silently looks
   up the wrong cookie and returns `null`. We're always on HTTPS via the gateway.

3. **Secrets are NEVER inline next to their Deployment.** `kubectl apply` is
   idempotent by desired state, so re-applying a workload manifest that embeds a
   Secret clobbers real values with placeholders. Use `make seed-*` (out-of-band).

4. **The Curity license is provided out-of-band, never committed.** Put it at
   `./license.json` (gitignored); `make seed-license` (run by `make demo` /
   `make seed-secrets`) creates the `curity-license` secret from it. `make apply`
   no longer installs the license itself. The `<symmetric-key>` in the configmap
   was a deliberate demo-only decision.

5. **Pods can't reach `https://curity.localtest.me` unaided.** `localtest.me` →
   127.0.0.1 publicly, which inside a pod is the pod itself. `scripts/cluster-
   routing.sh` (run by `make apply`/`make routing`) injects a `hostAlias` mapping
   `curity.localtest.me` → the **`istio-ingress`** ClusterIP and mounts the mkcert
   root CA so TLS validates. **Re-run `make routing` if the cluster is recreated**
   (ClusterIPs change). The edge is the Istio gateway — NGINX is no longer used.
   A *partial* routing run is the silent foot-gun: if only some namespaces get
   patched, the unwired backends can't fetch Curity's JWKS and reject
   otherwise-valid tokens as `invalid_token` (empty reason) → the agent surfaces
   `502 mcp_unavailable`. `make routing` now verifies every target afterward and
   fails if any is unwired; `make routing-check` (also folded into `make status`)
   runs the same read-only check to catch drift.

6. **`.dockerignore` is load-bearing.** Without `**/node_modules` in it, host
   `node_modules` (pnpm host-absolute symlinks) gets COPY'd over the container's,
   breaking builds with `Cannot find module 'next/dist/bin/next'`.

7. **`/api/health` is the unauthenticated probe target, NOT `/api/whoami`.**
   Probes carry no session cookie; `/api/whoami` correctly 401s the kubelet.

8. **The SPIRE hardened chart splits across `spire`, `spire-server`, and
   `spire-system`** (with `recommendations.enabled: true`); all must pre-exist.
   `spire-crds` installs as a separate Helm chart before the main `spire` chart.
   `caSubject.country` is required.

9. **`ClusterSPIFFEID.spec.className` must be `spire-spire`** or the controller
   silently skips the CR. The schema has no `jwtIssuer`/`jwtAudiences` — audience
   selection happens at SVID-fetch time in the `spiffe-helper` config.

10. **`spiffe-helper` ≤ 0.11.0 writes SVIDs mode 0600 with no override knob**, so
    the sidecar runs as `runAsUser: 1000` to match the `node` user. Re-check if
    base images change. SVIDs are written to `/run/spiffe/curity-actor.jwt`.

11. **Next.js standalone tracing needs `outputFileTracingRoot`** set to the
    monorepo root to bundle workspace deps (`packages/*`) into `.next/standalone`.

12. **The Istio gateway chart doesn't expose `hostPort`.** For KIND we strategic-
    merge-patch it in via `k8s/istio/hostport-patch.yaml`.

13. **The `acr` claim is written procedurally, not declared.** Curity rejects a
    custom claim *definition* named `acr` (reserved), but a token procedure can set
    `accessTokenData.acr` directly. The auth-code procedure (`acr-passthrough`,
    `k8s/curity/procedures/authorization-code.js`) stamps it at login; the
    exchange procedure re-emits it per hop. Step-up + the `auth.acr` span attribute
    use the standard claim.

14. **The token-exchange procedure fetches SPIRE's JWKS at runtime** from the
    SPIRE OIDC Discovery Provider (`spire-spiffe-oidc-discovery-provider.spire-server`),
    so a fresh cluster or SPIRE key rotation needs **no** manual snapshot — the
    procedure refetches on an unknown `kid`. (Historically this was an embedded
    snapshot refreshed via `make spire-jwks-snapshot`; that tooling is gone.)

15. **`kubectl rollout restart deploy/curity` wipes the in-memory HSQLDB** — re-
    seed alice/bob + TOTP per `docs/curity-seed.md`.

16. **Tempo retention is 30 min and its query API is on `:3200`** (not 3100).
    Empty TraceQL usually means expiry; query within ~25 min of driving the demo.

17. **Curity validates token procedures with Nashorn (ES5.1) at config load** —
    a syntax error fails the whole config (`CDB boot error: ... Expected an operand
    but found )`) and Curity CrashLoops. Nashorn rejects **ES2017 trailing commas in
    function calls/args**, which Prettier's default `trailingComma: "all"` inserts.
    `node --check` won't catch this (Node accepts them). Mitigations in place: a
    `.prettierrc` override pins `k8s/curity/procedures/*.js` to `trailingComma: "none"`.
    Don't format these files with a config that re-adds trailing commas.

18. **One shared root CA spans Istio + SPIRE.** istiod and SPIRE each run an
    *intermediate* CA signed by a single cluster root: istiod via the Istio
    plug-in CA (`cacerts` Secret in `istio-system`, seeded by `make seed-istio-ca`),
    SPIRE via its `disk` `UpstreamAuthority` (`spiffe-upstream-ca` Secret in
    `spire-server`, seeded by `make seed-spire-ca`). The tree is generated by
    `scripts/gen-shared-ca.sh` (`make gen-ca`) into `certs/shared-ca/` (gitignored —
    it holds private keys; the root key never enters the cluster). Both seed
    targets MUST run **before** their Helm install (istiod/SPIRE read the CA at
    boot); `make platform` orders this. Trust domains stay distinct
    (`cluster.local` vs `demo.curity.local`) — only the root is shared. Direct
    SPIRE→ztunnel cert issuance in Ambient is a Solo.io enterprise feature; shared-
    root is the OSS equivalent. **Enabling/rotating the SPIRE UpstreamAuthority
    rotates the SPIRE CA and JWT keys** — the Curity procedure fetches the JWKS
    at runtime, so this needs no manual snapshot/restart.

19. **The two agents are CIMD ephemeral clients (`private_key_jwt`), and that
    touches five places that must agree.** Curity's Client ID Metadata Documents
    feature: the `client_id` IS an HTTPS URL Curity dereferences for a metadata doc
    + JWKS, and the client authenticates with a signed assertion. Hard-won details:
    - **`client_id` is byte-for-byte identical** across the metadata doc, the
      `AGENT_CLIENT_ID` env in `k8s/workloads/agent-*.yaml`, and the `CLIENT_POLICY`
      key in `token-exchange.js` (the procedure keys policy by `getClient().getId()`,
      which returns the URL). Any drift → `invalid_client`.
    - **The `<ephemeral-client>` block needs a mandatory `<client-id-restrictions>`**
      (`<allow-list><domain>*.localtest.me</domain></allow-list>`). There is NO
      `<informational-uris-same-origin>` leaf — adding it CrashLoops Curity at config
      load. `localtest.me` is NOT treated as loopback, so no `<localhost-allowed/>`.
    - **Curity must trust the gateway TLS cert to fetch the metadata.** It uses an
      `<http-client>` (`cimd-fetch`) with `<use-truststore>true</use-truststore>`,
      which reads Curity's **config server-truststore** — NOT `NODE_EXTRA_CA_CERTS`
      (that only reaches the Node app pods). The mkcert root CA is embedded into the
      configmap's `<server-truststore>` by `make curity-truststore`
      (`scripts/embed-mkcert-ca.sh`, sentinel-delimited, machine-specific → re-run
      after `make certs`). `make apply` runs it. The `<server-certificate>` MUST
      declare the cert's real key `<size>` — ConfD validates it and CrashLoops on a
      mismatch (`keystore-element was invalid: Key size … Expected 2048, found 3072`);
      mkcert CAs are typically 3072-bit, so the embed script reads the size from the
      cert rather than assuming the 2048 default.
    - **Curity must resolve the agent hosts.** `*.localtest.me` → 127.0.0.1 = the
      pod itself; `scripts/cluster-routing.sh` now also adds a hostAlias on the
      **curity** deployment for `copilot/specialist.localtest.me` → istio-ingress.
    - **Each agent self-hosts** `GET /.well-known/oauth-client` + `/.well-known/jwks.json`
      (server.ts), deriving its public JWK from the PKCS8 key (`packages/auth-curity`
      `createCimdIdentity`). Keys are seeded by `make seed-agent-key` /
      `seed-specialist-key` (RSA PKCS8 PEM in the `agent-*-curity` Secret under
      `CURITY_AGENT_PRIVATE_KEY_PEM`).

20. **An "infinity" `nofile` limit OOM-kills Curity at boot.** The `kindest/node`
    containerd unit ships `LimitNOFILE=infinity` (1073741816), which every pod
    inherits. Curity's `confd.smp` is Erlang/BEAM, and BEAM sizes its internal
    fd tables to the *soft* nofile limit → it allocates ~11GB RSS at boot and
    trips a node-wide OOM kill (`exitCode 137`, both `confd.smp` and the idsvr
    JVM killed). The surfaced symptom is misleading: `failed to create fsnotify
    watcher: too many open files`, then CrashLoopBackOff stuck just after
    `Starting configuration service`. Diagnose via `dmesg | grep oom` on the
    node (shows `confd.smp ... anon-rss:11222060kB`). `scripts/node-nofile-fix.sh`
    (run by `make kind-up`) caps containerd's `LimitNOFILE` at 1048576 and
    restarts it; KIND's `containerdConfigPatches` only touch `config.toml`, NOT
    the systemd unit, so this must be a post-create node mutation. Idempotent.
    (Also bump `fs.inotify.max_user_instances` past the default 128 if SPIRE +
    Istio + the apps exhaust watcher instances.)

21. **MCP L7 authz runs on a standalone `agentgateway`, and several things must agree.**
    `agentgateway` (ns `mcp`, Service `agentgateway.mcp.svc.cluster.local:8080`,
    `k8s/workloads/agentgateway-config.yaml`) is the MCP front door for BOTH MCP
    servers, and **replaces** the former Istio ambient waypoint
    (`k8s/istio/mcp-l7-authz.yaml`, now deleted; `mcp-observability`/`mcp-ops` no
    longer carry `istio.io/use-waypoint`). Hard-won details:
    - **Path-routed, not federated.** ONE listener (`:8080`) with TWO path-scoped
      routes: `/observability/mcp` → mcp-observability, `/ops/mcp` → mcp-ops. It is
      path-routed (not a single federated `/mcp`) because agentgateway does **not**
      expose `mcp.tool.target` inside its `extAuthz` CEL scope — so per-backend audience
      narrowing can't be done on a single federated endpoint. Callers pick the path.
      **Re-verified on v1.4.1 (2026-08-05): still true, and it is structural, not a
      timing quirk.** In `crates/agentgateway/src/cel/types.rs` the CEL context's `mcp`
      field is a plain `Option<&MCPInfo>` while its neighbours (`jwt`, `llm`, `extauthz`,
      `backend`, …) are `ExtensionOrDirect`; `set_request()` wires up all thirteen of
      those and never touches `mcp`. `ext_authz.rs` builds its context with
      `Executor::new_request(req)` at every call site, which therefore leaves
      `mcp: None`. Only `new_mcp`/`new_mcp_request` (the MCP-layer policies, e.g.
      `mcpAuthorization`) populate it. v1.4.1's `schema/cel.md` calling `mcp.tool.*`
      "request-time" refers to those policies, NOT to extAuthz — don't be misled into
      federating on the strength of that doc.
      Two things DID change, and both are escape hatches if federation is ever wanted:
      (a) an undefined `mcp.*` reference no longer silently drops the ENTIRE computed
      header map — as of v1.4 only the undefined value is omitted (it still fails *open*,
      so any consumer must fail closed on a missing header; `exchange-shim` already does,
      `server.ts` `typeof targetAudience !== 'string'` → 400);
      (b) `request.headers["mcp-name"]` (the 2026-07-28 standard header) and
      `json(request.body).params.name` BOTH resolve inside extAuthz and both yield the
      tool name — the latter works on today's protocol, including the multiplexed
      `<target>_<tool>` form needed to derive an audience. The body route costs a ~2 MB
      CEL buffer ceiling (bodies ≥2 MB evaluate to nothing while our MCP servers accept
      4 MB), so prefer the header once clients speak 2026-07-28. **Our clients now do**
      (see #26): the v2 client emits `Mcp-Name: <tool>` on every `tools/call` whenever it
      negotiates the modern revision — verified in the spike, so the header route is live
      the moment the gateway offers 2026-07-28. It is NOT unconditional: on a 2025-era
      fallback there is no `Mcp-Name`, so any CEL keyed on it must still fail closed.
    - **JWT validation + coarse per-tier scope authz (NOT per-tool role split).** The
      gateway validates the caller's
      `aud=mcp-gateway` JWT (issuer `https://curity.localtest.me/oauth/v2/oauth-anonymous`;
      JWKS fetched from the in-cluster plain-HTTP URL
      `http://curity.curity.svc.cluster.local:8443/oauth/v2/oauth-anonymous/jwks`,
      same loopback foot-gun as #5). `mcpAuthorization` then does **coarse tier authz**:
      the `/ops/mcp` route requires `ops:write`, `/observability/mcp` requires `obs:read`,
      and `tools/list` is filtered by that tier scope. The gateway **lists and allows
      ALL ops tools** (`restart_deployment`/`scale_deployment`/`set_deployment_image`) for
      any `ops:write` caller — it does NOT split ops tools by role. It can't: agentgateway
      couples `tools/list` visibility to call-authorization, so a tool it won't let you
      CALL is also HIDDEN from `tools/list`; gating `set_deployment_image` here would hide
      it from an `oncall` caller and the specialist LLM (never seeing the tool) would loop
      silently instead of surfacing a denial. So the fine-grained
      `set_deployment_image`=`sre` split is enforced DOWNSTREAM at **mcp-ops**
      (`Config.setImageRequiredRoles`, default `['sre']`, env `SET_IMAGE_REQUIRED_ROLES`;
      logic in `apps/mcp-ops/src/mcp.ts` `imageRoleDenial`), which checks the caller's
      `roles` claim before the ops-api hop and returns a legible error the specialist
      LLM relays. The `ops:write` Curity role gate (widened `sre` → `sre OR oncall`) is
      what effectively gates `restart_deployment`/`scale_deployment` — that is the Curity
      gate, not a separate gateway rule. So carol (`[oncall]`) can restart/scale and SEES
      `set_deployment_image` in `tools/list` but the CALL is denied by mcp-ops; alice
      (`[sre]`) may call it; bob (`[developer]`) is denied `ops:write` at the exchange.
    - **extAuthz → co-located `exchange-shim` = the OBO hop.** For each tool-call the
      gateway makes an `extAuthz` call to `exchange-shim` (`apps/exchange-shim`,
      Node/TS + express — see #28, listens `:8090`, **same pod** as the gateway), which performs the RFC 8693
      exchange: it reads the gateway's rotating SPIFFE JWT-SVID from
      `/run/spiffe/curity-actor.jwt` (spiffe-helper sidecar) as the `actor_token`, uses
      the caller's `aud=mcp-gateway` token as the subject, and derives audience/scope
      **server-side** from an audience→scope allow-list (NEVER caller-supplied). It
      reuses `@ai-agents-demo/auth-curity` `exchangeToken` + `@ai-agents-demo/spiffe`,
      returns a token-endpoint-shaped JSON body, and the gateway swaps the narrowed
      token onto the request before forwarding to the origin MCP server. **The shim
      exists because agentgateway's CEL cannot read the rotating SVID file** — the
      exchange must run in a co-located sidecar.
    - **The gateway inserts ONE position into every downstream `act` chain** — SPIFFE
      ID `spiffe://demo.curity.local/ns/mcp/sa/agentgateway`. So obs-api now expects
      `[mcp-observability, agentgateway, agent-copilot]` (copilot direct) OR
      `[mcp-observability, agentgateway, agent-specialist, agent-copilot]`; ops-api
      `[mcp-ops, agentgateway, agent-specialist, agent-copilot]`; mcp-ops
      `[agentgateway, agent-specialist, agent-copilot]`. New Curity client
      `mcp-gateway` (confidential, `client_secret_basic`) is allowed to exchange
      `mcp-observability`→`obs:read` and `mcp-ops`→`ops:write`, with `allowedActor`
      pinned to the agentgateway SPIFFE ID.
    - **The gateway does NOT enforce `acr`/step-up or match the `act` chain** — those
      stay in the resource-server middleware (`auth-middleware.ts`). The RFC 9470
      step-up 401 still originates at mcp-ops/ops-api and passes back through the
      gateway. Source identity at the gateway is the JWT audience (`aud=mcp-gateway`),
      NOT mTLS SPIFFE identity. The Kubernetes Gateway API CRDs / `istio-waypoint`
      GatewayClass are no longer needed for MCP authz — but they ARE still installed and
      used by the **apis-tier waypoint** (`k8s/istio/apis-l7-authz.yaml`, applied by
      `make apply`): `obs-api`/`ops-api` carry `istio.io/use-waypoint: apis-waypoint`,
      and its `AuthorizationPolicy` pins each API to the mesh identity of the one MCP
      server that fronts it (`cluster.local/ns/mcp/sa/mcp-observability`/`mcp-ops`) plus
      the token's audience + scope. Don't remove `gateway-api-crds` from `make platform`
      on the strength of "MCP no longer needs it".

22. **The LLM egress is a governed hop through agentgateway, and the upstream
    vendor is pluggable — see `docs/llm-providers.md`.** Both agents exchange the
    user token → `aud=llm-gateway`, `scope=llm:invoke` (one exchange, no shim — the
    LLM vendor is outside the trust domain) and call the gateway's OpenAI-compatible
    `/llm` route; this is unchanged regardless of which provider answers it. The
    gateway holds the ONLY upstream key, now `$LLM_API_KEY` (was
    `$AZURE_OPENAI_API_KEY`) in the `agentgateway-llm` Secret (ns `mcp`). **The
    provider block is generated, not hand-edited:** `scripts/render-gateway-config.sh`
    reads `.demo.env` (`LLM_PROVIDER`/`LLM_MODEL`/`LLM_API_KEY`, plus
    `AZURE_OPENAI_ENDPOINT` for azure) and splices the matching fragment from
    `k8s/workloads/llm-providers/{openai,anthropic,gemini,azure}.yaml` into
    `.gen/agentgateway-config.yaml` (gitignored) between `# BEGIN_LLM_PROVIDER` /
    `# END_LLM_PROVIDER` sentinels — editing the tracked
    `agentgateway-config.yaml`'s `llm` route between those markers has NO effect,
    since `make apply`/`make configure-llm` always re-render over it. `jwtAuth` and
    the `llm:invoke` `authorization` rule sit OUTSIDE the sentinels, so the
    authorization posture of this hop cannot vary with the provider. **The gateway
    pins `model:`**, which overrides whatever the client sends, so agents have no
    `LLM_MODEL` to configure and instead send the constant
    `model-pinned-at-gateway` (`packages/agent-runtime/src/llm.ts`). `buildLlm` has
    exactly ONE path — no direct-to-vendor mode exists; reintroducing one would put
    a static vendor key back in the agent's environment and bypass the `llm:invoke`
    scope check, which is the property this demo argues against. Two traps, both
    measured against the pinned `agentgateway:v1.4.1`: **Anthropic breaks if
    `backendAuth.key.location` is set explicitly** — the `x-api-key`/
    `anthropic-version` rewrite (`llm/mod.rs:1247-1276`) only fires when the location
    was left implicit, so "fixing" `anthropic.yaml` to look like `azure.yaml` breaks
    it — while **Azure is the opposite and REQUIRES the explicit `api-key` header**
    (it gets no such rewrite); and standalone YAML at v1.4.1 accepts only **eight**
    provider keys (`openAI, gemini, vertex, anthropic, bedrock, azure, copilot,
    custom`) — the 13 named presets agentgateway's docs otherwise list (ollama, groq,
    …) are xDS-only and fail config load with `` unknown variant `ollama` ``.
    `resourceType` stays `openAI` (lowercase-o) on the azure fragment. The AI SDK
    client (`buildLlm`) points `baseURL` at `.../llm` and passes the exchanged JWT as
    the OpenAI bearer. The route serves **Chat Completions**, so the client must be
    `@ai-sdk/openai-compatible` — `@ai-sdk/openai` would POST `/llm/responses`
    (fact #30).

23. **`llm:invoke` is user-delegated and must be granted at EVERY narrowing hop —
    eight places.** It starts in the user's token and is narrowed down the chain by
    RFC 8693 (`requested ∩ subject ∩ policy` in `token-exchange.js`); miss one link
    and you get `invalid_scope: no scope intersects subject + policy` (or, if a
    client may not request it, `No valid scope was requested`). Grant it in: (1) the
    global `<scopes>` def; (2) each agent's `perAudience llm-gateway→llm:invoke`;
    (3) the **web-app** client `<scope>`; (4) the **`<ephemeral-client>`** `<scope>`
    (agents are CIMD ephemeral clients — this is what lets them *request* it); (5)
    the web login scope (`auth.ts`); (6) the **step-up re-auth scope** (`chat.tsx` —
    it *overrides* the login default, so the post-MFA/restart token silently loses
    `llm:invoke` if omitted); (7) the copilot's `perAudience agent-specialist→…llm:invoke`
    and (8) the copilot's requested `SPECIALIST_SCOPE` (env + `config.ts`) — because
    the specialist's subject token IS the copilot's `aud=agent-specialist` delegation
    token. 1–5 = copilot read flow; 6–8 additionally = specialist restart flow. See
    `docs/design.md` §3.6 for the full table.

24. **agentgateway's Rust resolver needs `config.dns` tuning to reach external
    hosts (the Azure `/llm` backend).** Every other backend is in-cluster; Azure is a
    public name. With the pod's default `resolv.conf` (`ndots:5`) agentgateway's
    hickory resolver fails the external lookup with `503 "backends required DNS
    resolution which failed" (NoHealthyBackend)` while glibc/Node in the same cluster
    resolve it fine. Fix in the config's top-level `config.dns` block:
    `lookupFamily: V4Only` (the Azure host has **no AAAA** → `ENODATA`; cluster is
    all-IPv4) and `edns0: true` (its A answer is a CNAME chain + several records that
    overflows the 512-byte UDP limit → truncated and unrecovered without EDNS0).
    `ndots:1` alone does NOT fix it. In-cluster backends (single small A records) are
    unaffected.

25. **`may_act` (RFC 8693 §4.4) is enforced BEHIND `allowedActors`, which makes naive
    negative tests worthless.** The exchange procedure stamps `may_act` on every issued
    token naming the single workload permitted to present it next (`perAudience.mayAct`
    in `token-exchange.js`; the login token's is stamped by `authorization-code.js`), and
    enforces the subject token's `may_act` against the verified actor SVID. Gotchas:
    - **Gate ordering.** `allowedActors` (step 3) runs *before* the `may_act` check
      (step 3b). Because the `mayAct` map mirrors each consuming client's `allowedActors`,
      the two gates agree on every happy path — so "present the wrong SVID" is refused by
      `allowedActors` and proves NOTHING about `may_act`. To exercise it you need a case
      where `allowedActors` PASSES and only `may_act` objects: take an
      `aud=agent-specialist` token (its `may_act` names the specialist) and replay it as
      the **copilot** with the copilot's own SVID. Verified 2026-08-05: refused with
      `actor … is not authorized by the subject token may_act (…)`. That case was
      **issued** before this claim existed — the copilot mints the specialist's token to
      send over A2A, so it holds a copy and could spend that delegation itself.
    - **Claim shape varies.** `subjectToken.get('may_act')` comes back as a Java Map, a
      JSON string, or a plain object depending on how Curity hydrated the introspected
      token. `act` dodges this by being forwarded opaquely; `may_act` must be read into,
      hence the `mayActSub()` normaliser. Same hazard, different mitigation.
    - **Enforce-if-present.** Terminal audiences (`llm-gateway`, `obs-api`, `ops-api`)
      carry no `may_act` — nothing exchanges them onward — and absent means unconstrained,
      so tokens minted before the claim existed still work out their lifetime.
    - Surfaced for demos via `summarizeJwt().mayAct`. `act` = who **did** act (audit);
      `may_act` = who **may** act next (authorization).

26. **The MCP SDK is v2 (`@modelcontextprotocol/{client,server,node}@2`) and the wire
    revision is 2026-07-28 ONLY — there is no 2025 fallback anywhere.** The v1
    `@modelcontextprotocol/sdk` umbrella package is gone; it split into three.
    Consequences that bite:
    - **`server.tool(name, desc, shape, cb)` no longer exists** — only
      `registerTool(name, { description, inputSchema }, cb)`, and `inputSchema` must be a
      *wrapped* `z.object({...})`, not a raw shape. It must also expose
      `~standard.jsonSchema`, which **zod 3 does not have on either entry point** (neither
      `zod` nor `zod/v4` in 3.25). So `mcp-observability`/`mcp-ops` are on **zod 4** while
      `agent-runtime` and the agents stay on **zod 3** (AI SDK v4 peers on it). Divergent
      zod majors in one pnpm workspace is deliberate, not drift.
    - **Serving is `createMcpHandler(factory, …)` + `toNodeHandler`,** replacing the
      per-request `StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`. The
      factory runs once per HTTP request and receives `authInfo`, which is where the
      per-caller `subject_token` now comes from. **The SDK never reads credentials from
      headers** — `authMiddleware` must publish them on `req.auth` as `AuthInfo`
      (mcp-ops also passes `roles` in `extra`, because the factory has no express `req`
      and the `set_deployment_image` gate needs it).
    - **`toNodeHandler` ignores a function 3rd argument** (express's `next`). Mounting it
      as bare middleware after `express.json()` therefore makes it re-read an already
      drained stream and every request classifies as *legacy* with an empty body. You MUST
      call it as `nodeHandler(req, res, req.body)`. This fails silently — the symptom is
      "the modern revision never negotiates", not an error.
    - **No 2025 fallback, on purpose, and it is a SECURITY property — not tidiness.**
      Servers run `legacy: 'reject'` and clients pin
      `versionNegotiation: { mode: { pin: '2026-07-28' } }`. A 2025-era hop carries no
      `Mcp-Name` header, and the gateway's per-tool authz rules key on exactly that
      header, so a silent downgrade would open an authz gap rather than merely losing
      features. Pinning converts that into a loud connect failure. **Do not "helpfully"
      restore `legacy: 'stateless'` or `mode: 'auto'`** to fix a connect error — that
      trades a visible failure for an invisible bypass. (Both were used during the
      migration precisely because agentgateway sat in the middle unverified; v1.4.1 was
      then confirmed to speak 2026-07-28 on both tiers, which is what made the pin safe.)
    - **`make smoke-mcp-protocol`** (`scripts/smoke-mcp-protocol.sh`) is the only thing
      that observes the revision actually negotiated *end to end*; it hard-fails on
      anything but 2026-07-28 and re-checks tier filtering + cross-tier denial. The
      servers' own support is pinned by `apps/mcp-*/tests/mcp-http.test.ts`, so a
      mismatch there indicts the gateway, not the origin.
    - **External MCP clients must speak 2026-07-28** — including MCP Inspector
      (`make inspect-obs`/`inspect-ops`). An older Inspector will be refused at connect
      rather than silently served on the old revision.
    - **Client-side response caching (SEP-2549) is off by default and `tools/call` is
      never cacheable** — `defaultCacheTtlMs` is `0`, so nothing is served from cache
      unless a *server* sends `ttlMs`. `tools/list` IS cacheable and IS identity-dependent
      here (the gateway filters it per tier), so `openMcpToolset` sets `cachePartition` to
      the token `sub` to keep the boundary right if that ever changes.
    - **The smoke scripts hand-roll the wire protocol** and had to move with it: no
      `initialize`, no `mcp-session-id`, and a per-request `_meta` envelope whose
      **three** reserved keys (`protocolVersion`, `clientInfo`, `clientCapabilities`)
      are ALL required — a partial envelope is rejected with `-32602` naming the
      missing one. They also send `Mcp-Name` and `Mcp-Param-Namespace`, because those
      headers are the gateway rules' inputs (#27); a helper that omitted them would
      silently exercise a different policy path than production traffic.

27. **Two authorization rules now run AT the gateway, in the `authorization` policy —
    NOT `mcpAuthorization`.** `set_deployment_image` requires the `sre` role (keyed on
    `Mcp-Name`), and any explicit namespace other than `prod` is refused (keyed on
    `Mcp-Param-Namespace`, SEP-2243). Covered by `make smoke-gateway-authz`. Details
    that are easy to get wrong:
    - **`authorization` ≠ `mcpAuthorization`.** The MCP-layer policy couples
      call-denial to `tools/list` visibility (v1.4.x has a test literally named
      *"deny policy … filters only that tool from list_tools"*), so gating a tool
      there HIDES it — and an LLM that never sees a tool loops silently instead of
      relaying a denial. `authorization` is the HTTP-layer policy
      (`crates/agentgateway/src/http/authorization.rs`) and takes no part in
      `tools/list`, so the call is refused while the tool stays visible.
    - **Deny-only ⇒ denylist semantics.** With no `allow` rule present every
      unmatched request still passes; add one `allow` and the route silently becomes
      an allowlist that denies everything else. See `PolicySet::validate`.
    - **extAuthz runs BEFORE authorization for ROUTE-level policies** (measured on
      v1.4.1), so a denied tool-call still performs the OBO exchange — the privileged
      token is minted and discarded. Do not conclude otherwise from `httpproxy.rs`:
      it has three policy application sites with *different* orders.
    - **`Mcp-Param-Namespace` only exists because the tools declare
      `x-mcp-header`** on their `namespace` input (`z.…meta({'x-mcp-header':
      'Namespace'})`, zod 4). Deleting that declaration breaks no call — it silently
      removes the gateway's authz input, so `apps/mcp-*/tests/mcp-http.test.ts`
      assert it explicitly.
    - The namespace rule is written **"present AND not prod"** so that *omitting* the
      argument (the common case — the server defaults it) can never trip it,
      whichever way a missing header evaluates in CEL.
    - **mcp-ops remains authoritative** for the role split: the gateway rule cannot
      evaluate true if the `roles` claim is missing, so it fails open. The downstream
      `imageRoleDenial` check is what makes the split unconditional.
    - **"Listed ≠ callable" is made visible from the server's own rule, not a UI copy.**
      Because the tool stays in `tools/list` for carol, the *Tools this token can reach*
      card would otherwise read "allowed". mcp-ops publishes the required roles in the
      tool's `tools/list` `_meta` (`io.curity.demo/required-roles`, from the same
      `setImageRequiredRoles` the gate enforces); agentgateway relays `_meta` untouched
      (v1.4.1 `merge_tools` rewrites only `name`, and rmcp serialises the field as
      `_meta`); `openMcpToolset` exposes the raw entries as `listed`; the specialist's
      `toolInfos` stamps `requiredRoles` + `callable` per caller. Don't hard-code `sre`
      in the web app — the config value is the single source of truth.
    - **A gateway denial costs the legible error, and that has to be bought back.**
      agentgateway answers with a bare HTTP 403 — it cannot put a message in the body
      — so the denial reaches the client as a TRANSPORT error, not an MCP tool result.
      Left to throw, the AI SDK reports "tool call failed" and the LLM *invents* a
      reason: the observed answer was "I do not have permissions… run kubectl
      yourself", which is vague and wrong about who lacked permission (it is the USER,
      not the agent). Two changes fix it, and **both are needed**:
      (a) `openMcpToolset` converts a 403 into a factual `{error:'forbidden', tool}`
      result; (b) the specialist's system prompt says to name the refused tool and
      never offer a bypass route. (a) alone does NOT work — the model ignored guidance
      embedded in the tool payload. **Keep instructions OUT of tool results:** tool
      output is untrusted data, and obeying imperatives smuggled through it is exactly
      the prompt-injection hole this demo argues against. Verified end to end: carol
      (oncall) now gets *"The set_deployment_image tool was refused with a 403
      authorization error. You are not authorized… No changes were made."*

28. **A bare ESM `import { createServer } from 'node:http'` is NOT reliably patched
    by OTel — that is why `exchange-shim` serves through express.**
    `@opentelemetry/instrumentation-http` patches the **CJS** `http` module.
    Require-in-the-middle installs those hooks synchronously at SDK start, so
    anything reaching `http` via a CJS `require` — which is what **express** does,
    and why every other service here is fine — is instrumented. A bare ESM import of
    a builtin instead depends on the ESM hook registration winning a race against the
    app's own import, and it frequently LOSES even with `node --import`. Symptoms, in
    increasing order of how misleading they are:
    - No HTTP **server** span from the service, while **client** spans keep working
      perfectly (`instrumentation-undici` uses diagnostics_channel, not module
      patching). The service therefore *looks* instrumented.
    - No server span ⇒ nothing calls `propagation.extract` ⇒ any span the handler
      creates becomes a **root**, starting its own orphan trace. This is what made the
      shim's `auth.token_exchange` spans — the hop that inserts agentgateway into the
      downstream `act` chain — vanish from the caller's trace.
    - **Intermittent across rebuilds** with identical source: unrelated dependency
      changes shift module-load timing and flip the outcome. This cost two wrong
      diagnoses that blamed agentgateway's extAuthz propagation instead.
    **Diagnose in one command: send a request with NO `traceparent`.** A root span is
    always sampled, so if no span appears it is not sampling and not parenting — the
    server is simply unpatched. Beware the false negative: a one-off
    `node --import @ai-agents-demo/otel-bootstrap -e "…"` in the same container CAN
    export a manual span (CJS `require`), making the SDK look healthy while the
    long-running ESM server is unpatched. Fix is `apps/exchange-shim/src/app.ts`
    (express), pinned by `apps/exchange-shim/tests/app.test.ts`. Don't "simplify" it
    back to `createServer`. Relatedly, `otel-bootstrap` disables the `net`/`dns`/`fs`
    auto-instrumentations (`packages/otel-bootstrap/src/instrumentation-config.ts`):
    `tcp.connect`/`tls.connect` were a third of a read-path waterfall and say nothing
    about delegation. Failures still surface on the enclosing HTTP span.

29. **agentgateway tracing: `config.tracing` works, extAuthz needs an explicit
    `traceparent`, and MCP backends mis-parent the origin span.** Three separate
    things, all verified on v1.4.1:
    - **Enable it.** `config.tracing.otlpEndpoint` + `otlpProtocol: grpc|http` (also
      `headers`, `fields`, `randomSampling`, `clientSampling`, `path`). Without it the
      gateway generates a span per request (it logs `trace.id`/`span.id`) and
      propagates context, but exports nothing — the hop that authorizes the call and
      re-mints the token is missing from every trace. It is also the ONLY source of
      `gen_ai.usage.*` token accounting on `/llm`, plus `mcp.method.name`,
      `mcp.target`, `gen_ai.tool.name`, `route`, `http.path` and `endpoint` (upstream
      host:port — HTTP backends only; `mcp:` backends use named targets so
      `mcp.target` names the backend instead). `fields.add: {url.full: 'request.uri'}`
      adds the absolute URL under the standard key.
    - **Validate offline** with `docker run …/agentgateway:v1.4.1 -f cfg.yaml
      --validate-only` (set `$AZURE_*` to dummies; it then fails only on the JWKS
      fetch, which is past schema validation). It does **NOT** check CEL — an unknown
      CEL root passes validation and silently yields nothing at runtime.
    - **extAuthz gets no trace context unless you forward it.** The gateway propagates
      to routed backends but not to the callout, so each extAuthz block sets
      `traceparent: 'request.headers["traceparent"]'`. Counter-intuitively that value
      is NOT the caller's: the gateway has already rewritten the header to its OWN span
      (`httpproxy.rs` `tp.new_span()` + `ns.insert_header(req)`, at the listener stage
      before route policies), so forwarding it parents the shim's exchange directly
      under the gateway span — exactly right. Confirmed by echoing the callout's
      headers from a throwaway listener in the pod.
    - **Known upstream bug — the MCP origin span is a SIBLING of the gateway span,**
      not a child. For HTTP backends the gateway forwards its rewritten `traceparent`
      and nesting is correct; for `mcp:` backends the upstream request is built fresh
      (`mcp/upstream/streamablehttp.rs`) and `IncomingRequestContext::apply` copies
      headers only where absent, carrying the ORIGINAL inbound traceparent. So
      `mcp-observability`/`mcp-ops` parent to the CALLER, and the gateway looks like a
      bystander to a call that went around it. Not configurable, and still present on
      `main` (v1.4.1 is the newest tag). The bars still nest correctly in time; only
      the indentation lies.

30. **The Vercel AI SDK is v7 (`ai@7`, providers `4.x`), and two of its changes are
    silent — one converts an exception into data, the other repoints an HTTP path.**
    Neither announces itself: the first keeps compiling and keeps tests green, the
    second only shows up as a 404 in the cluster.
    - **A throw from inside a tool's `execute` no longer propagates.** `ai@4` wrapped
      it in `ToolExecutionError` and re-threw; since **ai@5** the SDK converts it to a
      `tool-error` content part, the tool loop CONTINUES, and `generateText` **resolves**
      — with prose the model invented about why it failed. There is no option to restore
      abort-and-propagate. `agent-specialist` detects a mid-flight RFC 9470 challenge
      this way, so the challenge now travels **out-of-band** on a `StepUpSink`
      (`apps/agent-specialist/src/mcp-ops-client.ts`): `buildStepUpInterceptingFetch`
      throws *and* records, `runRemediation` checks the sink before reporting `ok` AND
      in its `catch`, and `stopEarly` feeds `stopWhen` so the loop halts on the first
      401 instead of retrying into it. **Left unfixed the browser never prompts for
      MFA** — the A2A reply is a cheerful `kind:'ok'` — and nothing fails loudly:
      `ToolExecutionError` vanishing breaks *compilation* of the old tests, and the
      tempting repair (swap in a plain `Error` with `.cause`) makes them green again
      while testing a path production can no longer reach. Pinned by
      `packages/agent-runtime/src/tool-errors.test.ts`, which characterizes the SDK
      itself — if a future major restores propagation, that test fails and the sink
      can be reconsidered. **Do not delete the sink because "the catch block looks
      like it handles it".** `findStepUp`'s cause-walk was removed for exactly that
      reason: it had no reachable input left and implied the throw route still worked.
    - **`@ai-sdk/openai`'s provider function defaults to the Responses API** (since
      ai@5), so `createOpenAI({baseURL})(model)` POSTs `${baseURL}/responses`.
      agentgateway's `/llm` route is Chat-Completions-shaped and is the ONLY source of
      `gen_ai.usage.*` accounting (#29), so that drift breaks the LLM hop *and* its
      telemetry. `buildLlm` therefore uses **`@ai-sdk/openai-compatible`**
      (`createOpenAICompatible`), which has no Responses implementation to drift onto
      and is the honest description of the gateway. Measured, not inferred:
      `createOpenAI()(m)` → `/llm/responses`; `.chat(m)` and `createOpenAICompatible()`
      → `/llm/chat/completions`. **A unit test asserting `model.provider` cannot see
      this** — only the request path can, which is what `llm.test.ts` now asserts.
      Note you cannot distinguish the two paths by probing the gateway either: its JWT
      policy runs before routing, so both answer `403` without a token.
    - **MCP tool schemas are now passed through VERBATIM** (`mcpInputSchema`, which
      wraps the server's document with the SDK's `jsonSchema()` helper). It replaced a
      hand-written JSON-Schema→Zod converter (`jsonSchemaToZod`) that handled
      object-of-primitives only and silently dropped the rest: enums/arrays/nested
      objects became `z.unknown()`, and every constraint was lost — `replicas`
      (`integer`, 0–20 on mcp-ops) reached the model as a bare number, so it could
      propose 50 and learn the bound only from a server-side rejection. **Deliberate
      trade-off:** `jsonSchema()` does no validation without a `validate` function, so
      the model's args are no longer checked client-side. That was never the security
      boundary — `mcp-ops`/`mcp-observability` validate every call with zod 4, and the
      gateway's `Mcp-Param-Namespace` rule fails closed on anything unreadable; only
      *where* a malformed call is caught moves. Don't "restore" a converter here: it
      recreates a second, drifting copy of a contract the server already publishes.
      (Unrelated to the zod-3/zod-4 split — the client no longer builds zod at all,
      but `zod` stays a dependency because `ai` peers on it.)
    - **Mechanical renames, all compiler-caught:** `parameters`→`inputSchema`,
      `maxSteps: n`→`stopWhen: isStepCount(n)`, `toolCall.args`→`.input`,
      `toolResult.result`→`.output`, `LanguageModelV1`→`LanguageModel`. `system:` and
      `stepCountIs` still work (`@deprecated` alias) but were renamed for hygiene.
      Use the **unversioned** `LanguageModel` (we export
      `AgentLanguageModel = Exclude<LanguageModel, string>`): pinning `LanguageModelV1`
      is what made this file part of the upgrade at all, and the named alias also
      resolves the TS2742 the copilot's `llm.ts` re-export otherwise hits.
    - **`{name, args}` / `{name, result}` in the `/chat` response is OUR wire contract**
      with the web UI's Trace tab (`apps/web/src/lib/trace-view.ts` +
      `components/agent-trace.tsx`), not the SDK's shape.
      It is deliberately held stable while the SDK's field names moved underneath, so
      `apps/web` needed no edit. The mappings use `as` casts, so a wrong field name
      yields `undefined` in the UI rather than a type error — check the Trace tab, not
      just the typechecker.
    - **zod, Node and ESM were all non-issues.** v7's peer range is
      `^3.25.76 || ^4.1.8`, so the deliberate zod-3 (agents) / zod-4 (MCP servers)
      split from #26 survives untouched; Node 22 was already the floor; every package
      importing `ai` was already `"type": "module"` (`apps/web` isn't, and doesn't
      import it). **`generateObject` was deprecated in v6 and we don't use it** —
      `intent.ts` is deterministic on purpose.

31. **The OBO log is the log-plane twin of the traces, and its two easiest
    regressions are silent.** `packages/auth-curity/src/obo-log.ts` renders the
    `┌─ … RECEIVE/EXCHANGE/CALL/DENY` blocks every service prints. Every line carries
    an ISO-8601 stamp on the header and a `trace : <traceId> ▸ <spanId>` field, taken
    from the active span — so one `kubectl logs` line joins to the Grafana/Tempo trace
    and to agentgateway's own `trace.id=…` request log. Rules that are load-bearing:
    - **Denials MUST be logged, and the logging lives at ONE exit per component.**
      `exchange.ts` originally called `oboLog` inside `if (response.ok)`, so a *granted*
      exchange logged in full and a *refused* one produced nothing: the chain just
      stopped, indistinguishable from a crash. In a demo about authorization that is
      backwards. `DENY` is emitted from `exchangeToken`'s `catch` (the single point every
      failure path crosses — refusal, unreachable endpoint, malformed body — and inside
      `startActiveSpan`, so it inherits the failed attempt's span id) and from the
      `runRemediation` wrapper over `remediate` (a step-up has **five** origins: the scope
      gate, the deterministic `acr` pre-check, a late toolset rejection, and two
      `StepUpSink` checks around the LLM loop). **Don't relocate either to the individual
      `throw`/`return` sites** — a sixth path would then be added unlogged, which is
      exactly how the gap arose. Three tests assert `DENY` is *absent* on success paths;
      a demo that prints DENY on a granted exchange is worse than one that prints nothing.
    - **An `invalid_scope` refusal logs TWICE on purpose** — once as Curity's verdict
      (`[agent-specialist] DENY → mcp-gateway … invalid_scope`) and once as the agent's
      RFC 9470 response (`DENY → mcp-ops (step-up required)`), ~6ms apart. Different
      facts at different layers; merging them loses which component decided what.
    - **`formatOboLog` is pure and must stay pure.** `at` and `trace` are *parameters*;
      `oboLog` is the thin wrapper that calls `new Date()` and `trace.getActiveSpan()`.
      Moving either inside the formatter makes every rendering test time- and
      context-dependent. Likewise `traceFields(span)` takes the span explicitly — a
      `= trace.getActiveSpan()` default would make its "no active span" branch
      unreachable from a test. It drops an all-zero span context, so an uninstrumented
      service (see #28) prints no `trace` field rather than 32 zeros that look real —
      which also makes a missing `trace` field a one-glance diagnosis for #28.
    - **`serviceLabel` exists for `exchange-shim` only.** The log's service name defaults
      to a friendly form of the Curity `client_id`, right everywhere the client and the
      workload share a name. The shim authenticates as `mcp-gateway`, so without the
      override it logs under a name no pod has.
    - The box format is deliberately multi-line for `kubectl logs` readability, which
      means a log *collector* splits each `│` line into its own record. Fine today
      (nothing ships these off-cluster); if that changes, add an opt-in `OBO_LOG=json`
      single-line mode rather than flattening the pretty default. `OBO_LOG=off` silences it.

32. **`AUTH_DEBUG` gates demo *features*, not verbose logging — don't re-merge them.**
    `AUTH_DEBUG=true` (set in `k8s/workloads/web.yaml`) enables the `/inspect` token
    viewer and `/api/dev/token`, which `make smoke` reads for `SMOKE_SUBJECT_TOKEN`. It
    is therefore permanently ON in the cluster. It used to *also* drive Auth.js's own
    `debug:` flag, which dumps the full decoded ID token and every `Set-Cookie` on each
    login and buried the OBO chain in `kubectl logs -n web`. Auth.js verbose logging now
    has its own switch, **`AUTHJS_DEBUG`**, unset by default. Three ad-hoc debug loggers
    were removed at the same time; one of them (`auth.incoming`, on the NextAuth route)
    wrote the callback URL's `code` and `state` to stdout — an authorization code in
    `kubectl logs`, readable by anyone holding `pods/log` in `web`. Its diagnostic
    purpose was settled by fact #1.

33. **A Token Issuance Authorizer (TIA) gates `ops:write` on `acr=mfa`, and its config
    has one trap that costs a Curity boot.** `require-mfa-for-privileged`
    (`acr-token-issuance-authorizer`, `required-acr: mfa`) is bound to the `ops:write`
    `<scope>` in `k8s/curity/configmap.yaml`. A TIA is *configuration* that decides, per
    requested scope, whether Curity may RELEASE it — `Allow` / `Deny` /
    `RequireUserConsent` / `SetScopeTimeToLive` — and it runs on every grant, so it
    complements rather than replaces `token-exchange.js` (see `docs/design.md` §3.2.1).
    Details that bite:
    - **A plugin-provided block needs its own `xmlns`.** A YANG `augment` places the
      augmented node in the **augmenting module's** namespace, so
      `<acr-token-issuance-authorizer xmlns="https://curity.se/ns/ext-conf/acr-token-issuance-authorizer">`
      — same pattern as `<totp xmlns=".../ext-conf/totp">` already in the file. The
      enclosing `<token-issuance-authorizers>` is core `profile-oauth` and inherits.
      Omit the xmlns and ConfD refuses the whole file with only *"One or more of the XML
      files in the /opt/idsvr/etc/init directory are corrupt"* — no element named, and
      Curity CrashLoops, which per fact #15 also costs an HSQLDB re-seed.
    - **Validate offline before applying, in ~25s.** Boot the SAME pinned image in a
      scratch namespace with the candidate configmap + the license secret, then read the
      config back out of CDB: `printf 'show configuration profiles profile token-service
      settings authorization-server token-issuance-authorizers\nexit\n' | /opt/idsvr/bin/idsh`.
      "ConfD started" alone is NOT proof the block was accepted — query it. This also
      prints the resolved license features, which is how
      `token-issuance-authorization={feature=…, restrictions=[]}` was confirmed present:
      the Trial/Enterprise license does not list it, but `LegacyFeatureUpgrader` grants it
      to Basic/Standard/Enterprise, so no new license is needed.
    - **Denial is per scope.** Only when EVERY requested scope is denied does Curity
      answer `access_denied` (`isFullyDenied`); otherwise it returns 200 with a narrower
      token. The demo's step-up beat is unaffected — the specialist's privileged hop
      requests `ops:write` alone, so it still fails loudly and `runRemediation` already
      maps that to an RFC 9470 challenge — but do not assume a partially-denied exchange
      fails at all. **`openid` is exempt** and cannot be bound to a TIA.
    - **`RequireUserConsent` is a no-op on every hop here.** Both token-exchange grants
      deliberately ignore the consent obligation (there is no user to ask), so that
      decision only has effect at the authorization endpoint.
    - **11.4.0 ships six TIAs** — `acr`, `authzen`, `client-type`, `composite`,
      `grant-type`, `script`. **`authentication-freshness` exists in the idsvr source but
      is NOT in the image**; don't plan on it. The `script` TIA runs in
      `JavaScriptEnvironment.basicEnvironment()` (no `exceptionFactory`, so a TIA cannot
      raise a custom OAuth error) and is Nashorn-validated at config load, so fact #17's
      trailing-comma hazard would apply to it too.
    - **The TIA DOES see `acr` on an exchange hop — verified by a two-sided probe, not
      assumed.** This was the one real risk: if `acr` were invisible where
      `getInitializedContext(...)` builds the TIA's `authenticationAttributes`, the gate
      would false-deny a user who HAD stepped up. Proof needs both halves, because a
      pass alone is also consistent with the TIA never running: bind a throwaway ACR TIA
      to a scope the caller already holds (`obs:read`) with `required-acr: html-form` →
      the copilot→mcp-gateway exchange still issues `scope=obs:read`; flip it to
      `required-acr: mfa` → the same exchange returns
      `access_denied "Authorization denied for all requested scopes and claims"`
      (the `isFullyDenied` path). So the TIA runs at the exchange and reads the
      delegation's authentication context.
    - **To apply a configmap change WITHOUT the fact-#15 HSQLDB wipe, merge it into the
      running ConfD instead of restarting.** The mount is a `subPath`, so it never
      live-updates and a pod restart is otherwise required — which costs every seeded
      user + their TOTP enrolments, and therefore blocks `make smoke` (its tokens come
      from real logins). Instead: `kubectl apply` the configmap so the next boot matches,
      then `kubectl cp` a `<config>` fragment into the pod and
      `printf "configure\nload merge /tmp/frag.xml\ncommit\n" | /opt/idsvr/bin/idsh`.
      ConfD is transactional (a bad merge rolls back), `delete <path>` reverts, and
      **`show configuration … | display xml` is the only proof it landed** — "Commit
      complete" is not. Careful with leaf-lists: merge APPENDS to them (so re-merging a
      different `required-acr` yields both values); plain leafs are replaced.
    - **`scripts/smoke-stepup.sh` `[2/4]` is the regression test** and it drives a real
      password-only login (needs `SMOKE_ALICE_PASSWORD`), because the property under test
      is what Curity will ISSUE — no pre-existing token can demonstrate a refusal to mint
      one. It replaced an assertion that is now unreachable by construction; the
      resource-server `acr` check it used to cover lives on in
      `apps/mcp-ops/tests/auth-middleware.test.ts`. **Driving that login from a script
      means interleaving 302s with rendered forms** — this profile's chain is
      `/authorize` → authenticator chooser → `html-auth` (POST `userName`/`password`,
      no CSRF field) → the `debug-attribute` action page (submit form, no inputs) →
      a *"Redirecting…"* auto-POST back to `/oauth/v2/oauth-authorize` carrying hidden
      `token` + `state` → the code. Following only redirects stalls at the action page,
      and POSTing the resume form with an empty body drops the hidden fields — both
      failures look exactly like a wrong password, which is why `parse_post_form`
      submits forms properly rather than curling `-L`. And do NOT use `curl -L` to the
      end: it hands the code to the real Next.js callback, which redeems it, so the
      script's own token call then fails on an already-used code.
      Measured against the pre-TIA config, that flow returns
      `scope=openid obs:read llm:invoke ops:write` at `acr=html-form` — the hole the
      TIA closes, and the reason this assertion is a real regression test.

34. **The identity panels are debug surfaces that mint REAL tokens, and five rules
    keep the OBO-chain view truthful — each one was a bug first.** Every workload
    serves `GET /spiffe-id`; the agents and MCP servers serve `GET /last-token` (their
    hop's tokens, decoded; `?raw=1` adds raw JWTs and is asked for only by the BFF's
    `AUTH_DEBUG`-gated `/api/inspect`); the agents serve `GET /tools`. The BFF proxies
    them (`/api/obo-chain`, `/api/spiffe-identities?flow=`, `/api/tools`) so the
    browser never holds a token. Full table in `docs/design.md` §2 *Visibility surfaces*.
    - **Exchange slots are process-global; `selectDownstreamBranch` gates them on the
      `sub` + `jti` of the CURRENT inbound token** and shows one branch (observe XOR
      privileged), whichever is newer. Without the `jti` gate a previous login's
      exchange for the same user leaked into a fresh session before any flow ran.
    - **Probes are not flows.** `/tools` reuses `obtainMcpToken` / `obtainSpecialistToken`
      / `obtainOpsToken`, which stamp those slots on cache hits too, so the probes pass
      `recordLastExchange: false`. Forgetting it makes *Check tools* conjure a
      specialist branch that never ran. Pinned by contract tests on both tools routes.
    - **The MCP servers build their rows from the last tool call's slot, not from the
      `/last-token` request** — that request also travels through agentgateway, so the
      shim mints a fresh token just for the walk (a different `jti` and a full 5-minute
      TTL next to neighbours with seconds left). Before any tool has run they
      contribute no rows.
    - **The downstream walk authenticates with the exchanged token, so expiry used to
      truncate the chain to the copilot's own hops.** `createDownstreamChainFetcher`
      remembers the last successful result per exact bearer (bounded to 8) and serves it
      when that same bearer is later refused or the service is unreachable. Keyed on the
      token string, a snapshot can only describe the delegation it was fetched with; no
      route's auth changes.
    - **The `aud=llm-gateway` exchange is emitted as a LEAF** (`note` on the hop; the
      ledger takes it off the spine), placed directly under the token it was minted from
      and BEFORE the MCP branch — the ledger parents rows by `act`-chain prefix, so the
      mcp-gateway row still diffs against hop 0. Shown only for the flow it was minted
      in (copilot: read path, stamped after that request's mcp-gateway exchange;
      specialist: after its `ops:write` exchange). Only the emitting agent knows a hop
      is a leaf; the UI must not infer it from the audience.
    - The ledger and the identities panel **never poll** — `useNow` ticks a 1 s clock
      for the countdowns, because re-fetching `/api/obo-chain` would add spans and
      OBO-log lines to the very telemetry the demo is showing.

## Commands

`make help` prints the canonical list. The ones that matter day-to-day:

```bash
make tools-check     # preflight: node>=22, pnpm, docker, kind, kubectl, helm, mkcert
make demo            # stand up the full platform on a fresh KIND cluster
make seed-secrets    # interactive: web/mcp secrets, agent RSA keypairs, LLM provider key
make configure-llm   # switch LLM provider after editing .demo.env
make validate-llm    # validate all provider fragments against the pinned gateway image
make images          # build all 8 app images and `kind load` them
make apply           # apply manifests + embed procedures + embed mkcert CA + run routing
make routing         # re-patch hostAliases + mkcert CA into app pods + Curity→agent aliases
make status          # pod health across every demo namespace
make smoke           # routing-check + OBO + A2A + step-up/role-denial + LLM + MCP-revision + gateway-authz smoke tests
make curity-truststore     # re-embed the mkcert root CA for the CIMD metadata fetch
make seed-agent-key  # (re)generate the agent-copilot RSA keypair (private_key_jwt)
make doctor          # read-only Docker + KIND disk audit
make clean           # full teardown
make reset           # tear down + reclaim docker build cache (ENOSPC recovery)
```

**First-time setup:** `make demo` → seed Curity offline per `docs/curity-seed.md`
→ install the license Secret → `make seed-secrets` → `make images apply` →
`make status` → open `https://app.localtest.me`. Full runbook: `docs/demo.md`.

**TypeScript dev loop** (pnpm 9.x via corepack):

```bash
pnpm install
pnpm turbo run build typecheck test                       # all workspaces
pnpm --filter @ai-agents-demo/auth-curity test            # one package
pnpm --filter @ai-agents-demo/auth-curity test -- --watch # vitest watch
```

`turbo.json` has `typecheck` depending on `build` so Next.js's `.next/types/**`
exists when tsc reads it; don't remove that dependency.

## When making changes

- **New tracked secrets are a red flag.** Anything credential-shaped belongs
  out-of-band (`make seed-*` / `kubectl create secret`), not in committed YAML.
- **`packages/auth-curity` owns Curity rules.** Issuer/audience/JWKS/exchange
  logic lives there once — don't duplicate it in apps.
- **The Curity configmap (`k8s/curity/configmap.yaml`) is a full XML export.** It
  is positionally significant; prefer small additive edits over re-arranging.
  The procedures — token procedures (`token-exchange.js`, `authorization-code.js`)
  and the `add-roles` transformation procedure (`add-roles.js`, assigns `roles`
  per user at login) — are embedded as Base64 from `k8s/curity/procedures/` via
  `make curity-procedures` (run by `make apply`) — edit the `.js`, not the Base64.
  `embed-curity-procedures.sh` keys each by its `<id>` and element type
  (`token-procedure` vs `transformation-procedure`).
- **Mermaid diagrams in `/docs`** must use quoted subgraph names and quoted node
  labels containing parens/special chars (GitHub's renderer is stricter than
  mermaid-cli). A bare `;` in sequence-diagram message/Note text is a statement
  terminator and breaks the parse — use `,` or `<br/>` instead.
- **macOS bash is 3.2.** No `declare -A`; use parallel arrays or IFS-split
  strings (see `scripts/apply-tls-secrets.sh`).
- **`.next/types/`** is auto-generated; keep it in `apps/web/tsconfig.json`'s
  `include` or typecheck loses Next.js route types.
- **Resource servers share one middleware shape** (`src/auth-middleware.ts`).
  Changing the actor-chain or step-up policy means updating `expectedActorChain`
  / `requiredAcr` in the relevant `config.ts` *and* the Curity procedure policy.

## Where to find more

- [`docs/architecture.md`](docs/architecture.md), [`docs/design.md`](docs/design.md),
  [`docs/demo.md`](docs/demo.md) — the canonical trio.
- [`docs/curity-seed.md`](docs/curity-seed.md) — offline Curity setup checklist.
- SPIFFE identity scheme: [`docs/design.md`](docs/design.md) §3.3 (SVID delivery)
  and [`docs/architecture.md`](docs/architecture.md) §3 (trust domain + ID shape).
  There is no `docs/spiffe.md`.
- [`docs/llm-providers.md`](docs/llm-providers.md) — switching the LLM vendor
  behind agentgateway's `/llm` route.
- [`docs/archive/`](docs/archive/) — historical build log: phase notes,
  `superpowers/` design specs, and the original implementation plan.
