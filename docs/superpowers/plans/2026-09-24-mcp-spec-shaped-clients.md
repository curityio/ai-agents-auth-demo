# Spec-shaped MCP clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the two agents discovery-driven MCP clients per the MCP authorization spec (2026-07-28), complete the MCP servers' 401 challenges, and make the gateway's advertised RFC 9728 document real and reachable.

**Architecture:** A new module in `packages/agent-runtime` runs the spec's discovery sequence (unauthenticated probe → `WWW-Authenticate` → RFC 9728 PRM → RFC 8414/OIDC AS metadata, fail-closed) using the MCP SDK's own helpers, and wraps it in the SDK's minimal `AuthProvider` so the transport's 401 seam re-acquires once. The agents keep `exchangeToken` unchanged and feed it the discovered token endpoint and scope. agentgateway gains route matches for its well-known path and a public HTTPS host, so the URL the agents call equals the `resource` the PRM advertises.

**Tech Stack:** TypeScript (ESM, Node 22), `@modelcontextprotocol/client@2.0.0`, vitest 2, pnpm 9 + turbo, express, agentgateway v1.4.1 (YAML config), Istio Gateway/VirtualService, bash 3.2-compatible shell scripts, mkcert.

**Spec:** `docs/superpowers/specs/2026-09-24-mcp-spec-shaped-clients-design.md`

## Global Constraints

