# Curity seed checklist

You set up Curity offline — this repo does **not** ship users or a license. Use
this checklist to bring your Curity instance to the state the demo expects.

The authoritative configuration lives in `k8s/curity/configmap.yaml` (a full XML
export) and the token-exchange procedure in
`k8s/curity/procedures/token-exchange.js`. For how the exchange policy works
(per-client audience/scope caps, the nested `act` chain, the role gate, step-up),
see [`design.md`](design.md) §3.2. This page is the human-facing checklist for
the bits that come from outside the repo (the license) and for what the automatic
user seed puts into Curity (§Accounts).

---

## What the demo expects

### Image / version
- Curity Identity Server — the deployment pulls `curity.azurecr.io/curity/idsvr:latest`;
  11.4.0 is the version the configmap (incl. the Token Issuance Authorizer) was
  validated against.
- Developer license file (`license.json`).
- An LLM provider API key (seeded into the agentgateway only — see [`llm-providers.md`](llm-providers.md)).

### Endpoints
- Issuer / base URL: `https://curity.localtest.me/oauth/v2/oauth-anonymous`
- Admin UI: `https://curity-admin.localtest.me/admin` — exposed through the edge
  gateway (re-encrypted to Curity's HTTPS admin listener on :6749), so no
  port-forward is needed.

### Scopes
| Scope | Purpose |
| --- | --- |
| `openid` | OIDC base |
| `profile` | OIDC base |
| `obs:read` | Read-only observability MCP |
| `ops:write` | Restart / scale / set image on deployments (privileged). Bound to the `require-mfa-for-privileged` ACR Token Issuance Authorizer, so Curity will not mint it below `acr=mfa` ([`design.md`](design.md) §3.2.1). |
| `llm:invoke` | The user-delegated LLM-egress scope both agents narrow to (`aud=llm-gateway`) for every model call through agentgateway's `/llm` route. Must be granted at every narrowing hop — see [`design.md`](design.md) §3.6. |

### Clients
| Client ID | Type | Auth method | Grants | Redirect URIs | Notes |
| --- | --- | --- | --- | --- | --- |
| `web-app` | OIDC confidential | client_secret_basic | authorization_code, refresh_token | `https://app.localtest.me/api/auth/callback/curity` | PKCE S256 required. Scopes: `openid obs:read ops:write llm:invoke`. Access-token TTL 600 s (the header pill counts it down). Secret is the fixed demo value `Password1`. |
| `https://copilot.localtest.me/.well-known/oauth-client` | CIMD ephemeral | private_key_jwt | token-exchange | n/a | `client_id` is the self-hosted metadata URL; `actor_token` SPIFFE ID `spiffe://demo.curity.local/ns/agents/sa/agent-copilot`. Not a config-backed client — see `<ephemeral-client>`. |
| `https://specialist.localtest.me/.well-known/oauth-client` | CIMD ephemeral | private_key_jwt | token-exchange | n/a | as above; `actor_token` SPIFFE ID `spiffe://demo.curity.local/ns/agents/sa/agent-specialist` |
| `mcp-gateway` | confidential | client_secret_basic | token-exchange | n/a | Used by agentgateway's `exchange-shim`. Audiences `mcp-observability` + `mcp-ops`, scopes `obs:read` + `ops:write`; `actor_token` SPIFFE ID `spiffe://demo.curity.local/ns/mcp/sa/agentgateway`. Secret `Password1`. |
| `mcp-observability` | confidential | client_secret_basic | token-exchange | n/a | Audience `obs-api`, scope `obs:read`; actor `…/ns/mcp/sa/mcp-observability`. Secret `Password1`. |
| `mcp-ops` | confidential | client_secret_basic | token-exchange | n/a | Audience `ops-api`, scope `ops:write`; actor `…/ns/mcp/sa/mcp-ops`. Secret `Password1`. |

`llm-gateway` is an **audience only** — agentgateway validates `aud=llm-gateway` +
`llm:invoke` on its `/llm` route but performs no exchange there, so it needs no
client.

### Look and feel
The login, create-account, TOTP and consent pages carry the web app's dark palette.
That theme is **configuration**, not template overrides: the configmap's
`<themes><default-theme>` block holds two Base64 leaves embedded from
`k8s/curity/theme/theme.css` (CSS custom-property overrides) and `custom.css`
(free CSS) by `make curity-theme` (run by `make apply`), plus the template
variables that switch on Curity's built-in dark body variant. Edit the CSS files,
never the Base64. Anything changed in the Admin UI's **System → Look and Feel**
lives only in CDB and is overwritten by the next `make apply` — use its *Download
CSS* and paste into the tracked files instead.

### Authenticators
- HTML Form authenticator
- Account manager on Curity's bundled file-based HSQLDB, seeded by an init
  container at every boot (§Accounts) — fine for the demo; swap for a real DB in production
- TOTP authenticator enrolled for each user (drives the RFC 9470 step-up for `ops:write`)

### Accounts
The three accounts are **seeded automatically**. `make seed-users` (run by
`make seed-secrets` / `make demo`) writes a gitignored `.demo-users.env` — passwords
default to `Password1`, and each persona gets a random TOTP secret generated once —
and publishes it as the `curity-demo-users` Secret. The Curity pod's init container
(`scripts/curity-users-init.sh`) then writes the accounts, password hashes and TOTP
enrolments straight into the file-based HSQLDB before the server opens it, so they
are back after every restart or rebuild with the **same** secrets. Add the three
otpauth URIs to your authenticator app once: `make demo` ends by printing a card per
persona (username, role, password, URI + QR code), and `make users` re-prints them
without touching the cluster (`brew install qrencode` for scannable codes). To change
a password, edit `.demo-users.env` and re-run `make seed-users`. The **persona sheet**
below is what the seed writes.

| Username | Display name | Email | Who they are | Password | Roles | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| `alice` | Alice Andersson | `alice@demo.curity.local` | SRE lead | `Password1` | `sre` | Happy-path SRE. `ops:write` triggers the on-demand RFC 9470 `acr=mfa` challenge; after it she may use **all** ops tools incl. `set_deployment_image`. `sre` alone passes both gates — she deliberately has no second role. |
| `bob` | Bob Bergström | `bob@demo.curity.local` | Backend developer, owns `order-service` | `Password1` | `developer` | Counter-example. Can read his own service's logs (`obs:read`); a restart steps him up like everyone else and is THEN refused by the role gate — he proved MFA and still gets no `ops:write`. Nothing reads `developer`; it exists to be *not* a write role. |
| `carol` | Carol Carlsson | `carol@demo.curity.local` | On-call engineer this week | `Password1` | `oncall` | Holds a write role, so after the step-up gets `ops:write` (and can `restart_deployment`/`scale_deployment`), but `set_deployment_image` is denied downstream at **mcp-ops** (`sre`-only). She *sees* the tool in `tools/list` — the gateway lists all ops tools — the **call** is what's refused. "This week" is the talking point: `oncall` is a role attached to a rotation, not a person. |

All three come **pre-enrolled for TOTP** (the step-up needs it) with the secrets in
`.demo-users.env`, and **none is forced through it at login**. bob and carol used to be (`requireSecondFactor` in `add-roles.js`), but a
second factor run as an authentication *action* leaves the token's `acr` at the
primary authenticator's `html-form`, so the `ops:write` TIA stripped the scope and
the step-up fired anyway — a TOTP typed twice for nothing. Everyone now steps up
exactly once, at the first privileged action, via the `totp-authn` authenticator
whose ACR is `mfa`.

The signed-out landing page shows this same sheet as three *Sign in as …* cards
(`apps/web/src/lib/personas.ts`, roles pinned to `add-roles.js` by a test). Each
button passes the username as `login_hint`, so Curity's form opens pre-filled.

> Roles are assigned by `k8s/curity/procedures/add-roles.js` keyed on username, so the
> account **usernames must be exactly** `alice`, `carol`, `bob` —
> `scripts/test-seed-curity-users.sh` pins the seeded usernames to that procedure. The write-tier gate
> (`token-exchange.js`) admits `ops:write` for `sre` **or** `oncall`; the finer
> `set_deployment_image` = `sre`-only split is enforced **downstream at `mcp-ops`**
> (`Config.toolRequiredRoles`), not at the agentgateway — the gateway lists and
> allows all ops tools for any `ops:write` caller.

### Claims wiring (minimum)
- Standard OIDC profile claims (`sub`, `email`, `name`).
- Custom claim `roles` mapping the account's roles into the access token (the
  token-exchange role gate admits `ops:write` for `sre` **or** `oncall`).
