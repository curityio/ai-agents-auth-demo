# Demo Guide

Everything needed to **run** and **present** the demo, end to end. If you've
never seen this project before, this is your starting point. For the system
design see [`architecture.md`](architecture.md); for module detail see
[`design.md`](design.md).

---

## 1. What this demonstrates

**The problem.** When an AI agent acts for a user — and calls other agents and
tools that touch production — *who is responsible* gets murky fast. A bearer
token forwarded blindly says nothing about which software handled it. If the
agent is compromised, a leaked user token is a skeleton key.

**The answer shown here.** Every hop authenticates as itself (SPIFFE), exchanges
the user's token for a hop-scoped one (RFC 8693), and records the chain of
acting agents in the token. The resource that finally touches the cluster can
prove *on whose behalf* and *through which agents* the request arrived, require
**MFA** for privileged actions, and deny based on **role** — all enforced by a
single authorization server (Curity), and all **visible in one distributed
trace**.

### Headline features

- OIDC login with a BFF that keeps the access token server-side.
- **RFC 8693 token exchange** at every agent/MCP hop, with the SPIFFE JWT-SVID
  as the `actor_token`.
- A **nested `act` chain** that grows by one verified workload per hop and is
  pinned per-position at each resource server.
- **Scope + audience narrowing** so each token is least-privilege for exactly
  one next hop.
- **RFC 9470 step-up**: privileged actions demand `acr=mfa`.
- **Role-based denial**: strong authentication ≠ authorization.
- **Istio Ambient mTLS** + Kubernetes RBAC as independent defense layers.
- **One trace** in Grafana showing user + workload identity at every span.
- **Governed LLM egress**: every model call is exchanged to `aud=llm-gateway`/
  `scope=llm:invoke` and routed through agentgateway's `/llm` route, which is
  the only place the upstream LLM provider credential lives. Which provider sits
  behind that route is configurable — see [`llm-providers.md`](llm-providers.md).

---

## 2. The storyline

Three users are seeded in Curity:

| User | Role | MFA | Outcome |
|---|---|---|---|
| **alice** | `sre`, `oncall` | on-demand step-up | Can read, and (after step-up MFA) restart *and* set image. The happy path. |
| **carol** | `oncall` | forced login MFA | Can read, restart, and scale — but `set_deployment_image` is **denied** at `mcp-ops` (`sre`-only). Authz is per-tool, not just per-tier. |
| **bob** | `developer` | forced login MFA | Can read; **denied** `ops:write` entirely even after a successful MFA. |

The target is the `prod` namespace, which holds two remediable sample
deployments named like real microservices: **`order-service`** and
**`checkout-service`**.

### Act 1 — Read (unprivileged)

> Alice logs in and asks the copilot: *"What's running in the prod namespace?"*

The copilot exchanges Alice's token for an `obs:read` token scoped to
`mcp-observability`, calls the MCP `list_pods` tool, which re-exchanges to
`obs-api`, which lists pods via read-only RBAC. **Expected:** a list of pods,
no MFA prompt. The trace shows `act=[obs-mcp, agentgateway, copilot]`,
`scope=obs:read`.

### Act 2 — Cross-tier remediation (privileged, with step-up)

> Alice asks: *"Roll order-service back to the previous image and restart it."*

The copilot recognizes a privileged write goal and delegates to
`agent-specialist` over **A2A**, forwarding Alice's natural-language goal
verbatim. The specialist is an **LLM agent** that plans across both tiers:

1. It exchanges for an `ops:write` token to `mcp-ops` (the **role + scope gate**
   fire here) and runs a **deterministic `acr=mfa` pre-check**. Alice
   authenticated with a password only, so the specialist surfaces a **401
   `insufficient_user_authentication` (`acr_values=mfa`)** *before the model ever
   runs*. The web app drives an **MFA step-up** at Curity; Alice enters her TOTP.
2. On retry the token carries `acr=mfa`. The specialist now also exchanges for an
   `obs:read` token to `mcp-observability`, opens both MCP toolsets, and lets the
   LLM work the goal: it **reads** the current state (`get_deployment`), **acts**
   (`set_deployment_image` to the prior tag, then `restart_deployment`), and
   **re-reads** to verify the rollout — re-exchanging at each hop to `obs-api` /
   `ops-api`.

