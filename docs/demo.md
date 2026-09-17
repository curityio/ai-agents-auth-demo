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

Now click **Show chain** on the *On-behalf-of chain* card. Each row is one
token, diffed against the token it was exchanged from. The first row under
Alice's login token is the **model call** (`agent-copilot → agentgateway (/llm)`,
marked *leaf*): the same delegation narrowed to `aud=llm-gateway` and
`scope=llm:invoke` — `openid`, `obs:read` and `ops:write` struck through — with
the copilot nested into `act` and **no `may_act`**, because the LLM provider
sits outside the trust domain and nothing exchanges that token onward. That is
least privilege applied to the model itself, and it is why the vendor key never
has to exist in the agent. On the MCP row the scopes the copilot did *not* pass
on (`ops:write`, `llm:invoke`) stay struck through, the audience narrows to
`mcp-gateway`, and `act` gains exactly one workload. The `may_act` line on each
row names who may present that token next — and the green check on the *next*
row confirms that is who did. This is the delegation story as a picture; the
raw JWT is one click away under each row for anyone who wants the claims.

> The leaf rides with the flow it was minted in: the copilot only calls the
> model on the read path, so under a restart the leaf you see is the
> *specialist's* (`agent-specialist → agentgateway (/llm)`), minted from the
> `aud=agent-specialist` delegation token. If a flow is refused before it
> reaches the model (step-up, wrong role), no leaf is shown for it.

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
But when the specialist calls `set_deployment_image`, the call is refused with a
legible role-denial — that tool is `sre`-only. Two layers enforce it: agentgateway's
HTTP-layer `authorization` rule (keyed on `Mcp-Name`, answers a bare 403 that the
toolset turns into a factual tool result) and, authoritatively, **`mcp-ops`**
(`Config.setImageRequiredRoles`). **Expected:** restart works; the image change
comes back as a clear "not authorized" message the specialist relays. The
teaching point: the gateway grants the *tier* (`ops:write`), but the per-tool
split is finer than the tier — carol even *sees* `set_deployment_image` in
`tools/list`; it's the **call** that's denied.

Make the "she can see it" half visible with the **MCP Tools Visibility**
card (**Check tools**): the write-tier column lists all three ops tools for carol,
exactly as agentgateway's `tools/list` returned them for her token — with
`set_deployment_image` marked **needs sre** and a *Listed ≠ callable* note. That
marker is not hard-coded in the UI: `mcp-ops` publishes the tool's required roles
in its `tools/list` `_meta` (`io.curity.demo/required-roles`, from the same
`SET_IMAGE_REQUIRED_ROLES` config its call-time gate enforces), the gateway relays
it, and the specialist compares it with the caller's `roles`. Contrast with
the other two personas on the same card — bob's write column shows Curity's
`access_denied` from the exchange, and alice *before* MFA shows a step-up notice
because the specialist refused to even ask for an `ops:write` token without
`acr=mfa`. Nothing on that card is persona-specific: each verdict comes from the
same exchange a real remediation would perform.

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

Below the chat, three cards turn the identity plumbing into something the room
can see; all three are on-demand buttons so nothing is minted until you press:

| Card | Button | What it shows |
|---|---|---|
| **Workload identities** | *Show identities* | Each pod's live SPIFFE JWT-SVID — the `actor_token` of every exchange. |
| **On-behalf-of chain** | *Show chain* | One row per token in the last flow, diffed against its parent: dropped scopes struck through, the appended `act` actor highlighted, `may_act` naming the next permitted actor and the next row confirming it. The `aud=llm-gateway` token appears as a *leaf* row (no `may_act`) under the agent that called the model. |
| **MCP Tools Visibility** | *Check tools* | agentgateway's per-tier `tools/list` for *this* user, or the gate (step-up / Curity denial) that stopped the probe first. |

The same ledger, with copyable raw JWTs, is at `https://app.localtest.me/inspect`
(debug-only, `AUTH_DEBUG=true`) — useful on a projector when the chat is busy.

> **Spoken aside for the `may_act` row.** `act` is the audit trail (who *did*
> act); `may_act` is authorization (who *may* act next). The copilot mints the
> specialist's token, so it holds a copy — and could try to spend that delegation
> itself. If it does, Curity refuses:
> `actor … is not authorized by the subject token may_act (…)`. That refusal is
> the "prove it" moment: the chain isn't just recorded, it's constrained.

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

### 6.2 Log tap reference — one command per workload

