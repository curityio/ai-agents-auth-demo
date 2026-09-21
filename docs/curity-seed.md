# Curity seed checklist

You set up Curity offline — this repo does **not** ship users or a license. Use
this checklist to bring your Curity instance to the state the demo expects.

The authoritative configuration lives in `k8s/curity/configmap.yaml` (a full XML
export) and the token-exchange procedure in
`k8s/curity/procedures/token-exchange.js`. For how the exchange policy works
(per-client audience/scope caps, the nested `act` chain, the role gate, step-up),
see [`design.md`](design.md) §3.2. This page is the human-facing checklist for
the bits you seed by hand (license + users).

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
- In-memory account manager — fine for the demo; swap for a real DB in production
- TOTP authenticator enrolled for each user (drives the RFC 9470 step-up for `ops:write`)

### Accounts
Create accounts alice, carol, and bob via HTML form authenticator during login process.
| Username | Password | Roles | MFA | Notes |
| --- | --- | --- | --- | --- |
| `alice` | (your choice) | `sre`, `oncall` | TOTP enrolled | Happy-path SRE. Can MFA up for `ops:write`; may use **all** ops tools incl. `set_deployment_image`. |
| `carol` | (your choice) | `oncall` | forced login MFA | On-call. Holds a write role, so gets `ops:write` (and can `restart_deployment`/`scale_deployment`), but `set_deployment_image` is denied downstream at **mcp-ops** (`sre`-only). She *sees* the tool in `tools/list` — the gateway lists all ops tools — the **call** is what's refused. |
| `bob` | (your choice) | `developer` | TOTP enrolled | Counter-example. Even after MFA, the role gate denies `ops:write` entirely (no write role). |

> Roles are assigned by `k8s/curity/procedures/add-roles.js` keyed on username, so the
> account **usernames must be exactly** `alice`, `carol`, `bob`. The write-tier gate
> (`token-exchange.js`) admits `ops:write` for `sre` **or** `oncall`; the finer
> `set_deployment_image` = `sre`-only split is enforced **downstream at `mcp-ops`**
> (`Config.setImageRequiredRoles`), not at the agentgateway — the gateway lists and
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

`make demo` already does all of this for you — it runs `seed-secrets` (license +
every workload secret + the agent keypairs), then `images` and `apply`. The only
step it can't automate is creating the **alice/carol/bob accounts** in Curity's
in-memory store; do that by hand during the login flow via the HTML Form
authenticator's "create account" feature (see §Accounts above) — open
`https://app.localtest.me`, register alice, carol & bob, then log in as Alice.

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