**Expected:** an MFA challenge, then a summary of what changed. The trace shows
the specialist fanning out to **both** `mcp-observability` (read) and `mcp-ops`
(write): `act=[ops-mcp, agentgateway, specialist, copilot]` on the write hops
(`scope=ops:write`, `acr=mfa`) and
`act=[obs-mcp, agentgateway, specialist, copilot]` on the read hops
(`scope=obs:read`).

### Act 3 — Denial (authn ≠ authz)

> Bob logs in, MFAs successfully, and asks to restart `order-service`.

Bob's MFA *succeeds* — but the very first token exchange fails with
**`access_denied`** because Bob holds no write role (`sre`/`oncall`).
**Expected:** a clear "you authenticated, but you're not authorized" message. The
teaching point: authentication strength and authorization grant are different
things, decided in different places.

### Act 4 — Per-tool authorization (carol) — authz is finer than the tier

> Carol logs in (forced login MFA), restarts `order-service` successfully, then
> asks to *change its image*.

Carol holds `oncall`, so Curity grants her `ops:write` and the restart succeeds.
But when the specialist calls `set_deployment_image`, **`mcp-ops`** refuses it
with a legible role-denial — that tool is `sre`-only (`Config.setImageRequiredRoles`).
**Expected:** restart works; the image change comes back as a clear "requires the
`sre` role" message the specialist relays. The teaching point: the gateway grants
the *tier* (`ops:write`), but the fine-grained per-tool split is enforced
**downstream at the resource tier** — carol even *sees* `set_deployment_image` in
`tools/list` (the gateway lists all ops tools); it's the **call** that's denied.

---

## 3. Identity & trust flows 

Three identity planes are in play at once (see [`architecture.md`](architecture.md) §1):

- **Human** — Curity OIDC token; `sub=alice` survives unchanged through every
  exchange.
- **Workload** — each pod's SPIFFE JWT-SVID
  (`spiffe://demo.curity.local/ns/<ns>/sa/<sa>`), delivered by a `spiffe-helper`
  sidecar and presented as the `actor_token`. Show one with
  `kubectl -n agents exec deploy/agent-copilot -c spiffe-helper -- cat /run/spiffe/curity-actor.jwt`
  and decode it.
- **Assurance** — `acr`, escalated by MFA, required for `ops:write`.

The **trust anchors**: Curity verifies user tokens it issued, and verifies
SPIFFE `actor_token`s against SPIRE's JWKS fetched at runtime. Resource servers
trust only Curity's JWKS and a pinned actor chain. Transport is mTLS via Istio
Ambient.

---

## 4. Prerequisites

- Docker, `kind`, `kubectl`, `helm`, `mkcert`, `pnpm`, Node ≥ 22.
  Run `make tools-check` to verify.
- A **Curity developer license** — copy it to the repo root as `license.json`
  (gitignored). `make demo` will prompt and wait if it's missing.
- An **API key for one supported LLM provider** (`openai`, `anthropic`, `gemini`
  or `azure`) for the agent LLM — `make demo` prompts for it up front. Azure
  additionally needs `AZURE_OPENAI_ENDPOINT`. See
  [`llm-providers.md`](llm-providers.md).

---

## 5. Step-by-step execution

### 5.1 Stand up everything

```bash
make demo
```

`make demo` is now a single end-to-end command. It first gathers the only two
interactive inputs **up front** — it checks for `./license.json` (prompting you
to copy it in if absent) and prompts for the LLM provider API key (saved to a
gitignored `.demo.env`). Then it runs **unattended**:

`tools-check → kind-up → certs → platform → seed-secrets → images → apply`.

- **platform** installs Istio Ambient + edge gateway + SPIRE + observability, and
  first generates a **shared root CA** (`certs/shared-ca/`, gitignored) seeded into
  istiod (plug-in `cacerts`) and SPIRE (`disk` UpstreamAuthority) — both under one
  root. No extra steps on a fresh cluster.