§6.1 tails the three services that tell the story. This is the exhaustive list,
for when you need a specific hop. All of it assumes `alias k=kubectl`.

Selecting by `-l app=…` rather than `deploy/…` means the command survives a
rollout — after `make images` reloads a `:dev` image and you restart the
deployment, the same line follows the new pod.

```bash
# ── the request path, in order ──────────────────────────────────────────────
k -n web    logs -f -l app=web                             # BFF: login, session cookie, user token
k -n agents logs -f -l app=agent-copilot                   # exchange #1 → aud=mcp-gateway, obs:read
k -n agents logs -f -l app=agent-specialist                # cross-tier LLM agent (restart flow)
k -n mcp    logs -f -l app=agentgateway -c agentgateway    # JWT validation, tier authz, tools/list filter, /llm
k -n mcp    logs -f -l app=agentgateway -c exchange-shim   # the extAuthz OBO hop (same pod)
k -n mcp    logs -f -l app=mcp-observability               # re-exchange → obs-api
k -n mcp    logs -f -l app=mcp-ops                         # re-exchange → ops-api (+ set_deployment_image role gate)
k -n apis   logs -f -l app=obs-api                         # K8s reads: pods, logs, deployments
k -n apis   logs -f -l app=ops-api                         # K8s writes: patch deployments
k -n curity logs -f -l app=curity                          # the sole token issuer
```

**`agentgateway` is the one workload that needs an explicit `-c`.** `kubectl`
defaults to the *first* container in the pod spec. For every other workload here
that happens to be the app container, but the gateway pod lists `exchange-shim`
first — so omitting `-c` silently tails the shim while you believe you are
reading the gateway. Both are listed above because they are two different
things: the gateway logs the authorization decision, the shim logs the token it
minted in response. Either one alone is half a hop.

SPIFFE sidecars — SVID rotation, and the first place to look when a workload
cannot authenticate itself:

```bash
k -n web    logs -f -l app=web               -c spiffe-helper
k -n agents logs -f -l app=agent-copilot     -c spiffe-helper
k -n agents logs -f -l app=agent-specialist  -c spiffe-helper
k -n mcp    logs -f -l app=agentgateway      -c spiffe-helper
k -n mcp    logs -f -l app=mcp-observability -c spiffe-helper
k -n mcp    logs -f -l app=mcp-ops           -c spiffe-helper
k -n apis   logs -f -l app=obs-api           -c spiffe-helper
k -n apis   logs -f -l app=ops-api           -c spiffe-helper
```

A whole tier in one pane. `--prefix` stamps each line with its pod and
container, which is what makes an interleaved stream readable:

```bash
k -n agents logs -f --prefix -l 'app in (agent-copilot,agent-specialist)'
k -n apis   logs -f --prefix -l 'app in (obs-api,ops-api)'
k -n mcp    logs -f --prefix --all-containers --max-log-requests 10 \
     -l 'app in (agentgateway,mcp-ops,mcp-observability)'
```

`--max-log-requests` is **required** on that last one, not decorative: the `mcp`
tier is 7 containers across 3 pods and `kubectl` refuses to follow more than 5
streams by default (`error: you are attempting to follow 7 log streams…`).

Every refusal across the mesh in the last ten minutes — `-l app` here is an
existence selector, matching any pod carrying the label at all:

```bash
for ns in web agents mcp apis; do
  k -n $ns logs --prefix --all-containers --since=10m -l app --ignore-errors | grep DENY
done
```

Two caveats worth knowing before you need them. A label selector reads only from
*live* pods, so a CrashLooped container's evidence is not reachable this way —
`--previous` needs an explicit pod name. And the `trace` field on every OBO block
is the join key across all of these panes (and into Tempo); if it is missing
entirely, that is itself the diagnosis — an uninstrumented server emits no span
rather than a zeroed one (`architecture.md` §7.1).

### 6.3 Reading a workload's JWT-SVID

The SVID is what every workload presents as the `actor_token` in its RFC 8693
exchange — it is the machine half of the delegation, the thing that makes `act`
trustworthy. Showing one on screen answers "how does Curity know this really is
the copilot?" better than any slide.

Every workload writes it to the **same path**, `/run/spiffe/curity-actor.jwt`,
set in two places that must agree: the `spiffe-helper` sidecar's
`jwt_svid_file_name` (which writes it) and the app's `SPIFFE_SVID_PATH` env
(which reads it).

```bash
k -n agents exec deploy/agent-copilot -c agent -- cat /run/spiffe/curity-actor.jwt
```