- **No commits.** The user asked for all work on branch `feat/mcp-spec-shaped-clients` with nothing committed. Every task ends at "tests pass"; there are no commit steps. Do not `git add` or `git commit`.
- **RFC 8707 `resource` is out of scope.** The RFC 8693 `audience` parameter keeps its logical-name values (`mcp-gateway`, `llm-gateway`, `agent-specialist`). Do not add a `resource` parameter anywhere.
- **`exchangeToken` in `packages/auth-curity` is not modified.** Its OBO log, `DENY` exit and span are load-bearing (CLAUDE.md fact #31).
- **MCP wire revision stays pinned:** clients keep `versionNegotiation: { mode: { pin: '2026-07-28' } }`; servers keep `legacy: 'reject'` (fact #26).
- **zod split stays:** `agent-runtime` and the agents remain on zod 3; the MCP servers on zod 4. The new module imports no zod.
- **ESM imports use the `.js` suffix** (`./mcp-oauth-client.js`), as everywhere in this repo.
- **Shell scripts must run on macOS bash 3.2:** no `declare -A`, no `${var,,}`; use parallel arrays / IFS-split strings.
- **No secrets in manifests.** The new TLS secret is created by `scripts/apply-tls-secrets.sh`, never inline.
- **Error codes:** discovery failures use the new `CurityAuthError` codes `discovery_failed`, `resource_mismatch`, `cimd_unsupported`, `scope_unavailable`, `step_up_required` (Task 1 adds them). Agents answer 502 for those and 403 for exchange refusals.
- **Static config that remains per MCP server:** the server URL and the `audience`. Static config removed from both agents: `CURITY_TOKEN_ENDPOINT`, `MCP_OBSERVABILITY_SCOPE`, `MCP_OPS_SCOPE`, `MCP_OPS_RESOURCE_METADATA_URL`, `MCP_OPS_METADATA_URL`.
- **Run tests through pnpm:** `pnpm --filter <pkg> test -- <file>`; workspace packages resolve to `dist`, so run `pnpm turbo run build --filter=<pkg>` for a dependency you changed before testing a consumer.

## Review Focus

Inputs the spec implies but its examples do not exercise. Each has a pinned test in the owning task.

1. **A 401 whose `WWW-Authenticate` has no `resource_metadata`** (or no header at all): the client must fall back to the path-based well-known URL, then the root. (Task 5: "falls back to well-known probing".)
2. **A probe that does not answer 401** (a misconfigured or unauthenticated server returns 200/404): discovery must refuse rather than proceed with a guessed AS. (Task 5: "refuses when the probe is not 401".)
3. **A PRM whose `resource` differs from the server URL only by a trailing slash** must be accepted; any other difference must be `resource_mismatch`. (Task 5: two tests.)
4. **An `error_description` containing a double quote** must not break the `WWW-Authenticate` header's quoting. (Tasks 2 and 3: "escapes quotes".)
5. **A stale discovery cache when the transport reports 401**: `onUnauthorized` must re-run discovery with `force: true` and then exchange, not reuse the cached token endpoint blindly. (Task 6: "re-acquires with a forced discovery".)

---

### Task 1: New error codes and the `DISCOVER` log kind (`packages/auth-curity`)

**Files:**
- Modify: `packages/auth-curity/src/errors.ts`
- Modify: `packages/auth-curity/src/obo-log.ts:15-22`
- Test: `packages/auth-curity/src/obo-log.test.ts`

**Interfaces:**
- Produces: `CurityAuthErrorCode` gains `'cimd_unsupported' | 'resource_mismatch' | 'scope_unavailable' | 'step_up_required'`. `OboKind` gains `'DISCOVER'`. Both are consumed by Tasks 4–9.

- [ ] **Step 1: Write the failing test**

Append to `packages/auth-curity/src/obo-log.test.ts` inside `describe('formatOboLog', …)`:

```ts
  it('renders a DISCOVER block for an OAuth discovery run', () => {
    const out = formatOboLog({
      service: 'agent-specialist',
      kind: 'DISCOVER',
      headline: '→ https://mcp-gateway.localtest.me/ops/mcp',
      fields: {
        resource_metadata: 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp',
        'authorization srv': 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
        'scope selected': 'ops:write (from scopes_supported)',
      },
    });
    expect(out).toContain('┌─ INFO [agent-specialist] DISCOVER → https://mcp-gateway.localtest.me/ops/mcp');
    expect(out).toContain('│  authorization srv : https://curity.localtest.me/oauth/v2/oauth-anonymous');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-agents-demo/auth-curity test -- src/obo-log.test.ts`
Expected: FAIL with a TypeScript/vitest error that `'DISCOVER'` is not assignable to `OboKind` (or the rendered string check fails).

- [ ] **Step 3: Add the kind and the codes**

In `packages/auth-curity/src/obo-log.ts` replace lines 15–22 with:

```ts
/**
 * RECEIVE (inbound), EXCHANGE (token exchange), CALL (next hop), DENY (an
 * authorization refusal), DISCOVER (an OAuth discovery run: 401 challenge →
 * RFC 9728 → RFC 8414). DENY exists because the success paths were logged and
 * the refusals were not — which is backwards for a demo about authorization:
 * a denied hop would simply stop appearing in the logs, indistinguishable from
 * a crash. DISCOVER is emitted once per cold discovery so the log shows where a
 * client learned its authorization server from; cache hits are silent.
 */
export type OboKind = 'RECEIVE' | 'EXCHANGE' | 'CALL' | 'DENY' | 'DISCOVER';
```

In `packages/auth-curity/src/errors.ts` replace the union with:

```ts
export type CurityAuthErrorCode =
  | 'access_denied'
  /** AS metadata says client_id_metadata_document_supported is not true; the agents have no other registration path. */
  | 'cimd_unsupported'
  | 'discovery_failed'
  | 'exchange_failed'
  | 'expired_token'
  | 'invalid_actor'
  | 'invalid_audience'
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_issuer'
  | 'invalid_scope'
  | 'invalid_token'
  | 'jwks_failed'
  /** RFC 9728 `resource` does not identify the server the client is talking to. */
  | 'resource_mismatch'
  /** Neither the 401 challenge nor `scopes_supported` said what scope to request. */
  | 'scope_unavailable'
  /** An RFC 9470 challenge reached the transport's 401 seam; never retried. */
  | 'step_up_required';
```

- [ ] **Step 4: Run the tests and build**

Run: `pnpm --filter @ai-agents-demo/auth-curity test && pnpm --filter @ai-agents-demo/auth-curity build`
Expected: all tests PASS; build succeeds (consumers read `dist`).

---

### Task 2: Complete the 401 challenges in `mcp-observability`

**Files:**
- Modify: `apps/mcp-observability/src/auth-middleware.ts`
- Test: `apps/mcp-observability/tests/auth-middleware.test.ts`

**Interfaces:**
- Produces: on the wire, every 401 from mcp-observability carries `resource_metadata="<cfg.resourceMetadataUrl>"`; the no-token 401 also carries `scope`; verification failures use `error="invalid_token"` with `error_description="<code>: <message>"`. JSON bodies are unchanged.

- [ ] **Step 1: Write the failing tests**

Add this helper near the top of `apps/mcp-observability/tests/auth-middleware.test.ts`, after `mockRes`:

```ts
/** Parse `Bearer k="v", k2="v2"` into a map. Values are unquoted; keys lowercased. */
function parseChallenge(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || !/^bearer\s/i.test(header)) return out;
  for (const m of header.slice('bearer '.length).matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}
```

Append inside `describe('mcp-observability authMiddleware', …)`:

```ts
  it('401 without a bearer advertises resource_metadata and the required scope (MCP 2026-07-28 discovery)', async () => {
    const req = { header: () => undefined } as unknown as Request;
    const { res, headers, peek } = mockRes();
    await authMiddleware(cfg)(req, res, vi.fn());
    expect(peek()._status).toBe(401);
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.realm).toBe('mcp-observability');
    expect(c.scope).toBe('obs:read');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
    expect(c.error).toBeUndefined();
  });

  it('401 on a verification failure uses RFC 6750 invalid_token, keeps the specific code in the description, and advertises resource_metadata', async () => {
    verifyJwt.mockRejectedValue(
      new (await import('@ai-agents-demo/auth-curity')).CurityAuthError('Token expired', 'expired_token'),
    );
    const { res, headers, peek } = mockRes();
    await authMiddleware(cfg)(baseReq, res, vi.fn());
    expect(peek()._status).toBe(401);
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.error).toBe('invalid_token');
    expect(c.error_description).toBe('expired_token: Token expired');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
    // The body still carries the specific code for callers that read it.
    expect(peek()._body).toMatchObject({ error: 'expired_token' });
  });

  it('escapes quotes in error_description so the challenge stays parseable', async () => {
    verifyJwt.mockRejectedValue(
      new (await import('@ai-agents-demo/auth-curity')).CurityAuthError('unknown "kid" in header', 'invalid_token'),
    );
    const { res, headers } = mockRes();
    await authMiddleware(cfg)(baseReq, res, vi.fn());
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.error_description).toBe("invalid_token: unknown 'kid' in header");
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
  });

  it('401 for a missing act.sub advertises resource_metadata', async () => {
    verifyJwt.mockResolvedValue({ payload: { sub: 'alice' }, protectedHeader: {}, scopes: new Set(['obs:read']) });
    const { res, headers } = mockRes();
    await authMiddleware(cfg)(baseReq, res, vi.fn());
    const c = parseChallenge(headers['www-authenticate']);
    expect(c.error).toBe('invalid_token');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-agents-demo/mcp-observability test -- tests/auth-middleware.test.ts`
Expected: the four new tests FAIL (`scope`/`resource_metadata` undefined, `error` is `expired_token`).

- [ ] **Step 3: Implement the challenge builder and use it**

In `apps/mcp-observability/src/auth-middleware.ts`, add after the `AuthedRequest` type:

```ts
/**
 * Build an RFC 6750 `Bearer` challenge. Values are quoted-strings, so an embedded
 * `"` (Curity error text can contain them) is downgraded to `'` rather than
 * terminating the value early and making the header unparseable. Undefined
 * values are omitted so callers can pass optional parts unconditionally.
 */
export function bearerChallenge(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
    .map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`);
  return `Bearer ${parts.join(', ')}`;
}
```

Replace the three 401 sites:

```ts
    if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
      res
        .status(401)
        // MCP 2026-07-28 "Authorization Server Discovery": a 401 SHOULD name the
        // RFC 9728 document (`resource_metadata`) and SHOULD say which scopes the
        // resource needs (`scope`), so a client with no prior knowledge can start
        // the discovery chain from this response alone.
        .set(
          'www-authenticate',
          bearerChallenge({
            realm: cfg.expectedAudience,
            scope: cfg.requiredScopes.join(' '),
            resource_metadata: cfg.resourceMetadataUrl,
          }),
        )
        .json({ error: 'invalid_token', error_description: 'missing Bearer token' });
      return;
    }
```

```ts
      if (!actSub) {
        res
          .status(401)
          .set(
            'www-authenticate',
            bearerChallenge({
              realm: cfg.expectedAudience,
              error: 'invalid_token',
              error_description: 'missing act.sub (OBO required)',
              resource_metadata: cfg.resourceMetadataUrl,
            }),
          )
          .json({ error: 'invalid_token', error_description: 'missing act.sub (OBO required)' });
        return;
      }
```

```ts
      if (e instanceof CurityAuthError) {
        res
          .status(401)
          // RFC 6750 §3.1 defines only invalid_request / invalid_token /
          // insufficient_scope. Curity's finer code (expired_token, invalid_issuer,
          // …) rides in error_description and stays verbatim in the JSON body.
          .set(
            'www-authenticate',
            bearerChallenge({
              realm: cfg.expectedAudience,
              error: 'invalid_token',
              error_description: `${e.code}: ${e.message}`,
              resource_metadata: cfg.resourceMetadataUrl,
            }),
          )
          .json({ error: e.code, error_description: e.message });
        return;
      }
```

Leave the two 403 sites (`access_denied`, `insufficient_scope`) unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-agents-demo/mcp-observability test`
Expected: PASS (all, including the pre-existing `rejects when act claim is missing` tests, which only check the status).

---

### Task 3: Complete the 401 challenges in `mcp-ops`

**Files:**
- Modify: `apps/mcp-ops/src/auth-middleware.ts`
- Test: `apps/mcp-ops/tests/auth-middleware.test.ts`

**Interfaces:**
- Produces: same wire contract as Task 2 for mcp-ops. The RFC 9470 401 and every 403 are unchanged.

- [ ] **Step 1: Write the failing tests**

Add after `mockReq` in `apps/mcp-ops/tests/auth-middleware.test.ts`:

```ts
function parseChallenge(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || !/^bearer\s/i.test(header)) return out;
  for (const m of header.slice('bearer '.length).matchAll(/(\w+)="([^"]*)"/g)) {
    out[m[1]!.toLowerCase()] = m[2]!;
  }
  return out;
}
```

Append inside `describe('authMiddleware', …)`:

```ts
  it('401 without a bearer advertises resource_metadata and the required scope', async () => {
    const res = mockRes();
    await authMiddleware(cfg)(mockReq(undefined), res, vi.fn());
    const c = parseChallenge(res.headers['www-authenticate']);
    expect(c.realm).toBe('mcp-ops');
    expect(c.scope).toBe('ops:write');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
    expect(c.error).toBeUndefined();
  });

  it('401 on a verification failure is invalid_token with the Curity code in the description', async () => {
    vi.mocked(verifyJwt).mockRejectedValueOnce(new CurityAuthError('Token expired', 'expired_token'));
    const res = mockRes();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, vi.fn());
    const c = parseChallenge(res.headers['www-authenticate']);
    expect(c.error).toBe('invalid_token');
    expect(c.error_description).toBe('expired_token: Token expired');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
    expect(res.body).toMatchObject({ error: 'expired_token' });
  });

  it('escapes quotes in error_description so the challenge stays parseable', async () => {
    vi.mocked(verifyJwt).mockRejectedValueOnce(new CurityAuthError('unknown "kid" in header', 'invalid_token'));
    const res = mockRes();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, vi.fn());
    const c = parseChallenge(res.headers['www-authenticate']);
    expect(c.error_description).toBe("invalid_token: unknown 'kid' in header");
  });

  it('the RFC 9470 challenge is unchanged (still insufficient_user_authentication + acr_values)', async () => {
    vi.mocked(verifyJwt).mockResolvedValueOnce({
      payload: {
        sub: 'alice',
        acr: 'html-form',
        act: { sub: GATEWAY, act: { sub: SPECIALIST, act: { sub: COPILOT } } },
      },
      protectedHeader: {},
      scopes: new Set(['ops:write']),
    } as never);
    const res = mockRes();
    await authMiddleware(cfg)(mockReq('Bearer x'), res, vi.fn());
    const c = parseChallenge(res.headers['www-authenticate']);
    expect(res.statusCode).toBe(401);
    expect(c.error).toBe('insufficient_user_authentication');
    expect(c.acr_values).toBe('mfa');
    expect(c.resource_metadata).toBe(cfg.resourceMetadataUrl);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-agents-demo/mcp-ops test -- tests/auth-middleware.test.ts`
Expected: the first three new tests FAIL; the RFC 9470 one PASSES already (it is a guard).

- [ ] **Step 3: Implement**

In `apps/mcp-ops/src/auth-middleware.ts` add after `walkActChain`:

```ts
/**
 * Build an RFC 6750 `Bearer` challenge. Values are quoted-strings, so an embedded
 * `"` is downgraded to `'` rather than ending the value early. Undefined values
 * are omitted.
 */
export function bearerChallenge(params: Record<string, string | undefined>): string {
  const parts = Object.entries(params)
    .filter((kv): kv is [string, string] => typeof kv[1] === 'string')
    .map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`);
  return `Bearer ${parts.join(', ')}`;
}
```

Replace the no-bearer 401:

```ts
    if (!authz || !authz.toLowerCase().startsWith('bearer ')) {
      res
        .status(401)
        // MCP 2026-07-28 discovery: name the RFC 9728 document and the scope this
        // resource needs, so a client can start the chain from this 401 alone.
        .set(
          'www-authenticate',
          bearerChallenge({
            realm: cfg.expectedAudience,
            scope: cfg.requiredScopes.join(' '),
            resource_metadata: cfg.resourceMetadataUrl,
          }),
        )
        .json({ error: 'invalid_token', error_description: 'missing Bearer token' });
      return;
    }
```

Replace the `catch` 401:

```ts
      if (e instanceof CurityAuthError) {
        res
          .status(401)
          // RFC 6750 §3.1: the header code is invalid_token; Curity's finer code
          // (expired_token, invalid_issuer, …) rides in error_description and
          // stays verbatim in the JSON body.
          .set(
            'www-authenticate',
            bearerChallenge({
              realm: cfg.expectedAudience,
              error: 'invalid_token',
              error_description: `${e.code}: ${e.message}`,
              resource_metadata: cfg.resourceMetadataUrl,
            }),
          )
          .json({ error: e.code, error_description: e.message });
        return;
      }
```

Do not touch the RFC 9470 block (lines 142–151) or any 403.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-agents-demo/mcp-ops test`
Expected: PASS.

---

### Task 4: `resolveAuthorizationServer` (`packages/agent-runtime/src/authorization-server.ts`)

**Files:**
- Create: `packages/agent-runtime/src/authorization-server.ts`
- Create: `packages/agent-runtime/src/authorization-server.test.ts`
- Modify: `packages/agent-runtime/src/index.ts`

**Interfaces:**
- Consumes: `discoverAuthorizationServerMetadata`, `assertSecureTokenEndpoint`, types `AuthorizationServerMetadata`, `FetchLike` from `@modelcontextprotocol/client`; `CurityAuthError` from `@ai-agents-demo/auth-curity` (codes from Task 1).
- Produces:
  ```ts
  export interface ResolvedAuthorizationServer { issuer: string; tokenEndpoint: string; metadata: AuthorizationServerMetadata }
  export const AS_METADATA_TTL_MS: number; // 10 minutes
  export function validateAuthorizationServerMetadata(metadata: AuthorizationServerMetadata): ResolvedAuthorizationServer;
  export async function resolveAuthorizationServer(issuer: string, opts?: { fetchImpl?: FetchLike; force?: boolean }): Promise<ResolvedAuthorizationServer>;
  export function _resetAuthorizationServerCache(): void;
  ```
  Used by Task 5 (MCP discovery) and Tasks 8–9 (LLM and A2A exchanges).

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-runtime/src/authorization-server.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import {
  resolveAuthorizationServer,
  validateAuthorizationServerMetadata,
  _resetAuthorizationServerCache,
} from './authorization-server.js';

const ISSUER = 'https://curity.localtest.me/oauth/v2/oauth-anonymous';
// RFC 8414 §3.1 path-insertion form — the first URL the SDK tries for a path issuer.
const RFC8414_URL = 'https://curity.localtest.me/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous';

const GOOD = {
  issuer: ISSUER,
  token_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  authorization_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-authorize',
  jwks_uri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
};

/** A fetch that serves `routes` by exact URL and 404s everything else; records calls. */
function fakeFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const body = routes[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

beforeEach(() => _resetAuthorizationServerCache());

describe('validateAuthorizationServerMetadata', () => {
  it('returns the issuer and an https token endpoint', () => {
    const r = validateAuthorizationServerMetadata(GOOD as never);
    expect(r.issuer).toBe(ISSUER);
    expect(r.tokenEndpoint).toBe('https://curity.localtest.me/oauth/v2/oauth-token');
  });

  it('refuses an AS that does not advertise CIMD support (the agents have no other registration path)', () => {
    expect(() => validateAuthorizationServerMetadata({ ...GOOD, client_id_metadata_document_supported: false } as never))
      .toThrowError(expect.objectContaining({ code: 'cimd_unsupported' }));
    const { client_id_metadata_document_supported: _drop, ...absent } = GOOD;
    expect(() => validateAuthorizationServerMetadata(absent as never))
      .toThrowError(expect.objectContaining({ code: 'cimd_unsupported' }));
  });

  it('refuses a plain-http token endpoint', () => {
    expect(() =>
      validateAuthorizationServerMetadata({ ...GOOD, token_endpoint: 'http://curity.curity.svc:8443/oauth/v2/oauth-token' } as never),
    ).toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('refuses metadata without a token endpoint', () => {
    const { token_endpoint: _drop, ...noTe } = GOOD;
    expect(() => validateAuthorizationServerMetadata(noTe as never))
      .toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });
});

describe('resolveAuthorizationServer', () => {
  it('fetches RFC 8414 metadata in path-insertion form first and validates it', async () => {
    const { f, calls } = fakeFetch({ [RFC8414_URL]: GOOD });
    const r = await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    expect(r.tokenEndpoint).toBe(GOOD.token_endpoint);
    expect(calls[0]).toBe(RFC8414_URL);
  });

  it('serves a second call from cache without fetching', async () => {
    const { f, calls } = fakeFetch({ [RFC8414_URL]: GOOD });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    expect(calls.filter((u) => u === RFC8414_URL)).toHaveLength(1);
  });

  it('force refetches', async () => {
    const { f, calls } = fakeFetch({ [RFC8414_URL]: GOOD });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f });
    await resolveAuthorizationServer(ISSUER, { fetchImpl: f, force: true });
    expect(calls.filter((u) => u === RFC8414_URL)).toHaveLength(2);
  });

  it('rejects a document whose issuer does not echo the URL (RFC 8414 §3.3) as discovery_failed', async () => {
    const { f } = fakeFetch({ [RFC8414_URL]: { ...GOOD, issuer: 'https://honest.example' } });
    await expect(resolveAuthorizationServer(ISSUER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('fails discovery_failed when no well-known document exists', async () => {
    const { f } = fakeFetch({});
    const err = await resolveAuthorizationServer(ISSUER, { fetchImpl: f }).catch((e) => e);
    expect(err).toBeInstanceOf(CurityAuthError);
    expect(err.code).toBe('discovery_failed');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test -- src/authorization-server.test.ts`
Expected: FAIL — cannot resolve `./authorization-server.js`.

- [ ] **Step 3: Implement**

Create `packages/agent-runtime/src/authorization-server.ts`:

```ts
import {
  assertSecureTokenEndpoint,
  discoverAuthorizationServerMetadata,
  type AuthorizationServerMetadata,
  type FetchLike,
} from '@modelcontextprotocol/client';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';

/**
 * Authorization-server metadata discovery (RFC 8414 / OIDC Discovery), shared by
 * every exchange the agents perform. For MCP hops the issuer comes from the RFC
 * 9728 document (see mcp-oauth-client.ts); for the LLM and A2A hops, which have
 * no MCP server to discover from, it is the configured `CURITY_ISSUER`. Either
 * way the token endpoint is READ from metadata, never configured — one source of
 * truth for where tokens come from.
 *
 * The SDK helper tries the MCP-mandated URL order (RFC 8414 path-insertion, then
 * OIDC path-insertion, then OIDC path-appending) and rejects a document whose
 * `issuer` does not echo the URL it was fetched from.
 */
export interface ResolvedAuthorizationServer {
  issuer: string;
  tokenEndpoint: string;
  metadata: AuthorizationServerMetadata;
}

export const AS_METADATA_TTL_MS = 10 * 60_000;

const cache = new Map<string, { value: ResolvedAuthorizationServer; expiresAt: number }>();

/** Test-only. */
export function _resetAuthorizationServerCache(): void {
  cache.clear();
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/**
 * The checks every consumer needs before trusting a metadata document:
 *  - CIMD support advertised (MCP client-registration priority: pre-registered →
 *    CIMD → DCR → prompt; the agents are CIMD ephemeral clients and nothing else,
 *    so an AS without it cannot issue them anything);
 *  - a token endpoint that exists and is HTTPS (SEP-2207 / OAuth 2.1 §1.5).
 */
export function validateAuthorizationServerMetadata(
  metadata: AuthorizationServerMetadata,
): ResolvedAuthorizationServer {
  if (metadata.client_id_metadata_document_supported !== true) {
    throw new CurityAuthError(
      `${metadata.issuer} does not advertise client_id_metadata_document_supported=true; ` +
        'this client can only register via Client ID Metadata Documents',
      'cimd_unsupported',
    );
  }
  if (typeof metadata.token_endpoint !== 'string' || metadata.token_endpoint === '') {
    throw new CurityAuthError(`${metadata.issuer} metadata has no token_endpoint`, 'discovery_failed');
  }
  let tokenUrl: URL;
  try {
    tokenUrl = assertSecureTokenEndpoint(metadata.token_endpoint);
  } catch (e) {
    throw new CurityAuthError(`token_endpoint rejected: ${describe(e)}`, 'discovery_failed', e);
  }
  return { issuer: metadata.issuer, tokenEndpoint: tokenUrl.href, metadata };
}

export async function resolveAuthorizationServer(
  issuer: string,
  opts: { fetchImpl?: FetchLike; force?: boolean } = {},
): Promise<ResolvedAuthorizationServer> {
  const key = issuer.replace(/\/+$/, '');
  const hit = cache.get(key);
  if (hit && !opts.force && hit.expiresAt > Date.now()) return hit.value;

  let metadata: AuthorizationServerMetadata | undefined;
  try {
    metadata = await discoverAuthorizationServerMetadata(key, {
      ...(opts.fetchImpl ? { fetchFn: opts.fetchImpl } : {}),
    });
  } catch (e) {
    // Includes the SDK's IssuerMismatchError: a document that names another issuer
    // is an attack or a misconfiguration, never something to use.
    throw new CurityAuthError(`authorization server metadata for ${key}: ${describe(e)}`, 'discovery_failed', e);
  }
  if (!metadata) {
    throw new CurityAuthError(
      `no authorization server metadata found for ${key} (tried RFC 8414 and OIDC well-known URLs)`,
      'discovery_failed',
    );
  }
  const value = validateAuthorizationServerMetadata(metadata);
  cache.set(key, { value, expiresAt: Date.now() + AS_METADATA_TTL_MS });
  return value;
}
```

Add to `packages/agent-runtime/src/index.ts`:

```ts
export {
  resolveAuthorizationServer,
  validateAuthorizationServerMetadata,
  AS_METADATA_TTL_MS,
  type ResolvedAuthorizationServer,
} from './authorization-server.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test -- src/authorization-server.test.ts`
Expected: PASS. If the "path-insertion form first" test fails because the SDK fetched a different URL first, print `calls` and adjust `RFC8414_URL` to the SDK's actual first probe; the spec requires RFC 8414 path-insertion first, so a different order is a finding to report, not to paper over.

---

### Task 5: `discoverMcpAuthorization` (`packages/agent-runtime/src/mcp-oauth-client.ts`, discovery half)

**Files:**
- Create: `packages/agent-runtime/src/mcp-oauth-client.ts`
- Create: `packages/agent-runtime/src/mcp-oauth-client.test.ts`
- Modify: `packages/agent-runtime/src/index.ts`

**Interfaces:**
- Consumes: `extractWWWAuthenticateParams`, `FetchLike` from the SDK; `resolveAuthorizationServer` (Task 4); `oboLog`, `CurityAuthError` (Task 1).
- Produces:
  ```ts
  export interface ProtectedResourceMetadata { resource: string; authorization_servers?: string[]; scopes_supported?: string[]; bearer_methods_supported?: string[]; acr_values_supported?: string[]; [k: string]: unknown }
  export interface McpAuthDiscovery { serverUrl: string; resourceMetadataUrl: string; resourceMetadata: ProtectedResourceMetadata; authorizationServer: string; authorizationServerMetadata: AuthorizationServerMetadata; tokenEndpoint: string; scope: string; scopeSource: 'challenge' | 'scopes_supported'; discoveredAt: number }
  export const DISCOVERY_TTL_MS: number;
  export async function discoverMcpAuthorization(serverUrl: string, opts?: { fetchImpl?: FetchLike; challenge?: Response; force?: boolean; service?: string }): Promise<McpAuthDiscovery>;
  export function isDiscoveryFailure(e: unknown): boolean;
  export function _resetDiscoveryCache(): void;
  ```
  Consumed by Task 6 and the agents.

Note on the spec: §4.1.1 step 3 names the SDK's `discoverOAuthProtectedResourceMetadata` for the well-known fallback. That helper does not report WHICH URL succeeded, and the `DISCOVER` log and the specialist's step-up challenge need that URL, so the PRM fetch is written here (three candidate URLs in the spec's order) while the header parsing and AS discovery stay on the SDK.

- [ ] **Step 1: Write the failing tests**

Create `packages/agent-runtime/src/mcp-oauth-client.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { CurityAuthError } from '@ai-agents-demo/auth-curity';
import { _resetAuthorizationServerCache } from './authorization-server.js';
import { discoverMcpAuthorization, isDiscoveryFailure, _resetDiscoveryCache } from './mcp-oauth-client.js';

const SERVER = 'https://mcp-gateway.localtest.me/ops/mcp';
const PRM_URL = 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp';
const PRM_ROOT_URL = 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource';
const ISSUER = 'https://curity.localtest.me/oauth/v2/oauth-anonymous';
const AS_URL = 'https://curity.localtest.me/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous';

const PRM = {
  resource: SERVER,
  authorization_servers: [ISSUER],
  scopes_supported: ['ops:write'],
  bearer_methods_supported: ['header'],
  acr_values_supported: ['mfa'],
};
const AS = {
  issuer: ISSUER,
  token_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  authorization_endpoint: 'https://curity.localtest.me/oauth/v2/oauth-authorize',
  jwks_uri: 'https://curity.localtest.me/oauth/v2/oauth-anonymous/jwks',
  response_types_supported: ['code'],
  code_challenge_methods_supported: ['S256'],
  client_id_metadata_document_supported: true,
};

interface Route { status?: number; body?: unknown; headers?: Record<string, string> }

/**
 * Fake fetch keyed by "METHOD url". Unrouted URLs 404. Records every call so a
 * test can assert the spec's request ORDER, not just the outcome.
 */
function fakeFetch(routes: Record<string, Route>) {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${String(input)}`;
    calls.push(key);
    const r = routes[key];
    if (!r) return new Response('not found', { status: 404 });
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...(r.headers ?? {}) },
    });
  }) as typeof fetch;
  return { f, calls };
}

const challenge401 = (extra = ''): Route => ({
  status: 401,
  headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"${extra}` },
});

const HAPPY = {
  [`POST ${SERVER}`]: challenge401(),
  [`GET ${PRM_URL}`]: { body: PRM },
  [`GET ${AS_URL}`]: { body: AS },
};

beforeEach(() => {
  _resetDiscoveryCache();
  _resetAuthorizationServerCache();
});