- The `acr` claim is stamped procedurally at login (`authorization-code.js`,
  `acr-passthrough`) and re-emitted on every exchange — see [`design.md`](design.md) §7.
- The user access token is narrowed to `aud=agent-copilot` by `authorization-code.js`
  (the configured `web-app` audience shapes only the id_token, which OIDC requires
  to include the client_id); each exchanged token names exactly one downstream
  audience (`mcp-gateway` / `agent-specialist` / `llm-gateway` / `mcp-observability`
  / `mcp-ops` / `obs-api` / `ops-api`).

These are already encoded in `k8s/curity/configmap.yaml` and the procedures
under `k8s/curity/procedures/`; this list is the conceptual checklist behind
that config. The token-exchange procedure validates the `subject_token`,
verifies the `actor_token` against SPIRE's JWKS (fetched at runtime), narrows scope +
audience, nests the `act` chain, stamps `may_act`, and enforces the write-role gate
(`sre` **or** `oncall`). The `acr=mfa` requirement on `ops:write` is configuration,
not procedure code: the ACR Token Issuance Authorizer bound to the scope
([`design.md`](design.md) §3.2.1).

---

## Cluster-side seeding

`make demo` does all of this for you — it runs `seed-secrets` (license + demo users
+ every workload secret + the agent keypairs), then `images` and `apply`. Nothing is
created by hand: the alice/carol/bob accounts and their TOTP enrolments are written
by the Curity pod's init container from the `curity-demo-users` Secret (§Accounts).
Open `https://app.localtest.me` and sign in as alice with `Password1`.