- **seed-secrets** installs the license (`curity-license` from `./license.json`),
  the `web-secrets` (autogenerated `AUTH_SECRET` + the `web-app` client secret,
  which is the fixed demo value `Password1`), the LLM provider secret for the
  **gateway** (`agentgateway-llm` in ns `mcp`, key `LLM_API_KEY`, from
  `.demo.env`), the
  two agents' `private_key_jwt` RSA keypairs, and the two MCP
  client secrets (`Password1`). None of these prompt.
- **images / apply** build + load all images and apply every manifest, then wire
  pod routing.

### 5.2 Seed the alice, carol & bob accounts (the only manual step)

Curity's in-memory account store starts empty. The three demo users are created
**during the login flow** via the HTML Authenticator's "create account"
functionality — register alice, carol & bob and enrol TOTP for each per
[`curity-seed.md`](curity-seed.md) (§Accounts). The clients, scopes, and token
procedures all load from the configmap — only the **accounts** are seeded by
hand.

### 5.3 Drive the demo

`make demo` finishes by printing every browser-exposed URL — re-run `make urls`
any time to see it again:

```text
  ═══════════════════════════════════════════════════════════
   🌐  Browser-exposed URLs  —  all over HTTPS via the edge
  ═══════════════════════════════════════════════════════════

  Apps  —  open these in your browser
    Demo app (copilot UI)            https://app.localtest.me
    Curity Admin UI                  https://curity-admin.localtest.me/admin
    Grafana (OTel traces)            https://grafana.localtest.me

  Identity & metadata  —  inspect the OAuth / SPIFFE plumbing
    Curity OIDC discovery            https://curity.localtest.me/oauth/v2/oauth-anonymous/.well-known/openid-configuration
    Copilot client metadata (CIMD)   https://copilot.localtest.me/.well-known/oauth-client
    Specialist client metadata       https://specialist.localtest.me/.well-known/oauth-client
    mcp-ops resource metadata        https://mcp-ops.localtest.me/.well-known/oauth-protected-resource
    mcp-observability resource md    https://mcp-observability.localtest.me/.well-known/oauth-protected-resource
```

The **Apps** are click-to-use (the demo app needs alice/carol/bob seeded first,
§5.2 — register them through the app's login flow via the HTML Authenticator's
"create account" feature). The **Identity & metadata** URLs are live OAuth/SPIFFE
discovery documents — handy for showing what each hop fetches.

```bash
make status            # (optional) confirm pods are Ready across all namespaces
open https://app.localtest.me
```

Log in as **alice** and walk Acts 1–2 (read, then step-up remediation). Then log
in as **bob** for the role denial (Act 3), and **carol** for the per-tool split
(Act 4).

### 5.4 (Optional) Verify auth behavior headlessly

```bash
make smoke             # OBO + A2A + step-up/role-denial + LLM-gateway smoke tests
make smoke-llm         # LLM egress only: positive chat completion via /llm, a
                        # negative aud=mcp-gateway denial at the gateway, and a
                        # check that no agent pod holds the provider key
                        # (LLM_API_KEY or the legacy AZURE_OPENAI_API_KEY)
                        # (needs SMOKE_SUBJECT_TOKEN — a fresh access token for alice)
```

> **`SMOKE_SUBJECT_TOKEN` must carry `llm:invoke`.** The LLM beat exchanges the
> subject token down to `aud=llm-gateway`, which only works if the login token
> already holds `llm:invoke` (the web app requests `openid obs:read llm:invoke` at
> login; the MFA step-up re-auth keeps it). Grab the token *after* a normal alice
> login — an older token minted before the `llm:invoke` grant will fail the
> exchange with `invalid_scope`. See `docs/design.md` §3.6 for the full grant map.

---

## 6. Observability walkthrough

Open Grafana at **https://grafana.localtest.me** (anonymous Viewer). Use the
**Identity Flow** dashboard or Explore → Tempo → search the most recent trace.

What to point at in a single remediation trace:

- **One trace, many services, two tiers** — `web → agent-copilot →
  agent-specialist`, then the specialist fans out to **both**
  `mcp-observability → obs-api` (reads) **and** `mcp-ops → ops-api` (writes),
  plus `auth.token_exchange` spans against Curity.