describe('discoverMcpAuthorization', () => {
  it('runs the spec sequence: unauthenticated probe → resource_metadata → PRM → AS metadata', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls).toEqual([`POST ${SERVER}`, `GET ${PRM_URL}`, `GET ${AS_URL}`]);
    expect(d).toMatchObject({
      serverUrl: SERVER,
      resourceMetadataUrl: PRM_URL,
      authorizationServer: ISSUER,
      tokenEndpoint: AS.token_endpoint,
      scope: 'ops:write',
      scopeSource: 'scopes_supported',
    });
    expect(d.resourceMetadata.acr_values_supported).toEqual(['mfa']);
  });

  it('prefers the scope named in the 401 challenge over scopes_supported (spec scope-selection order)', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`POST ${SERVER}`]: challenge401(', scope="ops:write obs:read"') });
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(d.scope).toBe('ops:write obs:read');
    expect(d.scopeSource).toBe('challenge');
  });

  it('falls back to well-known probing (path form, then root) when the 401 carries no resource_metadata', async () => {
    const { f, calls } = fakeFetch({
      [`POST ${SERVER}`]: { status: 401, headers: { 'www-authenticate': 'Bearer realm="x"' } },
      [`GET ${PRM_ROOT_URL}`]: { body: PRM },
      [`GET ${AS_URL}`]: { body: AS },
    });
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls.slice(0, 3)).toEqual([`POST ${SERVER}`, `GET ${PRM_URL}`, `GET ${PRM_ROOT_URL}`]);
    expect(d.resourceMetadataUrl).toBe(PRM_ROOT_URL);
  });

  it('falls back the same way when the 401 has no WWW-Authenticate header at all', async () => {
    const { f, calls } = fakeFetch({
      [`POST ${SERVER}`]: { status: 401 },
      [`GET ${PRM_URL}`]: { body: PRM },
      [`GET ${AS_URL}`]: { body: AS },
    });
    await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls[1]).toBe(`GET ${PRM_URL}`);
  });

  it('refuses when the probe is not 401 (a server that does not require auth is not one we hand a token to)', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`POST ${SERVER}`]: { status: 200, body: {} } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('accepts a PRM resource that differs only by a trailing slash', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, resource: `${SERVER}/` } } });
    const d = await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(d.serverUrl).toBe(SERVER);
  });

  it('refuses a PRM whose resource identifies another server (RFC 9728 §3.3)', async () => {
    const { f } = fakeFetch({
      ...HAPPY,
      [`GET ${PRM_URL}`]: { body: { ...PRM, resource: 'https://mcp-gateway.localtest.me/observability/mcp' } },
    });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
  });

  it('refuses a PRM with no authorization_servers', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, authorization_servers: [] } } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'discovery_failed' }));
  });

  it('refuses when neither the challenge nor scopes_supported says what to ask for', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, scopes_supported: [] } } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'scope_unavailable' }));
  });

  it('propagates an AS that lacks CIMD support as cimd_unsupported', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${AS_URL}`]: { body: { ...AS, client_id_metadata_document_supported: false } } });
    await expect(discoverMcpAuthorization(SERVER, { fetchImpl: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'cimd_unsupported' }));
  });

  it('serves a repeat from cache with no HTTP calls, and force re-probes', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    const n = calls.length;
    await discoverMcpAuthorization(SERVER, { fetchImpl: f });
    expect(calls.length).toBe(n);
    await discoverMcpAuthorization(SERVER, { fetchImpl: f, force: true });
    expect(calls.length).toBeGreaterThan(n);
  });

  it('uses a supplied 401 response as the challenge instead of probing', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const challenge = new Response(null, {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${PRM_URL}"` },
    });
    await discoverMcpAuthorization(SERVER, { fetchImpl: f, challenge });
    expect(calls[0]).toBe(`GET ${PRM_URL}`);
  });
});