`make seed-secrets` does **not** prompt for client secrets: the web and MCP
clients use the fixed demo value `Password1` (whose hash is committed in the
configmap), the license comes from `./license.json`, and the LLM provider key is
read from `.demo.env` (it only prompts when that file is absent). The two CIMD
agents authenticate with `private_key_jwt`, so instead of a secret each gets a
generated RSA keypair (`make seed-agent-key` / `seed-specialist-key`) stored in
the `agent-*-curity` secrets.

### Re-seeding one secret by hand

The individual `make seed-*` targets cover this, but the raw `kubectl`
equivalents are below for reference (e.g. rotating a key out-of-band):

```bash
# License (make seed-license reads it from ./license.json)
kubectl -n curity create secret generic curity-license \
  --from-file=license.json=./license.json

# Web app secrets (the demo uses the fixed client secret "Password1")
kubectl -n web create secret generic web-secrets \
  --from-literal=AUTH_SECRET=$(openssl rand -hex 32) \
  --from-literal=CURITY_CLIENT_SECRET=Password1

# LLM provider key — the gateway holds the ONLY key. Both agents reach the
# provider through agentgateway's /llm route (aud=llm-gateway) and no longer
# hold the key.
kubectl -n mcp create secret generic agentgateway-llm \
  --from-literal=LLM_API_KEY=<key>
```

The full set of token-exchange clients (the two CIMD agents via the
`<ephemeral-client>` block, plus `mcp-gateway`, `mcp-ops`, `mcp-observability`)
and the terminal audiences (`obs-api`, `ops-api`, `llm-gateway`) is defined in
`k8s/curity/configmap.yaml`.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| 502 from `/api/agent` | Agent pod not ready, or `MCP_OBSERVABILITY_URL` wrong. `kubectl -n agents logs deploy/agent-copilot` |
| 401 from MCP at the agent | User access token doesn't have `obs:read` scope; check `/api/whoami` |
| OIDC redirect loop | `AUTH_URL` mismatch or `AUTH_SECRET` empty |
| Curity won't start | License missing or invalid; `kubectl -n curity logs deploy/curity` |
| TLS warnings in the browser | Expected by default — the root CA is not added to the keychain. Run `make trust-ca` and restart the browser to trust it (undo with `mkcert -uninstall`) |