- **`auth.sub=alice`** on every span — the human identity propagates intact.
- **`auth.act[]` grows** hop by hop and shows the specialist on *both* tiers.
  Every chain includes **`agentgateway`**, which inserts itself when the
  exchange-shim re-mints the token at the front door:
  `ops-api` carries `[mcp-ops, agentgateway, agent-specialist, agent-copilot]`
  and `obs-api` carries
  `[mcp-observability, agentgateway, agent-specialist, agent-copilot]`.
  (On the plain read path, where the copilot goes direct, the specialist is
  absent: `[mcp-observability, agentgateway, agent-copilot]`.)
- **Scope narrowing** on the `auth.token_exchange` spans
  (`auth.exchange.scope` vs `auth.exchange.issued_scope`) — `ops:write` to
  `mcp-ops`, `obs:read` to `mcp-observability`, from the same specialist.
- **`spiffe.id`** resource attribute differs per service — the workload plane.
- **`acr=mfa`** appears only after step-up; the pre-MFA attempt shows the
  specialist's step-up challenge *before* any LLM tool call.
- **`mcp.tool`** = `get_deployment` (read) interleaved with
  `set_deployment_image` / `restart_deployment` (write) — the inspect→act→verify loop.
- **The `/llm` span** — expand the trace for either agent's model call and find
  the `POST /llm/chat/completions` hop against `agentgateway`: agentgateway
  natively recognizes the LLM protocol and stamps the span with OTel GenAI
  semantic-convention attributes (`gen_ai.operation.name=chat`,
  `gen_ai.provider.name` (the configured provider, e.g. `azure`),
`gen_ai.request.model`,
  `gen_ai.usage.input_tokens` / `output_tokens`) — the only place in the system
  where model and token accounting appear. Note the gateway span itself carries
  **no `auth.*`**: those attributes come from `decorateSpanWithIdentity()`, which
  is our Node middleware and does not run inside the gateway. The user attribution
  for this hop is on the `auth.token_exchange` span immediately before it, which
  shows `audience=llm-gateway`, `issued_scope=llm:invoke` and `auth.sub=alice`
  on the agent's own span — with **no `act`-chain growth**, since the LLM provider
  sits outside the trust domain and there's nothing to nest.

**Try it: deny a non-`llm:invoke` caller.** Run `make smoke-llm` (needs
`SMOKE_SUBJECT_TOKEN` — a fresh access token for alice, see the script's usage
banner) to watch the gateway's `/llm` route reject a validly-signed
`aud=mcp-gateway` token — good enough for MCP, but missing `llm:invoke` — with
a 401/403 **before it ever reaches the LLM provider**. The same run confirms both
`LLM_API_KEY` and the legacy `AZURE_OPENAI_API_KEY` are absent from
`agent-copilot`'s pod env, i.e. the credential genuinely lives only at the gateway.

> Tempo retention is **30 minutes**. Query within ~25 minutes of driving the
> demo, or re-drive it — empty results are usually expiry, not a broken pipeline.

### 6.1 The same story in `kubectl logs`

Grafana is the analytic view. For a live audience the log plane is often the
better one: it needs no dashboard, survives Tempo's 30-minute retention, and
reads top-to-bottom. Every service prints a block per delegation event, stamped
with the time and the trace id (see `architecture.md` §7.1).

Tail the read path:

```bash
kubectl logs -n agents deploy/agent-copilot -f
kubectl logs -n mcp    deploy/mcp-observability -f
kubectl logs -n apis   deploy/obs-api -f
```

Point at the **`act` chain growing one position per hop** — `agent-copilot` →
`agent-copilot ▸ agentgateway` → `agent-copilot ▸ agentgateway ▸
mcp-observability` — with the same `trace` on every line. To follow one request
across all seven services at once:

```bash
TRACE=<trace id from any block>
for p in agents/agent-copilot mcp/mcp-observability apis/obs-api; do
  kubectl logs -n ${p%%/*} deploy/${p##*/} | grep -A 8 "$TRACE"
done
kubectl logs -n mcp deploy/agentgateway -c exchange-shim  | grep -A 8 "$TRACE"
kubectl logs -n mcp deploy/agentgateway -c agentgateway   | grep "trace.id=$TRACE"
```

**The strongest moment is a refusal.** Ask for a restart *before* completing
MFA and tail the specialist:

```bash
kubectl logs -n agents deploy/agent-specialist -f
```

Two `DENY` blocks appear milliseconds apart — Curity refusing `ops:write`
(`error: invalid_scope`), then the agent raising the RFC 9470 challenge
(`acr: html-form`, `acr required: mfa`). Complete the MFA and re-run: the same
request now completes under a **new trace** with no `DENY`. Presenting the two
side by side is the clearest demonstration in the demo that the gate is real and
that the system says *why* it refused.

Some things worth counting out loud while the logs are on screen:

- A completed restart mints **at least 11 tokens** — 1 at the copilot, 3 at the
  specialist, 6 at the exchange-shim (one per gateway `extAuthz` callout), 1 at
  `mcp-ops`. Every one is a separate narrowing.
- A plain read mints 5. The three identical shim blocks are `server/discover`,
  `tools/list` and `tools/call` — distinguishable by their span ids.
- The pre- and post-MFA attempts are **different traces**. That is inherent: the
  challenge round-trips through the browser, so the retry is a new request. They
  are joined only by `sub=alice` and adjacency in time.

> `OBO_LOG=off` silences these blocks. `AUTH_DEBUG=true` on `web` gates the
> `/inspect` viewer and `/api/dev/token`, **not** logging — Auth.js's own verbose
> output is `AUTHJS_DEBUG`, off by default, because it dumps the decoded ID token
> and every cookie on each login and drowns everything above.

---

## 7. Teardown

```bash
make clean             # delete the cluster + local artifacts (certs, node_modules, .turbo) + built demo images
# or, to recover from a wedged/ENOSPC cluster:
make reset             # delete cluster + reclaim docker build cache
```

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| 502 from `/api/agent` | Agent pod not ready or a wrong `*_URL`. `kubectl -n agents logs deploy/agent-copilot`. |
| `502 llm_unavailable` | The `aud=llm-gateway` exchange failed, or `agentgateway-llm` isn't seeded. Re-run `make seed-llm-secret`; check `kubectl -n mcp logs deploy/agentgateway`. |
| 401 at an MCP/API with `invalid_actor` | Curity can't reach the SPIRE OIDC Discovery Provider (`spire-spiffe-oidc-discovery-provider.spire-server`). Check the provider pod is Ready and the curity→spire-server hop is open. |
| Agent token exchange fails `invalid_client` | Curity can't dereference/verify the agent's CIMD doc. Check the Curity pod has a hostAlias for `copilot`/`specialist.localtest.me` (`make routing`) and that the mkcert CA is in its truststore (`make curity-truststore`); confirm `kubectl -n curity exec deploy/curity -- curl -s -o /dev/null -w '%{http_code}' https://copilot.localtest.me/.well-known/oauth-client` returns `200`. |
| 401 `insufficient_user_authentication` that never resolves | Step-up loop — check the web app's challenge handling and that TOTP is enrolled for the user. |
| 403 `act_chain_*` | The actor chain didn't match an `expectedActorChain`. Usually a redeploy left a pod on an old SVID — `kubectl rollout restart` the affected deployment. |
| OIDC redirect loop | `AUTH_URL` mismatch or empty `AUTH_SECRET`. Re-seed `web-secrets`. |
| Curity won't start | License missing/invalid. `kubectl -n curity logs deploy/curity`. |
| Pods can't reach Curity (`ECONNREFUSED`, or an MCP/API returns `invalid_token` with an empty reason) | A pod is missing the `curity.localtest.me` hostAlias — `make routing` not run (or only partially applied) after cluster recreation. Diagnose with `make routing-check`; fix with `make routing` (idempotent). |
| Empty Grafana traces | Tempo 30-min retention expiry — re-drive and query promptly. |
| TLS warnings in the browser | Expected — `make certs` no longer installs the root CA into the keychain by default. Run `make trust-ca` and restart the browser to trust it (undo with `mkcert -uninstall`). |
| Users gone after a Curity restart | `kubectl rollout restart deploy/curity` wipes the in-memory HSQLDB — re-seed per [`curity-seed.md`](curity-seed.md). |

---

## See also

- [`architecture.md`](architecture.md) · [`design.md`](design.md) ·
  [`curity-seed.md`](curity-seed.md) 