describe('isDiscoveryFailure', () => {
  it('is true for the four discovery codes and false for exchange refusals', () => {
    for (const code of ['discovery_failed', 'resource_mismatch', 'cimd_unsupported', 'scope_unavailable'] as const) {
      expect(isDiscoveryFailure(new CurityAuthError('x', code))).toBe(true);
    }
    expect(isDiscoveryFailure(new CurityAuthError('x', 'invalid_scope'))).toBe(false);
    expect(isDiscoveryFailure(new Error('x'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test -- src/mcp-oauth-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the discovery half**

Create `packages/agent-runtime/src/mcp-oauth-client.ts`:

```ts
import {
  extractWWWAuthenticateParams,
  type AuthorizationServerMetadata,
  type AuthProvider,
  type FetchLike,
  type UnauthorizedContext,
} from '@modelcontextprotocol/client';
import { CurityAuthError, oboLog } from '@ai-agents-demo/auth-curity';
import { resolveAuthorizationServer } from './authorization-server.js';

/**
 * Spec-shaped MCP client authorization (MCP 2026-07-28, "Authorization").
 *
 * What is DISCOVERED here, in the spec's order:
 *   1. an unauthenticated request → 401 with WWW-Authenticate
 *   2. `resource_metadata` from that header, else the well-known URLs (path form,
 *      then root) → the RFC 9728 Protected Resource Metadata document
 *   3. `authorization_servers[0]` → RFC 8414 / OIDC metadata (issuer-echo checked
 *      by the SDK), CIMD support required, HTTPS token endpoint required
 *   4. scope: the challenge's `scope`, else `scopes_supported`, else refuse
 *
 * What is NOT discovered: the RFC 8693 `audience` (a logical name, configured
 * per server until Curity accepts RFC 8707 `resource`), and the grant itself —
 * the agents hold a delegated user token and exchange it (packages/auth-curity
 * `exchangeToken`, unchanged); the spec's authorization-code flow needs a browser
 * these workloads do not have. Every failure is a typed CurityAuthError and the
 * agent answers with it; nothing degrades to a configured default.
 */

export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers?: string[];
  scopes_supported?: string[];
  bearer_methods_supported?: string[];
  /** Demo-local extension (RFC 9470 step-up), see docs/design.md. */
  acr_values_supported?: string[];
  [k: string]: unknown;
}

export interface McpAuthDiscovery {
  /** The configured server URL, trailing slashes stripped. */
  serverUrl: string;
  /** Where the PRM was actually fetched from. */
  resourceMetadataUrl: string;
  resourceMetadata: ProtectedResourceMetadata;
  /** `authorization_servers[0]`. */
  authorizationServer: string;
  authorizationServerMetadata: AuthorizationServerMetadata;
  tokenEndpoint: string;
  /** Space-joined scope to request. */
  scope: string;
  scopeSource: 'challenge' | 'scopes_supported';
  discoveredAt: number;
}

export const DISCOVERY_TTL_MS = 10 * 60_000;
export const MCP_PROTOCOL_VERSION = '2026-07-28';
const WELL_KNOWN_PRM = '/.well-known/oauth-protected-resource';

const DISCOVERY_CODES = new Set(['discovery_failed', 'resource_mismatch', 'cimd_unsupported', 'scope_unavailable']);

/** True for a failure to LEARN the authorization server; false for a refusal by it. */
export function isDiscoveryFailure(e: unknown): boolean {
  return e instanceof CurityAuthError && DISCOVERY_CODES.has(e.code);
}

const discoveryCache = new Map<string, McpAuthDiscovery>();

/** Test-only. */
export function _resetDiscoveryCache(): void {
  discoveryCache.clear();
}

function normalizeUrl(u: string): string {
  return u.replace(/\/+$/, '');
}

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

/** The spec's step 1: an MCP request without a token. Only a 401 is acceptable. */
async function probeUnauthenticated(serverUrl: string, fetchFn: FetchLike): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(serverUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
    });
  } catch (e) {
    throw new CurityAuthError(`unauthenticated probe of ${serverUrl} failed: ${describe(e)}`, 'discovery_failed', e);
  }
  if (res.status !== 401) {
    await res.body?.cancel().catch(() => undefined);
    throw new CurityAuthError(
      `unauthenticated probe of ${serverUrl} answered ${res.status}, expected 401 with a WWW-Authenticate challenge`,
      'discovery_failed',
    );
  }
  return res;
}

/** GET one RFC 9728 candidate. 404 → undefined (try the next); anything else non-2xx → throw. */
async function fetchPrm(url: string, fetchFn: FetchLike): Promise<ProtectedResourceMetadata | undefined> {
  const res = await fetchFn(url, {
    headers: { accept: 'application/json', 'mcp-protocol-version': MCP_PROTOCOL_VERSION },
  });
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const doc = (await res.json()) as unknown;
  if (!doc || typeof doc !== 'object' || typeof (doc as { resource?: unknown }).resource !== 'string') {
    throw new Error(`${url} is not a protected resource metadata document (no string "resource")`);
  }
  return doc as ProtectedResourceMetadata;
}

/**
 * RFC 9728 §3 well-known candidates for a server URL, in the MCP spec's order:
 * path-based first, root second.
 */
export function wellKnownPrmUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const root = `${u.origin}${WELL_KNOWN_PRM}`;
  return path ? [`${u.origin}${WELL_KNOWN_PRM}${path}`, root] : [root];
}

export async function discoverMcpAuthorization(
  serverUrl: string,
  opts: { fetchImpl?: FetchLike; challenge?: Response; force?: boolean; service?: string } = {},
): Promise<McpAuthDiscovery> {
  const key = normalizeUrl(serverUrl);
  const hit = discoveryCache.get(key);
  if (hit && !opts.force && Date.now() - hit.discoveredAt < DISCOVERY_TTL_MS) return hit;

  const fetchFn: FetchLike = opts.fetchImpl ?? fetch;
  const service = opts.service ?? 'mcp-client';

  // 1 + 2a. The challenge, and the metadata URL it names (if any).
  const challenge = opts.challenge ?? (await probeUnauthenticated(key, fetchFn));
  const { resourceMetadataUrl: fromHeader, scope: challengeScope } = extractWWWAuthenticateParams(challenge);
  await challenge.body?.cancel().catch(() => undefined);

  // 2b. The PRM: header URL, else well-known candidates in order.
  const candidates = fromHeader ? [fromHeader.href] : wellKnownPrmUrls(key);
  let prm: ProtectedResourceMetadata | undefined;
  let prmUrl = '';
  for (const url of candidates) {
    try {
      prm = await fetchPrm(url, fetchFn);
    } catch (e) {
      throw new CurityAuthError(`protected resource metadata: ${describe(e)}`, 'discovery_failed', e);
    }
    if (prm) {
      prmUrl = url;
      break;
    }
  }
  if (!prm) {
    throw new CurityAuthError(
      `no protected resource metadata for ${key} (tried ${candidates.join(', ')})`,
      'discovery_failed',
    );
  }

  // 2c. RFC 9728 §3.3: the document must describe THIS server.
  if (normalizeUrl(prm.resource) !== key) {
    throw new CurityAuthError(
      `protected resource metadata at ${prmUrl} describes ${prm.resource}, not ${key}`,
      'resource_mismatch',
    );
  }
  const authorizationServer = prm.authorization_servers?.[0];
  if (!authorizationServer) {
    throw new CurityAuthError(`protected resource metadata at ${prmUrl} lists no authorization_servers`, 'discovery_failed');
  }

  // 3. AS metadata (issuer echo, CIMD flag, HTTPS token endpoint).
  const as = await resolveAuthorizationServer(authorizationServer, { fetchImpl: fetchFn, force: opts.force });

  // 4. Scope selection: challenge first, then scopes_supported, never a default.
  let scope: string | undefined;
  let scopeSource: McpAuthDiscovery['scopeSource'] = 'challenge';
  if (challengeScope && challengeScope.trim() !== '') {
    scope = challengeScope.trim();
  } else if (prm.scopes_supported && prm.scopes_supported.length > 0) {
    scope = prm.scopes_supported.join(' ');
    scopeSource = 'scopes_supported';
  }
  if (!scope) {
    throw new CurityAuthError(
      `neither the 401 challenge nor scopes_supported at ${prmUrl} says which scope to request for ${key}`,
      'scope_unavailable',
    );
  }

  const discovery: McpAuthDiscovery = {
    serverUrl: key,
    resourceMetadataUrl: prmUrl,
    resourceMetadata: prm,
    authorizationServer,
    authorizationServerMetadata: as.metadata,
    tokenEndpoint: as.tokenEndpoint,
    scope,
    scopeSource,
    discoveredAt: Date.now(),
  };
  discoveryCache.set(key, discovery);

  oboLog({
    service,
    kind: 'DISCOVER',
    headline: `→ ${key}`,
    fields: {
      resource_metadata: prmUrl,
      resource: prm.resource,
      'authorization srv': authorizationServer,
      'token endpoint': as.tokenEndpoint,
      'scope selected': `${scope} (from ${scopeSource})`,
      'cimd supported': String(as.metadata.client_id_metadata_document_supported === true),
      'grant types': as.metadata.grant_types_supported?.join(' '),
    },
  });
  return discovery;
}

// The AuthProvider half (createMcpAuthProvider) is added in the next task.
export type { AuthProvider, UnauthorizedContext };
```

Add to `packages/agent-runtime/src/index.ts`:

```ts
export {
  discoverMcpAuthorization,
  isDiscoveryFailure,
  wellKnownPrmUrls,
  DISCOVERY_TTL_MS,
  type McpAuthDiscovery,
  type ProtectedResourceMetadata,
} from './mcp-oauth-client.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test -- src/mcp-oauth-client.test.ts`
Expected: PASS. The `DISCOVER` block prints to stdout during the happy-path tests; that is expected (set `OBO_LOG=off` to silence).

---

### Task 6: `createMcpAuthProvider` (the SDK `AuthProvider` seam)

**Files:**
- Modify: `packages/agent-runtime/src/mcp-oauth-client.ts`
- Modify: `packages/agent-runtime/src/mcp-oauth-client.test.ts`
- Modify: `packages/agent-runtime/src/index.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface McpExchangeInput { tokenEndpoint: string; scope: string; discovery: McpAuthDiscovery }
  export interface McpAuthProvider extends AuthProvider {
    discover(): Promise<McpAuthDiscovery>;       // cached discovery, no exchange
    acquire(): Promise<string>;                  // discovery + exchange, stores the token
    current(): { token?: string; discovery?: McpAuthDiscovery };
    token(): Promise<string | undefined>;        // SDK: per-request bearer
    onUnauthorized(ctx: UnauthorizedContext): Promise<void>; // SDK: 401 → re-acquire once
  }
  export function createMcpAuthProvider(opts: { serverUrl: string; service: string; exchange: (i: McpExchangeInput) => Promise<string>; fetchImpl?: FetchLike }): McpAuthProvider;
  ```
  Consumed by Task 7 (`openMcpToolset({ authProvider })`) and Tasks 8–9.

- [ ] **Step 1: Write the failing tests**

Append to `packages/agent-runtime/src/mcp-oauth-client.test.ts` (add `createMcpAuthProvider` to the import from `./mcp-oauth-client.js`, and `vi` to the vitest import):

```ts
describe('createMcpAuthProvider', () => {
  it('acquire() discovers then exchanges with the discovered token endpoint and scope; token() returns it', async () => {
    const { f } = fakeFetch(HAPPY);
    const exchange = vi.fn(async () => 'TOKEN-1');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 'agent-specialist', exchange, fetchImpl: f });
    expect(await p.token()).toBeUndefined();
    expect(await p.acquire()).toBe('TOKEN-1');
    expect(exchange).toHaveBeenCalledWith(
      expect.objectContaining({ tokenEndpoint: AS.token_endpoint, scope: 'ops:write' }),
    );
    expect(await p.token()).toBe('TOKEN-1');
    expect(p.current().discovery?.resourceMetadataUrl).toBe(PRM_URL);
  });

  it('discover() mints nothing', async () => {
    const { f } = fakeFetch(HAPPY);
    const exchange = vi.fn(async () => 'TOKEN-1');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 's', exchange, fetchImpl: f });
    const d = await p.discover();
    expect(d.scope).toBe('ops:write');
    expect(exchange).not.toHaveBeenCalled();
    expect(await p.token()).toBeUndefined();
  });

  it('onUnauthorized re-acquires with a forced discovery from the received challenge', async () => {
    const { f, calls } = fakeFetch(HAPPY);
    const exchange = vi.fn().mockResolvedValueOnce('TOKEN-1').mockResolvedValueOnce('TOKEN-2');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 's', exchange, fetchImpl: f });
    await p.acquire();
    const before = calls.length;
    const response = new Response(null, {
      status: 401,
      headers: { 'www-authenticate': `Bearer error="invalid_token", resource_metadata="${PRM_URL}"` },
    });
    await p.onUnauthorized({ response, serverUrl: new URL(SERVER), fetchFn: f });
    // Forced: the PRM and AS were fetched again (cache bypassed), no second probe (challenge supplied).
    expect(calls.slice(before)).toEqual([`GET ${PRM_URL}`, `GET ${AS_URL}`]);
    expect(exchange).toHaveBeenCalledTimes(2);
    expect(await p.token()).toBe('TOKEN-2');
  });

  it('onUnauthorized refuses to exchange or retry on an RFC 9470 step-up challenge', async () => {
    const { f } = fakeFetch(HAPPY);
    const exchange = vi.fn(async () => 'TOKEN-1');
    const p = createMcpAuthProvider({ serverUrl: SERVER, service: 's', exchange, fetchImpl: f });
    await p.acquire();
    const response = new Response(null, {
      status: 401,
      headers: {
        'www-authenticate': `Bearer realm="mcp-ops", error="insufficient_user_authentication", acr_values="mfa", resource_metadata="${PRM_URL}"`,
      },
    });
    await expect(p.onUnauthorized({ response, serverUrl: new URL(SERVER), fetchFn: f }))
      .rejects.toThrowError(expect.objectContaining({ code: 'step_up_required' }));
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('a discovery failure inside acquire() is logged as DENY once and rethrown with its code', async () => {
    const { f } = fakeFetch({ ...HAPPY, [`GET ${PRM_URL}`]: { body: { ...PRM, resource: 'https://other/mcp' } } });
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => { logs.push(String(s)); });
    try {
      const p = createMcpAuthProvider({ serverUrl: SERVER, service: 'agent-copilot', exchange: async () => 'x', fetchImpl: f });
      await expect(p.acquire()).rejects.toThrowError(expect.objectContaining({ code: 'resource_mismatch' }));
    } finally {
      spy.mockRestore();
    }
    expect(logs.filter((l) => l.includes('[agent-copilot] DENY')).length).toBe(1);
  });

  it('an exchange refusal is NOT double-logged here (exchangeToken already logs DENY)', async () => {
    const { f } = fakeFetch(HAPPY);
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s: unknown) => { logs.push(String(s)); });
    try {
      const p = createMcpAuthProvider({
        serverUrl: SERVER,
        service: 'agent-copilot',
        exchange: async () => { throw new CurityAuthError('needs mfa', 'invalid_scope'); },
        fetchImpl: f,
      });
      await expect(p.acquire()).rejects.toThrowError(expect.objectContaining({ code: 'invalid_scope' }));
    } finally {
      spy.mockRestore();
    }
    expect(logs.some((l) => l.includes('DENY'))).toBe(false);
  });
});
```

`oboLog` emits through `console.log` (`packages/auth-curity/src/obo-log.ts:168`), which is what the spy above captures. Run these two tests without `OBO_LOG=off`, or the log is suppressed and the DENY count is 0 for the wrong reason.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test -- src/mcp-oauth-client.test.ts`
Expected: FAIL — `createMcpAuthProvider` is not exported.

- [ ] **Step 3: Implement the provider**

Replace the trailing `// The AuthProvider half …` comment and the `export type` line in `packages/agent-runtime/src/mcp-oauth-client.ts` with:

```ts
export interface McpExchangeInput {
  tokenEndpoint: string;
  scope: string;
  discovery: McpAuthDiscovery;
}

/**
 * The SDK's minimal auth seam plus two explicit entry points the agents call at
 * the SAME places they used to call `obtainXToken`, so the specialist's gate
 * order (ops exchange → acr pre-check → open toolsets) is unchanged:
 *  - `discover()`  learns the AS without minting (the /tools probe's acr pre-check
 *                  needs the discovered scope + acr_values before any exchange);
 *  - `acquire()`   discover + exchange, stores the token;
 *  - `token()`     what the transport attaches to every request;
 *  - `onUnauthorized()` the transport's 401 hook: forced re-discovery from the
 *                  received challenge, one more exchange, then the SDK retries once.
 * One provider per toolset open: tokens are per subject and must never be shared
 * across users. The discovery cache underneath is process-global.
 */
export interface McpAuthProvider extends AuthProvider {
  discover(): Promise<McpAuthDiscovery>;
  acquire(): Promise<string>;
  current(): { token?: string; discovery?: McpAuthDiscovery };
  token(): Promise<string | undefined>;
  onUnauthorized(ctx: UnauthorizedContext): Promise<void>;
}

export function createMcpAuthProvider(opts: {
  serverUrl: string;
  service: string;
  exchange: (input: McpExchangeInput) => Promise<string>;
  fetchImpl?: FetchLike;
}): McpAuthProvider {
  let token: string | undefined;
  let discovery: McpAuthDiscovery | undefined;

  const discover = async (o: { force?: boolean; challenge?: Response } = {}): Promise<McpAuthDiscovery> => {
    try {
      discovery = await discoverMcpAuthorization(opts.serverUrl, {
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        service: opts.service,
        ...o,
      });
      return discovery;
    } catch (e) {
      // The ONE exit every discovery failure crosses (fact #31). Exchange refusals
      // are deliberately not logged here — exchangeToken's own catch already does.
      oboLog({
        service: opts.service,
        kind: 'DENY',
        headline: `→ ${opts.serverUrl} (discovery failed)`,
        fields: {
          error: e instanceof CurityAuthError ? e.code : 'discovery_failed',
          description: e instanceof Error ? e.message : String(e),
        },
      });
      throw e;
    }
  };

  const acquire = async (o: { force?: boolean; challenge?: Response } = {}): Promise<string> => {
    const d = await discover(o);
    token = await opts.exchange({ tokenEndpoint: d.tokenEndpoint, scope: d.scope, discovery: d });
    return token;
  };

  return {
    discover: () => discover(),
    acquire: () => acquire(),
    current: () => ({ token, discovery }),
    token: async () => token,
    onUnauthorized: async ({ response }) => {
      const { error } = extractWWWAuthenticateParams(response);
      if (error === 'insufficient_user_authentication') {
        // RFC 9470: more authentication from the USER, not a fresh token for the
        // agent. Never exchanged, never retried. The specialist's intercepting fetch
        // normally converts this before the transport sees it; this is defence in depth.
        throw new CurityAuthError(
          `step-up required: ${response.headers.get('www-authenticate') ?? ''}`,
          'step_up_required',
        );
      }
      await acquire({ force: true, challenge: response });
    },
  };
}
```

Add to the `index.ts` export block for this module: `createMcpAuthProvider, type McpAuthProvider, type McpExchangeInput`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test`
Expected: PASS for all agent-runtime tests.

---

### Task 7: `openMcpToolset` takes an `authProvider`

**Files:**
- Modify: `packages/agent-runtime/src/mcp-toolset.ts:47-99`
- Modify: `packages/agent-runtime/src/mcp-toolset.test.ts`

**Interfaces:**
- Produces: `openMcpToolset(opts: { url: string; authProvider: AuthProvider; clientName: string; label: string; fetchImpl?: typeof fetch }): Promise<McpToolset>`. `bearerToken` is removed. Consumed by Tasks 8–9.

- [ ] **Step 1: Write the failing test**

Append to `packages/agent-runtime/src/mcp-toolset.test.ts` (add `vi` and `beforeEach` to the vitest import):

```ts
const transportCtor = vi.fn();
vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/client')>();
  class FakeTransport {
    constructor(url: URL, opts: unknown) {
      transportCtor(url.href, opts);
    }
  }
  class FakeClient {
    async connect() {}
    async listTools() {
      return { tools: [] };
    }
    async close() {}
  }
  return { ...actual, StreamableHTTPClientTransport: FakeTransport, Client: FakeClient };
});

describe('openMcpToolset', () => {
  beforeEach(() => transportCtor.mockReset());

  it('hands the SDK transport the authProvider and sets no static Authorization header', async () => {
    const { openMcpToolset } = await import('./mcp-toolset.js');
    const authProvider = {
      token: async () => 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJhbGljZSJ9.',
      onUnauthorized: async () => {},
    };
    const ts = await openMcpToolset({ url: 'https://gw/ops/mcp', authProvider, clientName: 'c', label: 'l' });
    await ts.close();
    expect(transportCtor).toHaveBeenCalledTimes(1);
    const [, opts] = transportCtor.mock.calls[0] as [string, { authProvider?: unknown; requestInit?: { headers?: Record<string, string> } }];
    expect(opts.authProvider).toBe(authProvider);
    expect(opts.requestInit?.headers?.authorization).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test -- src/mcp-toolset.test.ts`
Expected: FAIL — TypeScript error (`authProvider` is not a known option / `bearerToken` missing), or `opts.authProvider` undefined.

- [ ] **Step 3: Implement**

In `packages/agent-runtime/src/mcp-toolset.ts` change the import and the function head:

```ts
import { Client, StreamableHTTPClientTransport, type AuthProvider } from '@modelcontextprotocol/client';
```

```ts
/**
 * Connect to an MCP Streamable HTTP server, discover its tools, and expose them
 * as AI-SDK tools.
 *
 * Authentication goes through the SDK's `authProvider` seam: the transport calls
 * `authProvider.token()` before every request and `onUnauthorized()` on a 401,
 * then retries once. The agents pass a `createMcpAuthProvider(...)` (see
 * mcp-oauth-client.ts) that has already run `acquire()`, so the first request
 * carries a bearer; a mid-session 401 (expiry, key rotation) re-runs discovery +
 * exchange without the agent code being involved.
 *
 * `clientName` names the MCP client + the oboLog `service`. `label` is used in
 * the call log headline (e.g. the target server name). `fetchImpl` lets a
 * caller intercept the raw HTTP response — used by agent-specialist to turn an
 * RFC 9470 401 into a typed StepUpRequiredError before the SDK's 401 seam runs.
 */
export async function openMcpToolset(opts: {
  url: string;
  authProvider: AuthProvider;
  clientName: string;
  label: string;
  fetchImpl?: typeof fetch;
}): Promise<McpToolset> {
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    authProvider: opts.authProvider,
    ...(opts.fetchImpl ? { fetch: opts.fetchImpl } : {}),
  });
  const tok = summarizeJwt((await opts.authProvider.token()) ?? '');
```

Everything after (`const client = new Client(…)`, `cachePartition: tok.sub ?? ''`, `oboLog` CALL, tool wiring) is unchanged.

- [ ] **Step 4: Run the tests and typecheck**

Run: `pnpm --filter @ai-agents-demo/agent-runtime test && pnpm --filter @ai-agents-demo/agent-runtime typecheck && pnpm --filter @ai-agents-demo/agent-runtime build`
Expected: PASS; typecheck clean; `dist` rebuilt for the agents.

---

### Task 8: agent-copilot becomes discovery-driven

**Files:**
- Modify: `apps/agent-copilot/src/config.ts`
- Modify: `apps/agent-copilot/src/mcp-client.ts`
- Create: `apps/agent-copilot/src/mcp-auth.ts`
- Modify: `apps/agent-copilot/src/llm-token.ts:81-95`
- Modify: `apps/agent-copilot/src/specialist-client.ts:92-106`
- Modify: `apps/agent-copilot/src/server.ts:197-242`
- Modify: `apps/agent-copilot/src/tools-route.ts`
- Modify: `apps/agent-copilot/tests/tools-route.test.ts`
- Create: `apps/agent-copilot/tests/mcp-auth.test.ts`
- Modify: `k8s/workloads/agent-copilot.yaml:86-104`

**Interfaces:**
- Consumes: `createMcpAuthProvider`, `resolveAuthorizationServer`, `isDiscoveryFailure`, `openMcpToolset({ authProvider })` from `@ai-agents-demo/agent-runtime` (Tasks 4–7).
- Produces: `buildObservabilityAuthProvider(opts: { cfg; subjectToken; subjectSub; subjectAcr; recordLastExchange?: boolean }): McpAuthProvider` in `mcp-auth.ts`. `obtainMcpToken` gains required `tokenEndpoint: string; scope: string`. `invalidateMcpTokenCache` is deleted.

- [ ] **Step 1: Write the failing tests**

Create `apps/agent-copilot/tests/mcp-auth.test.ts`:

```ts
/**
 * The copilot's observability auth provider wires discovery to the existing
 * exchange: the token endpoint and scope it exchanges with must be the ones
 * discovery returned, and the /tools probe's `recordLastExchange: false` must
 * reach the exchange (fact #34: probes are not flows).
 */
import { describe, it, expect, vi } from 'vitest';

const obtainMcpToken = vi.fn(async () => 'OBS_TOKEN');
vi.mock('../src/mcp-client.js', () => ({ obtainMcpToken: (...a: unknown[]) => obtainMcpToken(...a) }));

const createMcpAuthProvider = vi.fn();
vi.mock('@ai-agents-demo/agent-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ai-agents-demo/agent-runtime')>();
  return { ...actual, createMcpAuthProvider: (...a: unknown[]) => createMcpAuthProvider(...a) };
});

import { buildObservabilityAuthProvider } from '../src/mcp-auth.js';
import type { Config } from '../src/config.js';

const cfg = { mcpObservabilityUrl: 'https://mcp-gateway.localtest.me/observability/mcp' } as unknown as Config;

describe('buildObservabilityAuthProvider', () => {
  it('targets the configured server URL and exchanges with the DISCOVERED endpoint and scope', async () => {
    createMcpAuthProvider.mockImplementation((o: { serverUrl: string; exchange: (i: unknown) => Promise<string> }) => o);
    const p = buildObservabilityAuthProvider({ cfg, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa' }) as unknown as {
      serverUrl: string;
      service: string;
      exchange: (i: { tokenEndpoint: string; scope: string }) => Promise<string>;
    };
    expect(p.serverUrl).toBe(cfg.mcpObservabilityUrl);
    expect(p.service).toBe('agent-copilot');
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'obs:read' });
    expect(obtainMcpToken).toHaveBeenCalledWith(
      expect.objectContaining({ tokenEndpoint: 'https://as/token', scope: 'obs:read', subjectSub: 'alice', subjectAcr: 'mfa' }),
    );
  });

  it('passes recordLastExchange through so a probe is not recorded as a flow', async () => {
    createMcpAuthProvider.mockImplementation((o: { exchange: (i: unknown) => Promise<string> }) => o);
    const p = buildObservabilityAuthProvider({
      cfg, subjectToken: 'U', subjectSub: 'alice', subjectAcr: 'mfa', recordLastExchange: false,
    }) as unknown as { exchange: (i: { tokenEndpoint: string; scope: string }) => Promise<string> };
    await p.exchange({ tokenEndpoint: 'https://as/token', scope: 'obs:read' });
    expect(obtainMcpToken).toHaveBeenCalledWith(expect.objectContaining({ recordLastExchange: false }));
  });
});
```

Update `apps/agent-copilot/tests/tools-route.test.ts`: replace `obtainMcpToken: vi.fn(async () => 'OBS_TOKEN'),` in `deps()` with

```ts
    buildObservabilityAuthProvider: vi.fn(() => fakeProvider('OBS_TOKEN')),
```

and add above `deps`:

```ts
/** A provider whose acquire() resolves (or rejects) like the real one would. */
function fakeProvider(token: string, acquireError?: Error) {
  return {
    discover: vi.fn(async () => ({ scope: 'obs:read' })),
    acquire: vi.fn(async () => { if (acquireError) throw acquireError; return token; }),
    current: () => ({ token }),
    token: async () => token,
    onUnauthorized: async () => {},
  } as unknown as ReturnType<ToolTiersDeps['buildObservabilityAuthProvider']>;
}
```

Then find the existing test that makes `obtainMcpToken` throw for the read tier (search for `obtainMcpToken: vi.fn(async () => { throw`) and change it to `buildObservabilityAuthProvider: vi.fn(() => fakeProvider('', new CurityAuthError(<same message>, <same code>)))`. Add one test:

```ts
  it('acquires the read-tier token through the provider with recordLastExchange:false and opens the toolset with it', async () => {
    const d = deps();
    await collectToolTiers({ cfg, subject, deps: d });
    expect(d.buildObservabilityAuthProvider).toHaveBeenCalledWith(expect.objectContaining({ recordLastExchange: false }));
    expect(d.openMcpToolset).toHaveBeenCalledWith(
      expect.objectContaining({ url: cfg.mcpObservabilityUrl, authProvider: expect.objectContaining({ acquire: expect.any(Function) }) }),
    );
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm turbo run build --filter=@ai-agents-demo/agent-runtime && pnpm --filter @ai-agents-demo/agent-copilot test`
Expected: FAIL — `../src/mcp-auth.js` missing; tools-route types mismatch.

- [ ] **Step 3: Config**

In `apps/agent-copilot/src/config.ts` delete the `curityTokenEndpoint` and `mcpObservabilityScope` fields and their two `loadConfig` lines. Update the comment above `mcpObservabilityAudience`:

```ts
  /**
   * RFC 8693 `audience` for the MCP hop. The ONE per-server value that stays
   * configured: everything else about the hop (authorization server, token
   * endpoint, scope) is discovered from the server's 401 → RFC 9728 → RFC 8414
   * chain (packages/agent-runtime mcp-oauth-client.ts). It would be replaced by
   * the RFC 8707 `resource` parameter once Curity accepts it.
   */
  mcpObservabilityAudience: string;
```

- [ ] **Step 4: `mcp-client.ts`**

Change `obtainMcpToken`'s options and body:

```ts
export async function obtainMcpToken(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  subjectAcr: string;
  /** Discovered from the MCP server's authorization-server metadata (never configured). */
  tokenEndpoint: string;
  /** Discovered: the 401 challenge's `scope`, else the PRM's `scopes_supported`. */
  scope: string;
  recordLastExchange?: boolean;
}): Promise<string> {
  const { cfg, subjectToken, subjectSub, subjectAcr, tokenEndpoint, scope } = opts;
  const record = opts.recordLastExchange !== false;
  const key = { sub: subjectSub, scope, audience: cfg.mcpObservabilityAudience, acr: subjectAcr };
```

and in the `exchangeToken` call use `tokenEndpoint,` / `assertionAudience: tokenEndpoint,` / `scope,` in place of the `cfg.curityTokenEndpoint` and `cfg.mcpObservabilityScope` reads. Delete `invalidateMcpTokenCache` entirely (the provider's `onUnauthorized` replaces the retry it served). Keep `peekLastExchange` and the `openMcpToolset` re-export.

- [ ] **Step 5: `mcp-auth.ts`**

Create `apps/agent-copilot/src/mcp-auth.ts`:

```ts
import { createMcpAuthProvider, type McpAuthProvider } from '@ai-agents-demo/agent-runtime';
import { obtainMcpToken } from './mcp-client.js';
import type { Config } from './config.js';

/**
 * The copilot's MCP client identity for the read tier: discovery decides WHERE
 * to exchange and for WHICH scope; `obtainMcpToken` (unchanged RFC 8693 path,
 * cached per subject) decides everything else. One provider per request.
 */
export function buildObservabilityAuthProvider(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  subjectAcr: string;
  recordLastExchange?: boolean;
}): McpAuthProvider {
  return createMcpAuthProvider({
    serverUrl: opts.cfg.mcpObservabilityUrl,
    service: 'agent-copilot',
    exchange: ({ tokenEndpoint, scope }) =>
      obtainMcpToken({
        cfg: opts.cfg,
        subjectToken: opts.subjectToken,
        subjectSub: opts.subjectSub,
        subjectAcr: opts.subjectAcr,
        tokenEndpoint,
        scope,
        ...(opts.recordLastExchange === undefined ? {} : { recordLastExchange: opts.recordLastExchange }),
      }),
  });
}
```

- [ ] **Step 6: LLM and A2A exchanges resolve the token endpoint from the issuer**

In `apps/agent-copilot/src/llm-token.ts` add `import { resolveAuthorizationServer } from '@ai-agents-demo/agent-runtime';` and replace lines 81–95 with:

```ts
  const identity = await getCimdIdentity(cfg);
  // No MCP server to discover from on this hop (the LLM vendor is outside the
  // trust domain), so the AS is the configured issuer — but the token endpoint is
  // still READ from its RFC 8414 metadata, never configured.
  const as = await resolveAuthorizationServer(cfg.curityIssuer);
  const result = await exchangeToken({
    tokenEndpoint: as.tokenEndpoint,
    clientId: cfg.agentClientId,
    clientAuth: {
      method: 'private_key_jwt',
      privateKeyPkcs8Pem: cfg.agentPrivateKeyPem,
      kid: identity.kid,
      assertionAudience: as.tokenEndpoint,
    },
    subjectToken,
    actorToken: svid.jwt,
    audience: cfg.llmGatewayAudience,
    scope: cfg.llmGatewayScope,
  });
```

Make the same substitution in `apps/agent-copilot/src/specialist-client.ts` lines 92–106 (`const as = await resolveAuthorizationServer(cfg.curityIssuer);` before `exchangeToken`, then `tokenEndpoint: as.tokenEndpoint` and `assertionAudience: as.tokenEndpoint`), adding the same import.

- [ ] **Step 7: `server.ts` read path**

Replace lines 197–242 of `apps/agent-copilot/src/server.ts` (from `let mcpToken: string;` through the `openMcpToolset` try/catch) with:

```ts
    // Spec-shaped MCP client: discover the server's authorization server from its
    // own 401 → RFC 9728 → RFC 8414 chain, then exchange. A failure to LEARN the
    // AS is an availability problem (502); a refusal BY it is authorization (403).
    const mcpAuth = buildObservabilityAuthProvider({
      cfg,
      subjectToken: authed.bearerToken!,
      subjectSub: userSub,
      subjectAcr: userAcr,
    });
    try {
      await mcpAuth.acquire();
    } catch (e) {
      if (isDiscoveryFailure(e)) {
        console.error('[agent-copilot] MCP authorization discovery failed', e);
        res.status(502).json({ error: 'mcp_unavailable', error_description: (e as Error).message });
        return;
      }
      console.error('[agent-copilot] token-exchange failed', e);
      const code = e instanceof CurityAuthError ? e.code : 'exchange_failed';
      res.status(403).json({ error: code, error_description: (e as Error).message });
      return;
    }

    let llmToken: string;
    try {
      llmToken = await obtainLlmToken({
        cfg,
        subjectToken: authed.bearerToken!,
        subjectSub: userSub,
        subjectAcr: userAcr,
      });
    } catch (e) {
      console.error('[agent-copilot] llm token exchange failed', e);
      res.status(502).json({ error: 'llm_unavailable' });
      return;
    }
    const llm = buildLlm(cfg, { accessToken: llmToken });

    let toolset;
    try {
      toolset = await openMcpToolset({
        url: cfg.mcpObservabilityUrl,
        authProvider: mcpAuth,
        clientName: 'agent-copilot',
        label: 'mcp-observability',
      });
    } catch (e) {
      // A 401 mid-connect already went through the provider's onUnauthorized
      // (forced re-discovery + one more exchange) inside the SDK; what reaches
      // here is a second refusal or an unreachable server.
      console.error('[agent-copilot] failed to open MCP toolset', e);
      res.status(502).json({ error: 'mcp_unavailable' });
      return;
    }
```

Update the imports at the top of `server.ts`: remove `obtainMcpToken` and `invalidateMcpTokenCache` from the `./mcp-client.js` import (keep `openMcpToolset`), add `import { buildObservabilityAuthProvider } from './mcp-auth.js';` and `import { isDiscoveryFailure } from '@ai-agents-demo/agent-runtime';`.

- [ ] **Step 8: `tools-route.ts`**

Replace the `obtainMcpToken` import with `import { buildObservabilityAuthProvider } from './mcp-auth.js';` and `import { openMcpToolset } from './mcp-client.js';`. In `ToolTiersDeps` replace `obtainMcpToken: typeof obtainMcpToken;` with `buildObservabilityAuthProvider: typeof buildObservabilityAuthProvider;`. Rewrite `listReadTier`:

```ts
async function listReadTier(cfg: Config, subject: ToolsSubject, deps: ToolTiersDeps): Promise<TierStatus> {
  // PROBE, not a flow: recordLastExchange:false keeps the OBO-chain view truthful (fact #34).
  const auth = deps.buildObservabilityAuthProvider({
    cfg,
    subjectToken: subject.bearer,
    subjectSub: subject.sub,
    subjectAcr: subject.acr,
    recordLastExchange: false,
  });
  try {
    await auth.acquire();
  } catch (e) {
    return authFailure(e);
  }
  let toolset: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  try {
    toolset = await deps.openMcpToolset({
      url: cfg.mcpObservabilityUrl,
      authProvider: auth,
      clientName: 'agent-copilot',
      label: 'mcp-observability (tools/list probe)',
    });
    return { status: 'ok', tools: toolInfos(toolset.listed, subject.roles ?? []) };
  } catch (e) {
    return { status: 'error', error: 'mcp_unavailable', description: String(e) };
  } finally {
    await toolset?.close();
  }
}
```

and in `defaultDeps` replace `obtainMcpToken,` with `buildObservabilityAuthProvider,`. Extend `authFailure` so discovery failures read as errors, not denials:

```ts
function authFailure(e: unknown): TierStatus {
  if (isDiscoveryFailure(e)) {
    return { status: 'error', error: (e as CurityAuthError).code, description: (e as Error).message };
  }
  if (e instanceof CurityAuthError) {
    return { status: 'denied', error: e.code, description: e.message };
  }
  return { status: 'error', error: 'exchange_failed', description: String(e) };
}
```

(import `isDiscoveryFailure` from `@ai-agents-demo/agent-runtime`).

- [ ] **Step 9: Manifest**

In `k8s/workloads/agent-copilot.yaml` delete the `CURITY_TOKEN_ENDPOINT` and `MCP_OBSERVABILITY_SCOPE` entries and change `MCP_OBSERVABILITY_URL` to:

```yaml
            - name: MCP_OBSERVABILITY_URL
              # The agentgateway MCP front door, by its PUBLIC name. The agent is a
              # spec-shaped MCP client: it learns the authorization server from this
              # URL's 401 → RFC 9728 → RFC 8414 chain, and RFC 9728 requires the
              # document's `resource` to equal the URL the client uses — which is why
              # this is the edge host (scripts/cluster-routing.sh aliases it into the
              # pod) and not the in-cluster Service name. The gateway validates
              # aud=mcp-gateway, applies per-tool CEL RBAC, and re-exchanges (via the
              # co-located exchange-shim) to a narrowed aud=mcp-observability token
              # before forwarding to the origin.
              value: https://mcp-gateway.localtest.me/observability/mcp
```

Keep `MCP_OBSERVABILITY_AUDIENCE: mcp-gateway` with the comment: `# The one static per-server value: the RFC 8693 audience (logical name). Replaced by RFC 8707 resource once Curity supports it.`

- [ ] **Step 10: Run the tests and typecheck**

Run: `pnpm --filter @ai-agents-demo/agent-copilot typecheck && pnpm --filter @ai-agents-demo/agent-copilot test`
Expected: typecheck clean (any remaining reference to `curityTokenEndpoint`, `mcpObservabilityScope`, `invalidateMcpTokenCache` or `bearerToken` is a compile error to fix); all copilot tests PASS.

---

### Task 9: agent-specialist becomes discovery-driven

**Files:**
- Modify: `apps/agent-specialist/src/config.ts`
- Modify: `apps/agent-specialist/src/mcp-ops-client.ts`
- Modify: `apps/agent-specialist/src/obs-token.ts`
- Modify: `apps/agent-specialist/src/llm-token.ts:54-68`
- Create: `apps/agent-specialist/src/mcp-auth.ts`
- Modify: `apps/agent-specialist/src/executor.ts`
- Modify: `apps/agent-specialist/src/tools-route.ts`
- Modify: `apps/agent-specialist/src/server.ts:94`, `apps/agent-specialist/src/agent-card.ts:33`
- Modify: `apps/agent-specialist/tests/executor.test.ts`, `apps/agent-specialist/tests/tools-route.test.ts`
- Modify: `k8s/workloads/agent-specialist.yaml:76-96`

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces: `buildOpsAuthProvider({ cfg, subjectToken, subjectSub, recordLastExchange? })` and `buildObsAuthProvider({ cfg, subjectToken })` in `mcp-auth.ts`; `RemediationDeps` gains `buildOpsAuthProvider`/`buildObsAuthProvider` and loses `obtainOpsToken`/`obtainObsToken`/`fetchResourceMetadata`; `stepUpFromDiscovery(d: McpAuthDiscovery, cfg: Config): RemediationResult` exported from `executor.ts`.

- [ ] **Step 1: Write the failing tests**

In `apps/agent-specialist/tests/executor.test.ts`:

Replace the `cfg` fixture with:

```ts
const cfg = {
  requiredAcr: 'mfa',
  mcpOpsUrl: 'https://mcp-gateway.localtest.me/ops/mcp',
  mcpObservabilityUrl: 'https://mcp-gateway.localtest.me/observability/mcp',
  llmGatewayUrl: 'http://gw:8080/llm',
  llmGatewayAudience: 'llm-gateway',
  llmGatewayScope: 'llm:invoke',
} as never;

/** What discovery returns for the ops route in the cluster. */
const OPS_DISCOVERY = {
  serverUrl: 'https://mcp-gateway.localtest.me/ops/mcp',
  resourceMetadataUrl: 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp',
  resourceMetadata: { resource: 'https://mcp-gateway.localtest.me/ops/mcp', scopes_supported: ['ops:write'], acr_values_supported: ['mfa'] },
  authorizationServer: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
  tokenEndpoint: 'https://curity.localtest.me/oauth/v2/oauth-token',
  scope: 'ops:write',
  scopeSource: 'scopes_supported',
  discoveredAt: 0,
} as never;

/** A provider whose discover() resolves and acquire() resolves or rejects. */
function fakeProvider(token: string, acquireError?: Error, discovery: unknown = OPS_DISCOVERY) {
  return {
    discover: vi.fn(async () => discovery),
    acquire: vi.fn(async () => { if (acquireError) throw acquireError; return token; }),
    current: () => ({ token, discovery }),
    token: async () => token,
    onUnauthorized: async () => {},
  };
}
```

Replace the `deps()` factory with:

```ts
function deps(over: Partial<RemediationDeps> = {}): RemediationDeps {
  return {
    buildOpsAuthProvider: vi.fn(() => fakeProvider('ops-token')) as never,
    buildObsAuthProvider: vi.fn(() => fakeProvider('obs-token')) as never,
    obtainLlmToken: vi.fn().mockResolvedValue('test-llm-token'),
    openMcpToolset: vi.fn().mockResolvedValue({ tools: {}, close: vi.fn() }),
    runLlm: vi.fn().mockResolvedValue({ text: 'done: restarted api-gateway', steps: [] }),
    buildStepUpInterceptingFetch: vi.fn(() => fetch),
    ...over,
  };
}
```

Replace the test `'routes an invalid_scope on the write-token exchange to step-up (no LLM, no toolset)'` body's `deps({...})` with:

```ts
    const d = deps({
      buildOpsAuthProvider: vi.fn(() => fakeProvider('', new CurityAuthError('needs mfa', 'invalid_scope'))) as never,
    });
```

Replace the test `'fetches RFC 9728 metadata from mcp-ops itself, not from the agentgateway origin'` with:

```ts
  it('builds the step-up challenge from the DISCOVERED gateway PRM (acr_values_supported, scope, resource_metadata URL)', async () => {
    const d = deps({
      buildOpsAuthProvider: vi.fn(() => fakeProvider('', new CurityAuthError('needs mfa', 'invalid_scope'))) as never,
    });
    const out = await runRemediation({
      cfg, bearer: 'b', goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out.kind).toBe('step-up');
    if (out.kind === 'step-up') {
      expect(out.payload.data).toEqual({
        acrValues: 'mfa',
        scope: 'ops:write',
        resourceMetadata: 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp',
      });
    }
  });

  it('answers with the discovery error (not step-up) when the ops server cannot be discovered', async () => {
    const d = deps({
      buildOpsAuthProvider: vi.fn(() => ({
        ...fakeProvider('ops-token'),
        discover: vi.fn(async () => { throw new CurityAuthError('no PRM', 'discovery_failed'); }),
      })) as never,
    });
    const out = await runRemediation({
      cfg, bearer: 'b', goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(out).toEqual({ kind: 'error', error: 'discovery_failed', description: 'no PRM' });
    expect(d.openMcpToolset).not.toHaveBeenCalled();
  });

  it('hands the write toolset the ops provider and the DISCOVERED scope to the step-up interceptor', async () => {
    const d = deps();
    await runRemediation({
      cfg, bearer: 'b', goal: 'restart api-gateway',
      verified: { payload: { sub: 'alice', acr: 'mfa' } } as never,
      deps: d,
    });
    expect(d.buildStepUpInterceptingFetch).toHaveBeenCalledWith('ops:write', expect.anything());
    expect(d.openMcpToolset).toHaveBeenCalledWith(
      expect.objectContaining({ url: cfg.mcpOpsUrl, authProvider: expect.objectContaining({ acquire: expect.any(Function) }) }),
    );
  });
```

Update every other test in the file that overrides `obtainOpsToken` / `obtainObsToken` to use `buildOpsAuthProvider` / `buildObsAuthProvider` with `fakeProvider(...)` (search for `obtainOpsToken:` and `obtainObsToken:`; the `access_denied` test becomes `buildOpsAuthProvider: vi.fn(() => fakeProvider('', new CurityAuthError('bob lacks sre', 'access_denied'))) as never`). Where a test asserted `d.obtainOpsToken` was/wasn't called, assert on the provider's `acquire` via `(d.buildOpsAuthProvider as ReturnType<typeof vi.fn>).mock.results[0]?.value.acquire` or, simpler, on `d.runLlm`/`d.openMcpToolset` as those tests already do.

In `apps/agent-specialist/tests/tools-route.test.ts` replace the `cfg`, `deps` and the first two tests with:

```ts
const cfg = {
  mcpOpsUrl: 'https://mcp-gateway.localtest.me/ops/mcp',
  requiredAcr: 'mfa',
} as unknown as Config;

const OPS_DISCOVERY = {
  resourceMetadataUrl: 'https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp',
  resourceMetadata: { resource: cfg.mcpOpsUrl, scopes_supported: ['ops:write'], acr_values_supported: ['mfa'] },
  scope: 'ops:write',
};

function fakeProvider(token: string, acquireError?: Error) {
  return {
    discover: vi.fn(async () => OPS_DISCOVERY),
    acquire: vi.fn(async () => { if (acquireError) throw acquireError; return token; }),
    current: () => ({ token, discovery: OPS_DISCOVERY }),
    token: async () => token,
    onUnauthorized: async () => {},
  };
}

function deps(overrides: Partial<ToolsDeps> = {}): ToolsDeps {
  return {
    buildOpsAuthProvider: vi.fn(() => fakeProvider('OPS_TOKEN')) as never,
    openMcpToolset: vi.fn(async () => ({
      tools: {},
      listed: [
        { name: 'restart_deployment', description: 'Restart a deployment' },
        { name: 'scale_deployment', description: 'Scale a deployment' },
      ],
      close: vi.fn(async () => {}),
    })) as unknown as ToolsDeps['openMcpToolset'],
    ...overrides,
  };
}

describe('listOpsTools', () => {
  it('reports step-up from the DISCOVERED acr_values_supported and scope, WITHOUT minting a privileged token', async () => {
    const provider = fakeProvider('OPS_TOKEN');
    const d = deps({ buildOpsAuthProvider: vi.fn(() => provider) as never });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'alice', acr: 'html-form' }, deps: d });
    expect(out).toEqual({ status: 'step-up', acrValues: 'mfa', scope: 'ops:write' });
    expect(provider.discover).toHaveBeenCalled();
    expect(provider.acquire).not.toHaveBeenCalled();
  });

  it("reports a denial with Curity's error when the ops:write exchange is refused (role gate)", async () => {
    const d = deps({
      buildOpsAuthProvider: vi.fn(() => fakeProvider('', new CurityAuthError('Role sre or oncall required', 'access_denied'))) as never,
    });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'bob', acr: 'mfa' }, deps: d });
    expect(out).toEqual({ status: 'denied', error: 'access_denied', description: 'Role sre or oncall required' });
  });

  it('reports an error (not a denial) when discovery itself fails', async () => {
    const d = deps({
      buildOpsAuthProvider: vi.fn(() => ({
        ...fakeProvider('OPS_TOKEN'),
        discover: vi.fn(async () => { throw new CurityAuthError('no PRM', 'discovery_failed'); }),
      })) as never,
    });
    const out = await listOpsTools({ cfg, bearer: 'B', claims: { sub: 'alice', acr: 'mfa' }, deps: d });
    expect(out).toEqual({ status: 'error', error: 'discovery_failed', description: 'no PRM' });
  });
```

Update the remaining tests in that file that override `obtainOpsToken` the same way.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @ai-agents-demo/agent-specialist test`
Expected: FAIL — `RemediationDeps` has no `buildOpsAuthProvider`; `stepUpFromMetadata` still calls `fetchResourceMetadata`.

- [ ] **Step 3: Config**

In `apps/agent-specialist/src/config.ts` delete `curityTokenEndpoint`, `mcpOpsScope`, `mcpOpsResourceMetadataUrl`, `mcpOpsMetadataUrl` (with its doc comment) and `mcpObservabilityScope`, from both the interface and `loadConfig`. Put the same audience comment as Task 8 Step 3 above `mcpOpsAudience` and `mcpObservabilityAudience`.

- [ ] **Step 4: `mcp-ops-client.ts`**

Delete the `ProtectedResourceMetadata` interface, `metadataCache`, `METADATA_TTL_MS`, `fetchResourceMetadata` and `_resetMetadataCache` (lines 9–47). Change `obtainOpsToken`'s options to add `tokenEndpoint: string; scope: string;` (same doc comments as Task 8 Step 4), destructure them, and use `tokenEndpoint,` / `assertionAudience: tokenEndpoint,` / `scope,` in the `exchangeToken` call. `parseStepUpChallenge`, `StepUpSink`, `buildStepUpInterceptingFetch`, `peekLastExchange` are unchanged.

- [ ] **Step 5: `obs-token.ts` and `llm-token.ts`**

`obtainObsToken(opts: { cfg: Config; subjectToken: string; tokenEndpoint: string; scope: string })`: use `tokenEndpoint` / `assertionAudience: tokenEndpoint` / `scope` in place of the `cfg.curityTokenEndpoint` / `cfg.mcpObservabilityScope` reads.

`llm-token.ts` lines 54–68: same change as Task 8 Step 6 (`const as = await resolveAuthorizationServer(cfg.curityIssuer);`, `tokenEndpoint: as.tokenEndpoint`, `assertionAudience: as.tokenEndpoint`), with `import { resolveAuthorizationServer } from '@ai-agents-demo/agent-runtime';`.

- [ ] **Step 6: `mcp-auth.ts`**

Create `apps/agent-specialist/src/mcp-auth.ts`:

```ts
import { createMcpAuthProvider, type McpAuthProvider } from '@ai-agents-demo/agent-runtime';
import { obtainOpsToken } from './mcp-ops-client.js';
import { obtainObsToken } from './obs-token.js';
import type { Config } from './config.js';

/**
 * The specialist's two MCP client identities. Discovery decides WHERE to
 * exchange and for WHICH scope; the unchanged RFC 8693 helpers decide the rest.
 * The WRITE provider is also where the role gate and the ACR TIA fire (inside
 * `exchange`), so `acquire()` is the same gate `obtainOpsToken` used to be.
 */
export function buildOpsAuthProvider(opts: {
  cfg: Config;
  subjectToken: string;
  subjectSub: string;
  recordLastExchange?: boolean;
}): McpAuthProvider {
  return createMcpAuthProvider({
    serverUrl: opts.cfg.mcpOpsUrl,
    service: 'agent-specialist',
    exchange: ({ tokenEndpoint, scope }) =>
      obtainOpsToken({
        cfg: opts.cfg,
        subjectToken: opts.subjectToken,
        subjectSub: opts.subjectSub,
        tokenEndpoint,
        scope,
        ...(opts.recordLastExchange === undefined ? {} : { recordLastExchange: opts.recordLastExchange }),
      }),
  });
}

export function buildObsAuthProvider(opts: { cfg: Config; subjectToken: string }): McpAuthProvider {
  return createMcpAuthProvider({
    serverUrl: opts.cfg.mcpObservabilityUrl,
    service: 'agent-specialist',
    exchange: ({ tokenEndpoint, scope }) =>
      obtainObsToken({ cfg: opts.cfg, subjectToken: opts.subjectToken, tokenEndpoint, scope }),
  });
}
```

- [ ] **Step 7: `executor.ts`**

Imports: replace the `./mcp-ops-client.js` import with `import { buildStepUpInterceptingFetch, type StepUpSink } from './mcp-ops-client.js';`, delete the `./obs-token.js` import, add `import { buildOpsAuthProvider, buildObsAuthProvider } from './mcp-auth.js';` and `import { buildLlm, openMcpToolset, isDiscoveryFailure, type McpAuthDiscovery } from '@ai-agents-demo/agent-runtime';`.

`RemediationDeps`: replace `obtainOpsToken`, `obtainObsToken` and `fetchResourceMetadata` with

```ts
  buildOpsAuthProvider: typeof buildOpsAuthProvider;
  buildObsAuthProvider: typeof buildObsAuthProvider;
```

Rewrite steps 1–3 of `remediate` (from `// 1. Acquire the WRITE token` through the `catch` after both toolsets open):

```ts
  // 1. Discover the WRITE server's authorization server (mints nothing), then
  //    acquire the write token — the role gate / scope gate / ACR TIA fire here.
  const opsAuth = deps.buildOpsAuthProvider({ cfg, subjectToken: bearer, subjectSub: sub });
  let opsDiscovery: McpAuthDiscovery;
  try {
    opsDiscovery = await opsAuth.discover();
  } catch (e) {
    if (e instanceof CurityAuthError) return { kind: 'error', error: e.code, description: e.message };
    return { kind: 'error', error: 'specialist_failure', description: String(e) };
  }
  try {
    await opsAuth.acquire();
  } catch (e) {
    if (e instanceof CurityAuthError && e.code === 'invalid_scope') {
      return stepUpFromDiscovery(opsDiscovery, cfg);
    }
    if (e instanceof CurityAuthError) return { kind: 'error', error: e.code, description: e.message };
    return { kind: 'error', error: 'specialist_failure', description: String(e) };
  }

  // 2. Deterministic acr pre-check — challenge BEFORE the LLM runs.
  const acr = String(verified.payload.acr ?? '');
  if (acr !== cfg.requiredAcr) {
    return stepUpFromDiscovery(opsDiscovery, cfg);
  }

  // 3. Acquire the READ token (no MFA needed) and open BOTH toolsets.
  let readSet: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  let writeSet: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  const stepUpSink: StepUpSink = {};
  try {
    const obsAuth = deps.buildObsAuthProvider({ cfg, subjectToken: bearer });
    await obsAuth.acquire();
    readSet = await deps.openMcpToolset({
      url: cfg.mcpObservabilityUrl,
      authProvider: obsAuth,
      clientName: 'agent-specialist',
      label: 'mcp-observability',
    });
    writeSet = await deps.openMcpToolset({
      url: cfg.mcpOpsUrl,
      authProvider: opsAuth,
      clientName: 'agent-specialist',
      label: 'mcp-ops',
      // The interceptor runs in FRONT of the SDK's 401 seam, so an RFC 9470
      // challenge becomes a StepUpRequiredError before onUnauthorized could see it.
      fetchImpl: deps.buildStepUpInterceptingFetch(opsDiscovery.scope, stepUpSink),
    });
  } catch (e) {
    await readSet?.close();
    await writeSet?.close();
    if (e instanceof CurityAuthError && e.code === 'invalid_scope') {
      return stepUpFromDiscovery(opsDiscovery, cfg);
    }
    if (e instanceof CurityAuthError) return { kind: 'error', error: e.code, description: e.message };
    return { kind: 'error', error: 'specialist_failure', description: String(e) };
  }
```

Keep the existing comments above these blocks where they still apply. Replace `stepUpFromMetadata` with:

```ts
/**
 * Build the RFC 9470 challenge from what DISCOVERY learned about the ops server:
 * the gateway's RFC 9728 document (its `acr_values_supported` demo extension and
 * the URL it was fetched from) and the scope selected for it. Nothing here is
 * configured, so the challenge describes the server that actually refused.
 */
export function stepUpFromDiscovery(d: McpAuthDiscovery, cfg: Config): RemediationResult {
  const err = new StepUpRequiredError({
    acrValues: d.resourceMetadata.acr_values_supported?.[0] ?? cfg.requiredAcr,
    resourceMetadata: d.resourceMetadataUrl,
    scope: d.scope,
  });
  return { kind: 'step-up', payload: err.toPayload() };
}
```

In `buildExecutor`, the `deps` object becomes:

```ts
  const deps: RemediationDeps = {
    buildOpsAuthProvider,
    buildObsAuthProvider,
    obtainLlmToken,
    openMcpToolset,
    runLlm,
    buildStepUpInterceptingFetch,
  };
```

Remove the now-unused `isDiscoveryFailure` import if nothing uses it (the `error: e.code` mapping already surfaces discovery codes).

- [ ] **Step 8: `tools-route.ts`**

Replace the `obtainOpsToken` import with `import { buildOpsAuthProvider } from './mcp-auth.js';`, `ToolsDeps.obtainOpsToken` with `buildOpsAuthProvider: typeof buildOpsAuthProvider;`, `defaultDeps` with `{ buildOpsAuthProvider, openMcpToolset }`, and the body of `listOpsTools` from step 1 through step 3 with:

```ts
  // 0. Discovery (mints nothing): the pre-check below needs the discovered scope
  //    and acr_values to phrase its challenge, exactly as remediate() does.
  const auth = deps.buildOpsAuthProvider({ cfg, subjectToken: bearer, subjectSub: claims.sub, recordLastExchange: false });
  let d;
  try {
    d = await auth.discover();
  } catch (e) {
    if (e instanceof CurityAuthError) return { status: 'error', error: e.code, description: e.message };
    return { status: 'error', error: 'discovery_failed', description: String(e) };
  }

  // 1. Same deterministic pre-check as remediate(): challenge before any exchange.
  if ((claims.acr ?? '') !== cfg.requiredAcr) {
    return {
      status: 'step-up',
      acrValues: d.resourceMetadata.acr_values_supported?.[0] ?? cfg.requiredAcr,
      scope: d.scope,
    };
  }

  // 2. The privileged exchange — Curity's role gate and the ACR TIA fire here.
  try {
    await auth.acquire();
  } catch (e) {
    if (e instanceof CurityAuthError) {
      return { status: 'denied', error: e.code, description: e.message };
    }
    return { status: 'error', error: 'exchange_failed', description: String(e) };
  }

  // 3. What the gateway lets an ops:write caller list.
  let toolset: Awaited<ReturnType<typeof openMcpToolset>> | undefined;
  try {
    toolset = await deps.openMcpToolset({
      url: cfg.mcpOpsUrl,
      authProvider: auth,
      clientName: 'agent-specialist',
      label: 'mcp-ops (tools/list probe)',
    });
```

(the rest of the function is unchanged). Update the header comment's numbered list to start at `0. discovery (nothing minted)`.

- [ ] **Step 9: Loose ends**

`apps/agent-specialist/src/server.ts:94`: delete the `mcp_ops_scope: cfg.mcpOpsScope,` line. `apps/agent-specialist/src/agent-card.ts:33`: change the description to `` `Curity-issued JWT, aud=${cfg.expectedAudience}, act.sub=agent-copilot.` ``.

`k8s/workloads/agent-specialist.yaml`: delete `CURITY_TOKEN_ENDPOINT`, `MCP_OPS_SCOPE`, `MCP_OBSERVABILITY_SCOPE`; set

```yaml
            - name: MCP_OPS_URL
              value: https://mcp-gateway.localtest.me/ops/mcp
            - name: MCP_OBSERVABILITY_URL
              value: https://mcp-gateway.localtest.me/observability/mcp
```

with the same explanatory comment as Task 8 Step 9 above the first of them, and the audience comment on both `*_AUDIENCE` entries.

- [ ] **Step 10: Run the tests and typecheck**

Run: `pnpm --filter @ai-agents-demo/agent-specialist typecheck && pnpm --filter @ai-agents-demo/agent-specialist test`
Expected: clean typecheck; all specialist tests PASS. Then run the whole workspace once: `pnpm turbo run build typecheck test` — Expected: PASS everywhere (the web package is untouched; its `route.test.ts` fixture still uses the old PRM URL as opaque data, which is fine).

---

### Task 10: Gateway well-known routes, public host, certificates, routing, Makefile, shell contract test

**Files:**
- Modify: `k8s/workloads/agentgateway-config.yaml:75-91` and `:152-168`
- Modify: `k8s/istio/gateway-edge.yaml` (Gateway servers after the `https-mcp-observability` block; append a VirtualService)
- Modify: `scripts/mkcert-bootstrap.sh:8-17`
- Modify: `scripts/apply-tls-secrets.sh:14-26`
- Modify: `scripts/cluster-routing.sh:54-72`
- Modify: `Makefile:30-37`, `:103-106`, `:610-627`
- Create: `scripts/test-mcp-discovery-config.sh`

**Interfaces:**
- Produces: `https://mcp-gateway.localtest.me/{observability,ops}/mcp` reachable from the host, from the web pod and from both agent pods; `GET https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/{observability,ops}/mcp` served by the gateway; ops PRM carries `acr_values_supported: ["mfa"]`.

- [ ] **Step 1: Write the failing shell contract test**

Create `scripts/test-mcp-discovery-config.sh`:

```bash
#!/usr/bin/env bash
# Contract test: the pieces that make the gateway's RFC 9728 document REAL and
# REACHABLE all exist. Each was a bug first — the gateway's 401 advertised a
# well-known URL that its own routes did not match and that no edge host served.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
fail=0
check() { # $1 description, $2 file, $3 fixed-string
  if grep -qF -- "$3" "$REPO_ROOT/$2"; then green "OK   $1"; else red "FAIL $1 ($2 lacks: $3)"; fail=1; fi
}

CFG=k8s/workloads/agentgateway-config.yaml
check "gateway routes the observability well-known path" "$CFG" "exact: /.well-known/oauth-protected-resource/observability/mcp"
check "gateway routes the ops well-known path"           "$CFG" "exact: /.well-known/oauth-protected-resource/ops/mcp"
check "ops PRM advertises acr_values_supported"          "$CFG" "acrValuesSupported:"
check "edge Gateway serves mcp-gateway.localtest.me"     k8s/istio/gateway-edge.yaml "- mcp-gateway.localtest.me"
check "edge routes the host to the gateway Service"      k8s/istio/gateway-edge.yaml "host: agentgateway.mcp.svc.cluster.local"
check "mkcert issues the host's cert"                    scripts/mkcert-bootstrap.sh '"mcp-gateway.localtest.me"'
check "TLS secret is applied at the edge"                scripts/apply-tls-secrets.sh "mcp-gateway.localtest.me|istio-ingress|mcp-gateway-tls"
check "routing aliases the host into pods"               scripts/cluster-routing.sh '"mcp-gateway.localtest.me"'
check "Makefile knows the host"                          Makefile "HOST_MCP_GATEWAY"

# The agents must call the SAME URL the PRM advertises (RFC 9728 §3.3).
for f in k8s/workloads/agent-copilot.yaml k8s/workloads/agent-specialist.yaml; do
  check "$f calls the gateway by its public name" "$f" "value: https://mcp-gateway.localtest.me/"
  if grep -qE 'CURITY_TOKEN_ENDPOINT|MCP_(OPS|OBSERVABILITY)_SCOPE|MCP_OPS_(RESOURCE_)?METADATA_URL' "$REPO_ROOT/$f"; then
    red "FAIL $f still carries static discovery config"; fail=1
  else
    green "OK   $f carries no static discovery config"
  fi
done

# cluster-routing must alias the host for the THREE pods that resolve it.
for who in "web/web" "agents/agent-copilot" "agents/agent-specialist"; do
  if awk '/^extra_hosts_for\(\)/,/^}/' "$REPO_ROOT/scripts/cluster-routing.sh" | grep -qF "$who"; then
    green "OK   cluster-routing aliases extra hosts for $who"
  else
    red "FAIL cluster-routing extra_hosts_for lacks $who"; fail=1
  fi
done

exit $fail
```

Add to the Makefile's `test-scripts` target: `	bash scripts/test-mcp-discovery-config.sh`.

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/test-mcp-discovery-config.sh`
Expected: several `FAIL` lines (well-known matches, edge host, cert, routing, Makefile), exit 1. The two agent manifest checks pass already after Tasks 8–9.

- [ ] **Step 3: Gateway config**

In `k8s/workloads/agentgateway-config.yaml`, observability route (line 77 onward):

```yaml
    - name: observability
      matches:
      - path:
          pathPrefix: /observability/mcp
      # RFC 9728: the gateway only SERVES the protected-resource document for a
      # request that matched this route (mcp/auth.rs `apply_token_validation`
      # short-circuits on the well-known path, but routing happens first), so the
      # well-known path must be matched here too. Without this the 401 below
      # advertises a URL that answers 404 "route not found" — a dangling pointer
      # that any spec-shaped client fails closed on.
      - path:
          exact: /.well-known/oauth-protected-resource/observability/mcp
```

Ops route (line 154 onward), same shape with `/ops/mcp`, and extend its `resourceMetadata`:

```yaml
          resourceMetadata:
            resource: https://mcp-gateway.localtest.me/ops/mcp
            scopesSupported:
            - ops:write
            bearerMethodsSupported:
            - header
            # NON-STANDARD, demo-local (RFC 9470 step-up): the ACR this tier needs.
            # agentgateway flattens extra keys into the document and snake_cases
            # them (types/agent.rs ResourceMetadata::to_rfc_json), so this becomes
            # `acr_values_supported`. Mirrors mcp-ops's own PRM; the specialist's
            # step-up challenge is built from THIS document now.
            acrValuesSupported:
            - mfa
```

Validate the RENDERED config offline (fact #29; the tracked file's LLM block is a sentinel region that `make render-gateway-config` fills in): `make render-gateway-config && docker run --rm -v "$PWD/.gen/agentgateway-config.yaml:/cfg.yaml:ro" -e AZURE_OPENAI_ENDPOINT=https://x -e LLM_API_KEY=x ghcr.io/agentgateway/agentgateway:v1.4.1 -f /cfg.yaml --validate-only` (image pinned in `k8s/workloads/agentgateway.yaml:149`). Expected: passes schema validation; it may then fail on the JWKS fetch, which is past validation. Validation does not check CEL, but this change adds none.

- [ ] **Step 4: Edge and certificates**

`k8s/istio/gateway-edge.yaml`: after the `https-mcp-observability` server block add

```yaml
    # agentgateway (MCP front door): the agents call it by THIS name, because the
    # RFC 9728 document it serves says `resource: https://mcp-gateway.localtest.me/…`
    # and a spec-shaped client checks that the resource equals the URL it uses.
    - port:
        number: 443
        name: https-mcp-gateway
        protocol: HTTPS
      tls:
        mode: SIMPLE
        credentialName: mcp-gateway-tls
      hosts:
        - mcp-gateway.localtest.me
```

and append

```yaml
---
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: mcp-gateway
  namespace: istio-ingress
spec:
  hosts:
    - mcp-gateway.localtest.me
  gateways:
    - edge
  http:
    - route:
        - destination:
            host: agentgateway.mcp.svc.cluster.local
            port:
              number: 8080
```

`scripts/mkcert-bootstrap.sh`: add `  "mcp-gateway.localtest.me"` to `HOSTS`. `scripts/apply-tls-secrets.sh`: add the line `mcp-gateway.localtest.me|istio-ingress|mcp-gateway-tls` to `ENTRIES`.

- [ ] **Step 5: Routing**

In `scripts/cluster-routing.sh` replace lines 56–72 with:

```bash
# RFC 9728: on a step-up challenge the web BFF fetches the protected-resource
# metadata document to learn the authorization server, and the two agents run
# the full discovery chain (401 → resource_metadata → PRM → RFC 8414) against the
# agentgateway. The URLs involved are PUBLIC https://*.localtest.me identifiers —
# rewriting them to cluster-internal names would defeat the point of a stable
# resource identifier (a spec-shaped client checks PRM.resource == the URL it
# calls). Inside a pod those hosts resolve to 127.0.0.1 (the pod itself), so each
# consumer needs the same ingress alias Curity gets.
RESOURCE_HOSTS=("mcp-ops.localtest.me" "mcp-observability.localtest.me" "mcp-gateway.localtest.me")
# The agents call the MCP front door by its public name (MCP_*_URL in
# k8s/workloads/agent-*.yaml) — see the RFC 9728 note above.
AGENT_MCP_HOSTS=("mcp-gateway.localtest.me")

# extra_hosts_for <ns> <deploy> — hostnames this target needs aliased BEYOND
# $CURITY_HOST, one per line. (bash 3.2 on macOS: no associative arrays.)
extra_hosts_for() {
  case "$1/$2" in
    web/web) printf '%s\n' "${RESOURCE_HOSTS[@]}" ;;
    agents/agent-copilot|agents/agent-specialist) printf '%s\n' "${AGENT_MCP_HOSTS[@]}" ;;
  esac
}
```

`verify_routing` already iterates `extra_hosts_for`, so `make routing-check` covers the new aliases with no further change.

- [ ] **Step 6: Makefile**

After `HOST_MCP_OBS` add `HOST_MCP_GATEWAY  ?= mcp-gateway.localtest.me`. In the `urls` target, after the mcp-observability line add:

```make
	@printf '    %-41s https://$(HOST_MCP_GATEWAY)/.well-known/oauth-protected-resource/observability/mcp\n' 'agentgateway PRM (read tier)'
	@printf '    %-41s https://$(HOST_MCP_GATEWAY)/.well-known/oauth-protected-resource/ops/mcp\n' 'agentgateway PRM (write tier)'
	@printf '    %-41s https://$(HOST_CURITY)/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous\n' 'Curity RFC 8414 metadata'
```

- [ ] **Step 7: Run the contract tests**

Run: `make test-scripts`
Expected: every `OK` line in the new script; the existing three scripts still pass.

---

### Task 11: `smoke-mcp-discovery.sh`

**Files:**
- Create: `scripts/smoke-mcp-discovery.sh`
- Modify: `Makefile:521-523` (add `smoke-mcp-discovery` to `smoke` and a target)

**Interfaces:**
- Produces: `make smoke-mcp-discovery` exits 0 only when the live chain is spec-conformant end to end. Needs no token, so it runs before the token-dependent smokes.

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
# Smoke test for MCP-spec authorization DISCOVERY (2026-07-28 "Authorization
# Server Discovery"), walked from the host exactly as a spec-shaped client would:
#
#   [1/4] agentgateway, both routes: unauthenticated POST → 401 whose
#         WWW-Authenticate names a resource_metadata URL.
#   [2/4] GET that URL → 200; `resource` equals the route URL (RFC 9728 §3.3);
#         `authorization_servers[0]` present; the ops document carries the demo's
#         `acr_values_supported` extension.
#   [3/4] The authorization server: RFC 8414 path-insertion URL → `issuer` echoes,
#         `client_id_metadata_document_supported` is true, `token_endpoint` is https.
#   [4/4] The origin MCP servers: unauthenticated POST → 401 with resource_metadata
#         AND scope; a garbage bearer → 401 error="invalid_token".
#
# No token is needed. Requires: curl, python3 (both already required by the repo).
set -uo pipefail

GATEWAY_HOST="${GATEWAY_HOST:-https://mcp-gateway.localtest.me}"
OBS_HOST="${OBS_HOST:-https://mcp-observability.localtest.me}"
OPS_HOST="${OPS_HOST:-https://mcp-ops.localtest.me}"
CURL="curl -sk -m 10"

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
note()   { printf '==> %s\n' "$*"; }
die()    { red "  $*"; exit 1; }

PROBE_BODY='{"jsonrpc":"2.0","id":0,"method":"ping"}'

# probe <url> [bearer] → prints "<status>\n<www-authenticate>"
probe() {
  local auth=()
  [[ -n "${2:-}" ]] && auth=(-H "authorization: Bearer $2")
  $CURL -o /dev/null -D - -X POST -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2026-07-28' \
    "${auth[@]}" -d "$PROBE_BODY" "$1" \
    | awk 'NR==1{split($0,a," "); s=a[2]} tolower($1)=="www-authenticate:"{sub(/^[^:]*: */,""); w=$0} END{print s; print w}'
}
# param <header> <name> → the quoted value of name="…" or empty
param() { printf '%s' "$1" | sed -n "s/.*$2=\"\([^\"]*\)\".*/\1/p"; }
# jget <json> <python-expr over d>
jget() { python3 -c 'import sys,json; d=json.load(sys.stdin); print('"$2"')' <<<"$1" 2>/dev/null; }

for route in observability ops; do
  URL="$GATEWAY_HOST/$route/mcp"
  note "[1/4] $URL unauthenticated → 401 + resource_metadata"
  OUT=$(probe "$URL"); STATUS=${OUT%%$'\n'*}; WWW=${OUT#*$'\n'}
  [[ "$STATUS" == "401" ]] || die "expected 401, got $STATUS"
  PRM_URL=$(param "$WWW" resource_metadata)
  [[ -n "$PRM_URL" ]] || die "no resource_metadata in: $WWW"
  green "  OK  $PRM_URL"

  note "[2/4] GET $PRM_URL"
  PRM=$($CURL -w '\n%{http_code}' "$PRM_URL"); CODE=${PRM##*$'\n'}; PRM=${PRM%$'\n'*}
  [[ "$CODE" == "200" ]] || die "PRM answered $CODE (dangling resource_metadata — is the well-known route matched and the host routed at the edge?)"
  RES=$(jget "$PRM" 'd["resource"]')
  [[ "${RES%/}" == "${URL%/}" ]] || die "PRM resource '$RES' != '$URL' (RFC 9728 §3.3)"
  AS=$(jget "$PRM" 'd["authorization_servers"][0]')
  [[ -n "$AS" ]] || die "PRM has no authorization_servers"
  SCOPES=$(jget "$PRM" '" ".join(d.get("scopes_supported",[]))')
  [[ -n "$SCOPES" ]] || die "PRM has no scopes_supported (a client could not pick a scope)"
  if [[ "$route" == "ops" ]]; then
    ACR=$(jget "$PRM" 'd.get("acr_values_supported",[""])[0]')
    [[ "$ACR" == "mfa" ]] || die "ops PRM lacks acr_values_supported=[mfa] (specialist step-up would fall back to config)"
  fi
  green "  OK  resource matches; AS=$AS; scopes='$SCOPES'"

  note "[3/4] authorization server metadata for $AS (RFC 8414 path-insertion form first)"
  ORIGIN=$(python3 -c 'import sys,urllib.parse as u; p=u.urlparse(sys.argv[1]); print(f"{p.scheme}://{p.netloc}", p.path.rstrip("/"))' "$AS")
  AS_ORIGIN=${ORIGIN%% *}; AS_PATH=${ORIGIN#* }
  META_URL="$AS_ORIGIN/.well-known/oauth-authorization-server$AS_PATH"
  META=$($CURL -w '\n%{http_code}' "$META_URL"); CODE=${META##*$'\n'}; META=${META%$'\n'*}
  [[ "$CODE" == "200" ]] || die "$META_URL answered $CODE"
  ISS=$(jget "$META" 'd["issuer"]')
  [[ "$ISS" == "$AS" ]] || die "issuer '$ISS' does not echo '$AS' (RFC 8414 §3.3 — a client MUST reject this)"
  CIMD=$(jget "$META" 'str(d.get("client_id_metadata_document_supported")).lower()')
  [[ "$CIMD" == "true" ]] || die "client_id_metadata_document_supported is not true — the agents could not register"
  TE=$(jget "$META" 'd["token_endpoint"]')
  [[ "$TE" == https://* ]] || die "token_endpoint '$TE' is not https"
  green "  OK  issuer echoes; CIMD supported; token_endpoint=$TE"
done

note "[4/4] origin MCP servers: 401 challenges carry resource_metadata + scope; garbage bearer → invalid_token"
for H in "$OBS_HOST" "$OPS_HOST"; do
  OUT=$(probe "$H/mcp"); STATUS=${OUT%%$'\n'*}; WWW=${OUT#*$'\n'}
  [[ "$STATUS" == "401" ]] || die "$H: expected 401, got $STATUS"
  [[ -n "$(param "$WWW" resource_metadata)" ]] || die "$H: no resource_metadata in: $WWW"
  [[ -n "$(param "$WWW" scope)" ]] || die "$H: no scope in: $WWW"
  OUT=$(probe "$H/mcp" 'eyJhbGciOiJub25lIn0.e30.'); STATUS=${OUT%%$'\n'*}; WWW=${OUT#*$'\n'}
  [[ "$STATUS" == "401" ]] || die "$H: garbage bearer → expected 401, got $STATUS"
  [[ "$(param "$WWW" error)" == "invalid_token" ]] || die "$H: expected error=\"invalid_token\", got: $WWW"
  [[ -n "$(param "$WWW" resource_metadata)" ]] || die "$H: invalid-token 401 lacks resource_metadata"
  green "  OK  $H"
done

green "==> MCP authorization discovery is spec-conformant end to end."
```

Make it executable: `chmod +x scripts/smoke-mcp-discovery.sh`.

- [ ] **Step 2: Wire it into the Makefile**

Change the `smoke` line to `smoke: routing-check smoke-mcp-discovery smoke-obo smoke-a2a smoke-stepup smoke-llm smoke-mcp-protocol smoke-gateway-authz` and add after `smoke-obo`:

```make
.PHONY: smoke-mcp-discovery
smoke-mcp-discovery: ## Smoke: MCP-spec discovery chain (401 → RFC 9728 → RFC 8414) at the gateway + origin 401 challenges. Needs no token.
	bash scripts/smoke-mcp-discovery.sh
```

- [ ] **Step 3: Run it against the current cluster to see it fail for the right reason**

Run: `make smoke-mcp-discovery`
Expected (before Task 13 deploys): `[1/4]` passes (the gateway already emits `resource_metadata`), `[2/4]` dies with "PRM answered 000/404 (dangling resource_metadata …)". That failure text is the regression this script exists to catch.

---

### Task 12: Documentation

**Files:**
- Modify: `CLAUDE.md` (fact #21 bullets, fact #34, new fact #37, Commands list)
- Modify: `docs/design.md:72-86` (agent-runtime table), `:729-760` (config table), new subsection after "The specialist's remediation loop"
- Modify: `docs/architecture.md:147-152`, `:557-566`
- Modify: `docs/demo.md:768-786` (troubleshooting), `:346-350` (endpoints)

- [ ] **Step 1: CLAUDE.md**

In fact #21, after the bullet "**extAuthz → co-located `exchange-shim` = the OBO hop.**" add:

```markdown
    - **The gateway's RFC 9728 document is served ONLY for requests that match a
      route, and agents reach the gateway by its PUBLIC name.** `mcpAuthentication`
      makes the 401 advertise `resource_metadata="https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/<route>"`,
      but `mcp/auth.rs` answers the well-known path only after routing, so each MCP
      route carries a second `exact: /.well-known/oauth-protected-resource/<path>`
      match (mirrors upstream `examples/mcp-authentication`). Until 2026-09-24 that
      match was missing and the host had no edge listener — the 401 pointed at a URL
      that answered `404 route not found`. Now `mcp-gateway.localtest.me` is a TLS
      host on the edge (`gateway-edge.yaml`, `apply-tls-secrets.sh`,
      `mkcert-bootstrap.sh`), aliased into the web pod AND both agent pods by
      `cluster-routing.sh`, and `MCP_*_URL` on the agents is that public URL — RFC
      9728 §3.3 has the client check `resource == the URL it calls`, so the
      in-cluster Service name cannot be used. Extra `resourceMetadata` keys are
      flattened + snake_cased into the document (`acrValuesSupported` →
      `acr_values_supported`). `make smoke-mcp-discovery` walks the chain;
      `make test-scripts` pins the config.
```

In fact #34, in the "**Probes are not flows.**" bullet, replace "`/tools` reuses `obtainMcpToken` / `obtainSpecialistToken` / `obtainOpsToken`, which stamp those slots on cache hits too, so the probes pass `recordLastExchange: false`" with "`/tools` reuses the agents' auth providers (`buildObservabilityAuthProvider` / `buildOpsAuthProvider`, whose `exchange` callbacks are `obtainMcpToken` / `obtainOpsToken`) and `obtainSpecialistToken`, which stamp those slots on cache hits too, so the probes pass `recordLastExchange: false`". Replace the sentence "The MCP servers build their rows from the last tool call's slot" bullet's mention of the specialist reading mcp-ops's PRM, if any, with nothing (it does not mention it; skip).

Add a new fact after #36:

```markdown
37. **The agents are spec-shaped MCP clients: the authorization server, token
    endpoint and scope of every MCP hop are DISCOVERED, and the only static
    per-server inputs are the URL and the RFC 8693 `audience`.**
    `packages/agent-runtime/src/mcp-oauth-client.ts` runs MCP 2026-07-28's sequence
    with the SDK's own helpers: unauthenticated POST → 401 → `resource_metadata`
    (else well-known path-form, then root) → RFC 9728 PRM (its `resource` MUST equal
    the URL called, trailing slash aside) → `authorization_servers[0]` → RFC 8414 /
    OIDC metadata (issuer-echo checked by the SDK; `client_id_metadata_document_supported`
    MUST be true; HTTPS `token_endpoint`) → scope = the challenge's `scope`, else
    `scopes_supported`, else refuse. Cached 10 min per server URL; one `DISCOVER`
    OBO-log block per cold run. `createMcpAuthProvider` wraps it as the SDK's
    `AuthProvider`: `acquire()` = discovery + the UNCHANGED `exchangeToken`,
    `onUnauthorized()` = forced re-discovery + one more exchange (the transport
    retries once), and an RFC 9470 challenge is never exchanged or retried. The
    non-MCP hops (LLM, A2A delegation) resolve the token endpoint from
    `CURITY_ISSUER`'s metadata via `resolveAuthorizationServer`, so
    `CURITY_TOKEN_ENDPOINT` no longer exists anywhere on the agents; nor do
    `MCP_*_SCOPE`, `MCP_OPS_RESOURCE_METADATA_URL`, `MCP_OPS_METADATA_URL`. Gotchas:
    - **Discovery failures are 502, exchange refusals are 403.** `isDiscoveryFailure`
      (`discovery_failed`/`resource_mismatch`/`cimd_unsupported`/`scope_unavailable`)
      separates "could not learn the AS" from "the AS said no". Don't collapse them.
    - **The specialist's step-up challenge is built from the DISCOVERED gateway PRM**
      (`stepUpFromDiscovery`: `acr_values_supported[0]`, the selected scope, the PRM
      URL) — so the ops route's `resourceMetadata` MUST carry `acrValuesSupported`.
    - **`RFC 8707 resource` is deliberately absent** (Curity does not accept it yet);
      the configured `audience` is the placeholder for it. Switching audiences to
      resource URIs touches the Curity policy, the gateway `audiences`, the shim and
      every smoke script — a separate change.
    - **The gateway probe expects exactly 401.** A route that answers 200 unauthenticated
      is refused (`discovery_failed`), on purpose: a server that does not require a
      token is not one to hand a token to.
```

In the Commands list add `make smoke-mcp-discovery # MCP-spec discovery chain at the gateway + origin 401 challenges (no token needed)` next to `make smoke`.

- [ ] **Step 2: design.md**

In the agent-runtime table (line 72–86) change the `mcp-toolset.ts` row's signature to `openMcpToolset({url, authProvider, …})` and its first sentence to "Connects to an MCP server over Streamable HTTP through the SDK's `authProvider` seam (per-request bearer from `token()`, one re-acquire via `onUnauthorized()` on 401; revision pinned to 2026-07-28, …)". Add two rows:

```markdown
| `mcp-oauth-client.ts` | `discoverMcpAuthorization(serverUrl, opts?)` → `McpAuthDiscovery`, `createMcpAuthProvider({serverUrl, service, exchange})` → `McpAuthProvider`, `isDiscoveryFailure`, `wellKnownPrmUrls` | The MCP 2026-07-28 client side of authorization: unauthenticated probe → `WWW-Authenticate` → RFC 9728 PRM (resource must equal the server URL) → RFC 8414/OIDC AS metadata (issuer echo, CIMD flag, HTTPS token endpoint) → scope selection (challenge, else `scopes_supported`, else refuse). Fail-closed with typed `CurityAuthError` codes; 10-min cache per server; one `DISCOVER` log per cold run. The provider's `acquire()` calls the agent-supplied `exchange` (the unchanged RFC 8693 helper); `onUnauthorized()` forces re-discovery and exchanges once more; an RFC 9470 challenge is never retried. |
| `authorization-server.ts` | `resolveAuthorizationServer(issuer, opts?)` → `{issuer, tokenEndpoint, metadata}` | RFC 8414/OIDC discovery for hops with no MCP server to discover from (LLM egress, A2A delegation): the issuer is configured, the token endpoint is read from metadata. Same validations and cache as the MCP path. |
```

In the config table (line 736 onward): delete the `CURITY_TOKEN_ENDPOINT` row and the `MCP_OPS_METADATA_URL` row; change the `<DOWNSTREAM>_URL / _AUDIENCE / _SCOPE` row to:

```markdown
| `<DOWNSTREAM>_URL` / `_AUDIENCE` | exchange clients | the next hop's address and RFC 8693 exchange audience. **For MCP hops that is all:** the authorization server, token endpoint and scope are discovered (`mcp-oauth-client.ts`), and the MCP servers' URL is the agentgateway's PUBLIC name (`https://mcp-gateway.localtest.me/<tier>/mcp`) because RFC 9728 requires the PRM `resource` to equal the URL the client calls. `_SCOPE` survives only on the non-MCP hops (`SPECIALIST_SCOPE`, `LLM_GATEWAY_SCOPE`). |
```

After the "The specialist's remediation loop" section add:

```markdown
### How an agent learns where to get its MCP token (discovery)

Both agents are MCP clients in the sense of the 2026-07-28 authorization chapter:
they start with the server URL and their CIMD identity and learn everything else
from the server. `createMcpAuthProvider` runs, per toolset open:

1. `POST <serverUrl>` with no token → `401`, `WWW-Authenticate: Bearer resource_metadata="…"`.
   Anything but 401 is `discovery_failed`.
2. `GET resource_metadata` (else `/.well-known/oauth-protected-resource<path>`, then the
   root) → the PRM. `resource` must equal the server URL → else `resource_mismatch`.
3. `GET` RFC 8414 metadata for `authorization_servers[0]` (SDK helper, path-insertion
   form first, issuer echo enforced). `client_id_metadata_document_supported` must be
   `true` → else `cimd_unsupported`. `token_endpoint` must be HTTPS.
4. Scope = the challenge's `scope`, else `scopes_supported` → else `scope_unavailable`.
5. `exchange({tokenEndpoint, scope})` — the agent's unchanged `obtainXToken`, i.e.
   `exchangeToken` with the configured `audience` and the SVID as actor.

The result is cached ten minutes per server URL. The SDK transport then attaches
`token()` to every request; on a 401 it calls `onUnauthorized()`, which re-runs
steps 2–5 with the cache bypassed and the received challenge as step 1, and
retries once. An `insufficient_user_authentication` challenge is never exchanged
or retried (the specialist's intercepting fetch normally converts it first).

What is not discovered, and why: the RFC 8693 `audience` (RFC 8707 `resource` is
not yet accepted by Curity; the logical name is its stand-in), and the grant (the
agents hold a delegated user token; the spec's authorization-code flow needs a
browser they do not have). The MCP spec's own scope-based step-up (403
`insufficient_scope` → scope union) is not exercised because the demo's step-up is
RFC 9470 — see the note under *Resource-server middleware*.
```

- [ ] **Step 3: architecture.md**

Replace lines 147–152 with:

```markdown
The arrows above are the request/OBO flow. The edge gateway also terminates TLS
for the `curity`, `copilot`/`specialist` (CIMD), `mcp-ops`/`mcp-observability` and
`mcp-gateway` hosts. For Curity, the agents and the two origin MCP servers that is
purely so their discovery/`.well-known` documents are reachable over a trusted TLS
cert. For `mcp-gateway.localtest.me` it is more: the agents CALL the MCP front door
by that name, because they are spec-shaped MCP clients that discover the
authorization server from the gateway's own RFC 9728 document, and RFC 9728 has
the client check that the document's `resource` equals the URL it uses. The
agent→gateway hop therefore enters through the edge; the gateway→MCP→API hops stay
in-mesh over ztunnel mTLS.
```

In the standards table add rows and edit one:

```markdown
| **RFC 8414** authorization-server metadata | the agents read Curity's `token_endpoint` and `client_id_metadata_document_supported` from `/.well-known/oauth-authorization-server/oauth/v2/oauth-anonymous`; nothing about the token endpoint is configured |
| **RFC 9728** protected-resource metadata | MCP/API `.well-known/oauth-protected-resource`, served by the origin servers AND by agentgateway per route; advertised in every 401 (`resource_metadata`) and in step-up challenges; the agents discover the AS from it and check `resource` against the URL they call |
| **MCP authorization (2026-07-28)** | servers: 401/403 challenges with `resource_metadata` + `scope`, RFC 6750 codes; clients: discovery chain, scope-selection order, CIMD gating. Deviations: RFC 8707 `resource` deferred (Curity), grant is RFC 8693 not authorization-code, step-up is RFC 9470 |
```

(Replace the existing RFC 9728 row rather than duplicating it.)

- [ ] **Step 4: demo.md**

In §5.4 / the endpoints list near line 346 add the two gateway PRM URLs and the RFC 8414 URL (same three lines as the Makefile `urls` target). In §8 Troubleshooting add:

```markdown
| `502 mcp_unavailable` with `discovery_failed` / `resource_mismatch` in the agent log | The agent could not walk 401 → RFC 9728 → RFC 8414 against `https://mcp-gateway.localtest.me`. Run `make smoke-mcp-discovery` (no token needed): a `PRM answered 404/000` means the gateway's well-known route match or the edge host is missing (`make apply`); a `resource … != …` means `MCP_*_URL` and the gateway's `resourceMetadata.resource` disagree; `make routing-check` catches a pod without the `mcp-gateway.localtest.me` alias. |
| `502 mcp_unavailable` with `cimd_unsupported` | Curity's metadata no longer advertises `client_id_metadata_document_supported: true` — the `<ephemeral-client>` block was removed or Curity is not the AS the PRM names. |
```

Also mention in §6 (observability walkthrough) that traces now show an `istio-ingress` span between the agent and agentgateway for MCP calls, and that `kubectl logs` shows one `DISCOVER` block per MCP server after an agent restart.

- [ ] **Step 5: Verify docs render**

Run: `grep -n "CURITY_TOKEN_ENDPOINT\|MCP_OPS_METADATA_URL\|serves no /.well-known" CLAUDE.md docs/*.md README.md`
Expected: no hits except historical files under `docs/superpowers/`. Mermaid blocks untouched.

---

### Task 13: Build, deploy, verify end to end

**Files:** none new. Cluster state.

- [ ] **Step 1: Full workspace check**

Run: `pnpm turbo run build typecheck test && make test-scripts`
Expected: all green.

- [ ] **Step 2: Certificates and TLS secrets**

Run: `make certs && make tls-secrets`
Expected: `✓ mcp-gateway.localtest.me` from mkcert; `✓ istio-ingress/mcp-gateway-tls`.

- [ ] **Step 3: Apply manifests, gateway config, edge, routing**

Run: `make apply && kubectl -n mcp rollout restart deploy/agentgateway && kubectl -n mcp rollout status deploy/agentgateway`
Expected: `make apply` renders the gateway config into the `agentgateway-config` ConfigMap, applies `k8s/istio/gateway-edge.yaml` (new server + VirtualService) and the agent/MCP manifests, then `cluster-routing.sh` patches the aliases and its final `verify_routing` prints `Verified: all 8 targets …`. The explicit restart is required: `make apply` updates the ConfigMap but does not restart agentgateway (only `make configure-llm` does), and the pod reads its config at boot. If the Istio ingress rollout deadlocks on KIND after the Gateway change, delete the old `istio-ingress` pod by hand (memory: istio-ingress-hostport-rollout-deadlock).

- [ ] **Step 4: Images**

Run: `make images IMAGES="agent-copilot agent-specialist mcp-observability mcp-ops"` then `kubectl -n agents rollout restart deploy/agent-copilot deploy/agent-specialist && kubectl -n mcp rollout restart deploy/mcp-observability deploy/mcp-ops && make status`
Expected: all pods Ready. (`kind load` never restarts pods; the restart is mandatory — memory: kind-load-needs-rollout-restart.)

- [ ] **Step 5: Discovery smoke**

Run: `make smoke-mcp-discovery`
Expected: all four sections green, ending `MCP authorization discovery is spec-conformant end to end.`

- [ ] **Step 6: Behavioural smokes**

Run: `make routing-check && SMOKE_SUBJECT_TOKEN=<fresh alice token from the web UI /api/dev/token> SMOKE_ALICE_PASSWORD=<password> make smoke`
Expected: every smoke passes. If `smoke-a2a` fails at the gateway with a TLS or DNS error inside the agent pod, the alias is missing: `make routing`.

- [ ] **Step 7: Logs and UI**

Run: `kubectl -n agents logs deploy/agent-specialist -c agent --since=10m | grep -A8 'DISCOVER'`
Expected: exactly one `DISCOVER` block per MCP server since the restart (two for the specialist), showing `resource_metadata: https://mcp-gateway.localtest.me/.well-known/oauth-protected-resource/ops/mcp`, `authorization srv`, `token endpoint`, `scope selected : ops:write (from scopes_supported)`, `cimd supported : true`, followed by the usual `EXCHANGE`/`CALL` blocks. Then drive a read and a restart from `https://app.localtest.me` as alice: the read answers; the restart without MFA prompts for TOTP, and the challenge's `resource_metadata` in the BFF response is the gateway PRM URL; the OBO ledger and Grafana trace still show the full chain (with an added ingress span before the gateway).

- [ ] **Step 8: Report**

Summarize what was verified, and remind the user that nothing has been committed on `feat/mcp-spec-shaped-clients`.
