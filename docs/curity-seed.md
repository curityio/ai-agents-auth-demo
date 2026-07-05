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
- Curity Identity Server
- Developer license file (`license.json`).
- LLM API key

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
| `ops:write` | Restart / scale deployments (privileged) |

### Clients
| Client ID | Type | Auth method | Grants | Redirect URIs | Notes |
| --- | --- | --- | --- | --- | --- |
| `web-app` | OIDC confidential | client_secret_basic | authorization_code, refresh_token | `https://app.localtest.me/api/auth/callback/curity` | PKCE S256 required. Scopes: `openid profile obs:read ops:write` |
| `https://copilot.localtest.me/.well-known/oauth-client` | CIMD ephemeral | private_key_jwt | token-exchange | n/a | `client_id` is the self-hosted metadata URL; `actor_token` SPIFFE ID `spiffe://demo.curity.local/ns/agents/sa/agent-copilot`. Not a config-backed client — see `<ephemeral-client>`. |
| `https://specialist.localtest.me/.well-known/oauth-client` | CIMD ephemeral | private_key_jwt | token-exchange | n/a | as above; `actor_token` SPIFFE ID `spiffe://demo.curity.local/ns/agents/sa/agent-specialist` |

### Authenticators
- HTML Form authenticator
- In-memory account manager — fine for the demo; swap for a real DB in production
- TOTP authenticator enrolled for each user (drives the RFC 9470 step-up for `ops:write`)

### Accounts
Create accounts alice, carol, and bob via HTML form authenticator during login process.
| Username | Password | Roles | MFA | Notes |
| --- | --- | --- | --- | --- |
| `alice` | (your choice) | `sre`, `oncall` | TOTP enrolled | Happy-path SRE. Can MFA up for `ops:write`; may use **all** ops tools incl. `set_deployment_image`. |
| `carol` | (your choice) | `oncall` | TOTP enrolled | On-call. Holds a write role, so gets `ops:write`, but the agentgateway per-tool rule allows only `restart_deployment`/`scale_deployment` — `set_deployment_image` is denied (needs `sre`). |
| `bob` | (your choice) | `developer` | TOTP enrolled | Counter-example. Even after MFA, the role gate denies `ops:write` entirely (no write role). |

> Roles are assigned by `k8s/curity/procedures/add-roles.js` keyed on username, so the
> account **usernames must be exactly** `alice`, `carol`, `bob`. The write-tier gate
> (`token-exchange.js`) admits `ops:write` for `sre` **or** `oncall`; the agentgateway
> then splits ops tools by role (hierarchical, `sre` ⊇ `oncall`).

### Claims wiring (minimum)
- Standard OIDC profile claims (`sub`, `email`, `name`).
- Custom claim `roles` mapping the account's roles into the access token (the
  token-exchange role gate keys on `sre` for `ops:write`).
- The `acr` claim is stamped procedurally at login (`authorization-code.js`,
  `acr-passthrough`) and re-emitted on every exchange — see [`design.md`](design.md) §7.
- Token `aud` includes `web-app` for the user-issued token; each exchanged token
  names exactly one downstream audience (`mcp-observability` / `agent-specialist`
  / `mcp-ops` / `obs-api` / `ops-api`).

These are already encoded in `k8s/curity/configmap.yaml` and the procedures
under `k8s/curity/procedures/`; this list is the conceptual checklist behind
that config. The token-exchange procedure validates the `subject_token`,
verifies the `actor_token` against SPIRE's JWKS (fetched at runtime), narrows scope +
audience, nests the `act` chain, and enforces the `sre` role gate + `acr=mfa`
step-up for `ops:write`.

---

## Cluster-side seeding

`make demo` already does all of this for you — it runs `seed-secrets` (license +
every workload secret + the agent keypairs), then `images` and `apply`. The only
step it can't automate is creating the **alice/bob accounts** in Curity's
in-memory store; do that by hand during the login flow via the HTML Form
authenticator's "create account" feature (see §Accounts above) — open
`https://app.localtest.me`, register alice & bob, then log in as Alice.

`make seed-secrets` does **not** prompt for client secrets: the web and MCP
clients use the fixed demo value `Password1` (whose hash is committed in the
configmap), the license comes from `./license.json`, and the Azure OpenAI key is
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

# LLM API key (Azure OpenAI / AI Foundry) — both agents share one key
kubectl -n agents create secret generic agent-copilot-llm \
  --from-literal=AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com \
  --from-literal=AZURE_OPENAI_API_KEY=<key>
kubectl -n agents create secret generic agent-specialist-llm \
  --from-literal=AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com \
  --from-literal=AZURE_OPENAI_API_KEY=<key>
```

The full set of token-exchange clients (`agent-copilot`, `agent-specialist`,
`mcp-ops`, `mcp-observability`) and backend audiences (`obs-api`, `ops-api`) is
defined in `k8s/curity/configmap.yaml`.

---

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| 502 from `/api/agent` | Agent pod not ready, or `MCP_OBSERVABILITY_URL` wrong. `kubectl -n agents logs deploy/agent-copilot` |
| 401 from MCP at the agent | User access token doesn't have `obs:read` scope; check `/api/whoami` |
| OIDC redirect loop | `AUTH_URL` mismatch or `AUTH_SECRET` empty |
| Curity won't start | License missing or invalid; `kubectl -n curity logs deploy/curity` |
| TLS warnings in the browser | Expected by default — the root CA is not added to the keychain. Run `make trust-ca` and restart the browser to trust it (undo with `mkcert -uninstall`) |
