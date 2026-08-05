# ai-agents-auth-demo

End-to-end demo of **authentication and authorization for AI agents** on
Kubernetes. A DevOps/SRE copilot reads observability data and restarts
workloads on a user's behalf — and every hop is authenticated, least-privilege,
MFA-gated where it matters, and fully traceable.

Built with:

- **Curity Identity Server** — the sole OAuth/OIDC token issuer.
- **SPIFFE / SPIRE** — per-workload cryptographic identity (JWT-SVIDs).
- **Istio Ambient Mesh** — transparent ztunnel L4 mTLS for in-mesh traffic.
- **One shared root CA** — istiod (Istio plug-in `cacerts`) and SPIRE (disk
  `UpstreamAuthority`) run intermediates under a single cluster root, so all
  mesh certs and SVIDs chain to one trust anchor.
- **Vercel AI SDK** (TypeScript) agents; **A2A** for agent-to-agent calls; **MCP**
  (Streamable HTTP) for tool invocation.
- **agentgateway** — a standalone MCP front door (JWT + per-tier scope authz +
  `tools/list` filtering) whose co-located `exchange-shim` sidecar runs the
  per-backend RFC 8693 OBO exchange for every tool call. It is **also the LLM
  egress gateway**: both agents exchange for `aud=llm-gateway`/`scope=llm:invoke`
  and call its OpenAI-compatible `/llm` route, which holds the only Azure OpenAI
  key in the system — the agents never possess it.
- **OpenTelemetry → Tempo → Grafana** — identity-decorated distributed tracing.
- Modern OAuth standards: **RFC 8693** (token exchange), **RFC 9470** (step-up),
  **RFC 9728** (protected-resource metadata), and **CIMD** (Client ID Metadata
  Documents) + **RFC 7523** `private_key_jwt` — the agents authenticate as
  ephemeral clients with no shared secret.

## The idea in one paragraph

The user logs in once. Each agent and tool authenticates as *itself* with a
SPIFFE identity and **exchanges** the user's token (RFC 8693) for a new token
scoped to exactly the next hop — recording itself in a nested `act` chain as it
goes. The service that finally touches the cluster can prove on whose behalf and
through which agents the request arrived, require MFA for privileged actions,
and deny by role. Three identity planes — **human** (OIDC), **workload**
(SPIFFE), and **assurance** (MFA) — enforced together, visible in one trace.

```
Browser ─https─▶ web (BFF) ─user token─▶ agent-copilot ─┬─ MCP ─▶ agentgateway ─▶ mcp-observability ─▶ obs-api ─▶ K8s
                                                        ├─ LLM ─▶ agentgateway ─▶ Azure OpenAI
                                                        └─ A2A ─▶ agent-specialist ─┬─ MCP ─▶ agentgateway ─▶ mcp-ops          ─▶ ops-api ─▶ K8s
                                                                                    ├─ MCP ─▶ agentgateway ─▶ mcp-observability ─▶ obs-api ─▶ K8s
                                                                                    └─ LLM ─▶ agentgateway ─▶ Azure OpenAI
              agentgateway = MCP front door (aud=mcp-gateway; per-tier scope authz + tools/list filter; extAuthz→exchange-shim OBO hop)
                           + LLM egress   (/llm; aud=llm-gateway + scope=llm:invoke; injects the only Azure key — no shim, no act-chain)
              every agent/MCP hop ⇄ Curity (RFC 8693 exchange, SPIFFE actor_token)
```

![System topology: browser → istio-ingress → web (BFF) → agent-copilot, fanning out via MCP to mcp-observability/obs-api (read path) and via A2A to agent-specialist → mcp-ops/ops-api (privileged path), with SPIRE issuing JWT-SVIDs and Curity performing RFC 8693 token exchange at every hop.](docs/architecture.jpg)

See [`docs/architecture.md`](docs/architecture.md) for the full picture.

## Prerequisites (macOS)

You need **Docker running** (Docker Desktop or OrbStack), a few CLIs, a Curity
developer license, and an Azure OpenAI endpoint/key for the agent LLM.

```bash
# 1. CLIs via Homebrew (Node 22+ is required; the rest are tools the Makefile drives).
brew install node kind kubectl helm mkcert

# 2. pnpm — NO separate install. It ships with Node via corepack:
corepack enable          # provisions the repo-pinned pnpm (9.15.0)

# 3. Verify the toolchain (node>=20, pnpm, docker, kind, kubectl, helm, mkcert):
make tools-check
```

Two things `make tools-check` can't check for — have them ready before `make demo`:

- **Curity developer license** → save it as `./license.json` at the repo root (gitignored).
- **Azure OpenAI** endpoint + API key — the agents' reasoning runs on it, so
  without it they can't respond. The key is seeded **only into the agentgateway**
  (`agentgateway-llm` secret, ns `mcp`); the agents reach Azure through the
  gateway's `/llm` route and never hold the key themselves. `make demo` prompts
  for these (via `make seed-secrets` → `seed-llm-secret`).

`make demo` generates the local mkcert CA (via `make certs`) but, by default,
does **not** register it in your macOS keychain / browser trust store — so the
browser will warn on `https://app.localtest.me` (safe to proceed for a localhost
demo). The in-cluster TLS works regardless. To trust the CA and silence the
warnings, run `make trust-ca` (undo anytime with `mkcert -uninstall`).

## Quick start

```bash
# 1. Clone the repo and cd into it:
git clone https://github.com/Curity-PS/ai-agents-auth-demo.git
cd ai-agents-auth-demo

# 2. Put your Curity license at the repo root (gitignored); make demo will
# otherwise prompt and wait for it:
cp /path/to/your/curity-license.json ./license.json

make demo            # one command, end to end. Prompts up front for the license
                     # file + Azure OpenAI endpoint/key, then runs unattended:
                     # kind + Istio Ambient + SPIRE + observability, seeds every
                     # secret, builds/loads images, applies manifests, wires routing.

# make demo finishes by printing every browser-exposed URL (app, Curity admin,
# Grafana, plus the OAuth/SPIFFE metadata endpoints). Re-print anytime:
make urls

# The ONLY manual step left: create the alice, carol & bob user accounts (+ TOTP) in
# Curity when running the login flow via the HTML Authenticator create account feature —
# see docs/curity-seed.md (§Accounts).:
open https://app.localtest.me
```

The complete runbook and presenter script is in [`docs/demo.md`](docs/demo.md).

## Common workflows

```bash
# Day-to-day cluster ops
make urls            # print every browser-exposed URL (apps + metadata endpoints)
make status          # pod health across all namespaces
make routing         # re-wire pod→Curity routing (after cluster recreation)
make doctor          # Docker + KIND disk audit
make clean           # tear it all down
make reset           # tear down + reclaim docker build cache (ENOSPC recovery)

# One-time per clone: install the pre-commit guard that blocks accidentally
# committing the Curity license or the LLM API key.
make hooks
```

`make help` lists every target. The Makefile is the single authoritative
lifecycle entry point — environment setup, platform install, deploy, validation,
and teardown.

## Repository layout

```
apps/
  web/                  # Next.js BFF + Auth.js (Curity OIDC)
  agent-copilot/        # front-line agent (Vercel AI SDK); CIMD ephemeral client
  agent-specialist/     # privileged agent; A2A server; CIMD ephemeral client
  mcp-observability/    # read-tier MCP (thin client → obs-api)
  mcp-ops/              # privileged-tier MCP (thin client → ops-api; sre-only set_deployment_image)
  obs-api/              # read resource server (pods/logs in prod, RBAC)
  ops-api/              # privileged resource server (restart deployments, RBAC)
  exchange-shim/        # agentgateway extAuthz sidecar; runs the per-backend OBO exchange
packages/
  auth-curity/          # JWT verify + RFC 8693 exchange + CIMD + identity spans
  agent-runtime/        # shared LLM plumbing: buildLlm + MCP→AI-SDK toolset adapter
  spiffe/               # reads JWT-SVIDs from the spiffe-helper sidecar
  otel-bootstrap/       # OTel SDK wiring + spiffe.id resource attribute
  a2a-helpers/          # A2A client/server + step-up error carrier
k8s/
  curity/ spire/ istio/ observability/ workloads/ prod/ kind/
docs/                   # architecture, design, demo, curity-seed
scripts/                # bootstrap + smoke-test shell scripts
Makefile
```

## Documentation

| Doc | What it covers |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | System overview, topology, the two OBO chains, trust model, security boundaries. |
| [`docs/design.md`](docs/design.md) | Module breakdown, interfaces, workflows, configuration & deployment model, decisions. |
| [`docs/demo.md`](docs/demo.md) | storyline, step-by-step execution, observability walkthrough, troubleshooting. |
| [`docs/curity-seed.md`](docs/curity-seed.md) | Offline Curity setup checklist (clients, scopes, users, procedure). |

## Troubleshooting

See the table in [`docs/demo.md`](docs/demo.md#8-troubleshooting). The most
common gotchas: re-run `make routing` after recreating the cluster, and re-seed
Curity users after any `rollout restart deploy/curity`.

## License

Apache-2.0. See [LICENSE](LICENSE).
