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
        (the set_deployment_image=sre role split is enforced downstream at mcp-ops, NOT the gateway)
                          every agent/MCP/LLM hop ⇄ Curity (RFC 8693 exchange; SPIFFE JWT-SVID as actor_token)
```

- **Curity is the sole token issuer.** Every token — user and exchanged — comes
  from Curity. Validate JWTs against Curity's JWKS; never mint tokens elsewhere.
- **Web app is a BFF.** Browser holds an httpOnly cookie; the access token never
  leaves the server.
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
  (`buildLlm` provider wiring + `openMcpToolset`/`jsonSchemaToZod` MCP→AI-SDK
  adapter); both agents depend on it (copilot's `llm.ts`/`mcp-client.ts` are thin
  re-exports). Every model call is now routed through agentgateway's `/llm`
  route rather than called directly — see hard-won fact #22; the old
  direct-to-Azure path (`@ai-sdk/azure` in `buildLlm`) is gone.
- **MCP servers are thin clients.** `mcp-observability`/`mcp-ops` (in the `mcp`
  namespace) validate the caller then re-exchange to a backend resource server
  (`obs-api`/`ops-api`, in the separate `apis` namespace). Only the backend APIs
  hold Kubernetes credentials, behind minimal RBAC in `prod` (obs-api: get/list
  pods + logs **and** get/list deployments; ops-api: patch deployments). obs-api
  accepts **two** actor chains (`expectedActorChains`/`chainMatchesAny`):
  `[obs-mcp, copilot]` (copilot reads directly) and `[obs-mcp, specialist, copilot]`
  (specialist reads while remediating).
- **Resource servers enforce, in order:** Bearer → JWT valid → required scope →
  `act` present → exact actor-chain (length + per-position SPIFFE-ID regex) →
  (privileged tier) `acr=mfa` step-up. The role gate (`sre` for `ops:write`)
  is enforced by Curity's procedure at exchange time.
- **MCP transport is Streamable HTTP** (`@modelcontextprotocol/sdk`), stateless.

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
      4 MB), so prefer the header once clients speak 2026-07-28.
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
      Node/TS, listens `:8090`, **same pod** as the gateway), which performs the RFC 8693
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
      GatewayClass are no longer needed for MCP authz.

22. **The LLM egress is a governed hop through agentgateway.** Both agents
    exchange the user token → `aud=llm-gateway`, `scope=llm:invoke` (one exchange,
    no shim — Azure is outside the trust domain) and call the gateway's
    OpenAI-compatible `/llm` route. The gateway holds the ONLY Azure key
    (`backendAuth.key: $AZURE_OPENAI_API_KEY`, header `api-key`), validates the JWT,
    and requires `llm:invoke`. `resourceType` is `openAI` (lowercase-o). The AI SDK
    client (`buildLlm` gateway mode) points `baseURL` at `.../llm` and passes the
    exchanged JWT as the OpenAI bearer. Agents no longer hold `AZURE_OPENAI_API_KEY`.

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

## Commands

`make help` prints the canonical list. The ones that matter day-to-day:

```bash
make tools-check     # preflight: node>=20, pnpm, docker, kind, kubectl, helm, mkcert
make demo            # stand up the full platform on a fresh KIND cluster
make seed-secrets    # interactive: web/mcp secrets, agent RSA keypairs, Azure LLM key
make images          # build all 7 app images and `kind load` them
make apply           # apply manifests + embed procedures + embed mkcert CA + run routing
make routing         # re-patch hostAliases + mkcert CA into app pods + Curity→agent aliases
make status          # pod health across every demo namespace
make smoke           # OBO + A2A + step-up/role-denial smoke tests
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
- [`docs/spiffe.md`](docs/spiffe.md) — SPIFFE identity scheme.
- [`docs/archive/`](docs/archive/) — historical build log: phase notes,
  `superpowers/` design specs, and the original implementation plan.