Decoded — the app containers are Node images, so the tidiest version decodes
in-pod and needs nothing installed locally:

```bash
k -n agents exec deploy/agent-copilot -c agent -- node -e \
  "const t=require('fs').readFileSync(process.env.SPIFFE_SVID_PATH,'utf8').trim();
   console.log(JSON.stringify(JSON.parse(Buffer.from(t.split('.')[1],'base64url')),null,2))"
```

```json
{
  "aud": ["https://curity.localtest.me/oauth/v2/oauth-token"],
  "exp": 1786610611,
  "iat": 1786610311,
  "iss": "https://oidc-discovery.demo.curity.local",
  "sub": "spiffe://demo.curity.local/ns/agents/sa/agent-copilot"
}
```

Three things to point at. `sub` is the SPIFFE ID that `token-exchange.js` matches
against `allowedActors` and that lands in the next token's `act`. `aud` is
Curity's token endpoint — the SVID is audience-bound **at fetch time** by the
`spiffe-helper` config, not by the `ClusterSPIFFEID` (§`docs/spiffe.md`). `iss`
is SPIRE's OIDC discovery provider, whose JWKS the exchange procedure fetches at
runtime, which is why a cluster rebuild or key rotation needs no snapshot step.

To decode locally instead, pad the base64url yourself — a bare
`base64 -d` fails on macOS, and jq's `@base64d` does not accept the URL alphabet:

```bash
k -n agents exec deploy/agent-copilot -c agent -- cat /run/spiffe/curity-actor.jwt \
  | jq -Rr 'split(".")[1]|gsub("-";"+")|gsub("_";"/")|.+("="*((4-(length%4))%4))|@base64d' | jq .
```

Every workload's identity and time-to-expiry in one sweep — a good way to show
that these are short-lived and continuously rotated, not provisioned secrets:

```bash
printf '%s\n' web:web:web agents:agent-copilot:agent agents:agent-specialist:agent \
  mcp:agentgateway:exchange-shim mcp:mcp-observability:mcp mcp:mcp-ops:mcp \
  apis:obs-api:api apis:ops-api:api |
while IFS=: read -r ns app c; do
  printf '%-20s ' "$app"
  k -n "$ns" exec "deploy/$app" -c "$c" -- cat /run/spiffe/curity-actor.jwt 2>/dev/null \
    | jq -Rr 'split(".")[1]|gsub("-";"+")|gsub("_";"/")|.+("="*((4-(length%4))%4))|@base64d' \
    | jq -r --argjson now "$(date +%s)" '"\(.sub)  exp in \(.exp-$now)s"'
done
```

```
web                  spiffe://demo.curity.local/ns/web/sa/web  exp in 214s
agent-copilot        spiffe://demo.curity.local/ns/agents/sa/agent-copilot  exp in 287s
agent-specialist     spiffe://demo.curity.local/ns/agents/sa/agent-specialist  exp in 292s
agentgateway         spiffe://demo.curity.local/ns/mcp/sa/agentgateway  exp in 106s
mcp-observability    spiffe://demo.curity.local/ns/mcp/sa/mcp-observability  exp in 146s
mcp-ops              spiffe://demo.curity.local/ns/mcp/sa/mcp-ops  exp in 225s
obs-api              spiffe://demo.curity.local/ns/apis/sa/obs-api  exp in 102s
ops-api              spiffe://demo.curity.local/ns/apis/sa/ops-api  exp in 171s
```

The 5-minute lifetime is why nothing caches these: `spiffe-helper` rewrites the
file and every exchange re-reads it. Watch a rotation with
`k -n agents logs -f -l app=agent-copilot -c spiffe-helper` — `JWT SVID updated`.

Two exec-specific gotchas:

- **`agentgateway` must be read through `-c exchange-shim`.** The gateway
  container is a minimal Rust image with no `cat` and no shell (`exec failed:
  "cat": executable file not found in $PATH`). The shim shares the same
  `/run/spiffe` volume, so it reads the identical file — which is also precisely
  why the shim exists at all (§`CLAUDE.md` #21: the gateway's CEL cannot read a
  rotating file, so the exchange runs in a co-located sidecar).
- **The file is mode `0600` owned by uid 1000 (`node`).** `spiffe-helper` ≤ 0.11.0
  has no permission override, so the app containers run as `runAsUser: 1000` to
  match. Exec'ing as any other user gets `Permission denied`.

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
