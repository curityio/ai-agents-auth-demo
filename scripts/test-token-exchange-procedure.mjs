#!/usr/bin/env node
// Contract tests for k8s/curity/procedures/token-exchange.js — the RFC 8693 policy brain.
//
// The procedure runs inside Curity's Nashorn engine (ES5.1) with a handful of injected
// globals (`exceptionFactory`, `logger`, `secondsUntil`, `Java`, `Packages`). Nashorn is
// not available on the host, so this file loads the REAL procedure source into a
// `node:vm` context and stubs exactly those globals. jose4j is stubbed too: the stub
// checks header `kid` ∈ resolver, `aud`, `exp` and `sub` but does NOT verify a
// signature — signature verification is jose4j's job and is exercised by the live
// smoke scripts (`make smoke`). What is under test here is the policy: per-client
// audience/scope narrowing, the role gate, `act`/`may_act` nesting, error semantics
// and the JWKS cache behaviour.
//
// Run: node scripts/test-token-exchange-procedure.mjs   (part of `make test-scripts`)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(here, '..', 'k8s', 'curity', 'procedures', 'token-exchange.js'), 'utf8');

const COPILOT_CLIENT = 'https://copilot.localtest.me/.well-known/oauth-client';
const SPECIALIST_CLIENT = 'https://specialist.localtest.me/.well-known/oauth-client';
const TD = 'spiffe://demo.curity.local';
const SVID_COPILOT = TD + '/ns/agents/sa/agent-copilot';
const SVID_SPECIALIST = TD + '/ns/agents/sa/agent-specialist';
const SVID_GATEWAY = TD + '/ns/mcp/sa/agentgateway';
const ACTOR_AUD = 'https://curity.localtest.me/oauth/v2/oauth-token';

const b64url = (s) => Buffer.from(s).toString('base64url');
/** Unsigned compact JWS — the jose4j stub never checks the signature. */
function svid({ sub = SVID_COPILOT, kid = 'k1', aud = ACTOR_AUD, exp = nowSec() + 300 } = {}) {
  return `${b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))}.${b64url(
    JSON.stringify({ sub, aud, exp }),
  )}.sig`;
}
const nowSec = () => Math.floor(Date.now() / 1000);
/** Objects built inside the vm context have a foreign prototype; compare them by value. */
const plain = (x) => JSON.parse(JSON.stringify(x));
const JWKS_BODY = JSON.stringify({ keys: [{ kty: 'RSA', kid: 'k1', n: 'AQAB', e: 'AQAB' }] });

/**
 * A Nashorn-flavoured java.util.Map: `.get(key)` returns null (not undefined) for misses,
 * and nested objects are Maps too (Curity's Attributes.asMap() yields a LinkedHashMap per
 * nested object). `toJSON` lets `plain()` compare a Map by value when the procedure
 * forwards it opaquely (as it does with `act`).
 */
function javaMap(obj) {
  const wrap = (v) => (v !== null && typeof v === 'object' && !Array.isArray(v) ? javaMap(v) : v);
  return {
    get: (k) => (Object.prototype.hasOwnProperty.call(obj, k) ? wrap(obj[k]) : null),
    toJSON: () => obj,
  };
}
/** A java.util.List as jose4j returns it: size()/get(i). */
const javaList = (arr) => ({ size: () => arr.length, get: (i) => arr[i] });

/**
 * Build an isolated procedure runtime. Returns { run(context), calls } where `calls`
 * records every observable side effect (exceptionFactory, logger, HTTP fetches).
 */
function loadProcedure({ jwksBody = JWKS_BODY, jwksStatus = 200 } = {}) {
  const calls = { exceptions: [], warn: [], fetches: [], now: null };

  class ProcedureError extends Error {
    constructor(kind, code, description) {
      super(`${kind}:${code ?? ''}:${description}`);
      this.kind = kind;
      this.code = code;
      this.description = description;
    }
  }
  const exceptionFactory = {
    badRequestException(...args) {
      // (code, description) — 2-arg form; (description) — 1-arg form.
      const [code, description] = args.length >= 2 ? args : [null, args[0]];
      const e = new ProcedureError('badRequest', code, description);
      calls.exceptions.push(e);
      return e;
    },
    forbiddenException(description) {
      const e = new ProcedureError('forbidden', null, description);
      calls.exceptions.push(e);
      return e;
    },
    unauthorizedException(description) {
      const e = new ProcedureError('unauthorized', null, description);
      calls.exceptions.push(e);
      return e;
    },
    internalServerException(description) {
      const e = new ProcedureError('internalServer', null, description);
      calls.exceptions.push(e);
      return e;
    },
  };
  const logger = {
    warn: (m) => calls.warn.push(String(m)),
    info: () => {},
    debug: () => {},
  };

  // --- jose4j / java.* stubs --------------------------------------------------
  const decodeHeader = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[0], 'base64url').toString());
  const decodePayload = (jwt) => JSON.parse(Buffer.from(String(jwt).split('.')[1], 'base64url').toString());

  function JsonWebKeySet(body) {
    const keys = JSON.parse(String(body)).keys.map((k) => ({ getKeyId: () => k.kid ?? null }));
    this.getJsonWebKeys = () => javaList(keys);
  }
  function JwksVerificationKeyResolver(keys) {
    this.kids = new Set();
    for (let i = 0; i < keys.size(); i++) this.kids.add(keys.get(i).getKeyId());
  }
  function JwtConsumerBuilder() {
    const cfg = {};
    const self = {
      setVerificationKeyResolver: (r) => ((cfg.resolver = r), self),
      setExpectedAudience: (a) => ((cfg.aud = a), self),
      setRequireSubject: () => self,
      setRequireExpirationTime: () => self,
      setAllowedClockSkewInSeconds: () => self,
      build: () => ({
        processToClaims(jwt) {
          const { kid } = decodeHeader(jwt);
          if (!cfg.resolver.kids.has(kid)) {
            throw new Error(
              'org.jose4j.jwt.consumer.InvalidJwtException: JWT processing failed. Unable to find a suitable verification key (kid=' +
                kid +
                ')',
            );
          }
          const p = decodePayload(jwt);
          if (p.aud !== cfg.aud) throw new Error('org.jose4j...InvalidJwtException: Audience (aud) claim ' + p.aud + ' rejected');
          if (!p.exp || p.exp < nowSec()) throw new Error('org.jose4j...InvalidJwtException: expired');
          if (!p.sub) throw new Error('org.jose4j...InvalidJwtException: No Subject (sub) claim');
          return { getSubject: () => p.sub };
        },
      }),
    };
    return self;
  }
  const Packages = {
    org: {
      jose4j: {
        jwk: { JsonWebKeySet },
        keys: { resolvers: { JwksVerificationKeyResolver } },
        jwt: { consumer: { JwtConsumerBuilder } },
      },
    },
  };
  const Java = {
    type(name) {
      switch (name) {
        case 'java.util.Base64':
          return { getUrlDecoder: () => ({ decode: (s) => Buffer.from(String(s), 'base64url') }) };
        case 'java.lang.String':
          // `new JavaString(bytes, 'UTF-8')` — a constructor must return an object.
          return function JavaString(bytes) {
            return new String(Buffer.from(bytes).toString('utf8'));
          };
        default:
          throw new Error('test stub: unexpected Java.type(' + name + ')');
      }
    },
  };

  const clock = { now: Date.now() };
  const sandbox = {
    exceptionFactory,
    logger,
    Java,
    Packages,
    secondsUntil: (exp) => Math.max(0, Number(exp) - nowSec()),
    console,
    // The procedure only ever calls Date.now(); make it steerable for cache-window tests.
    Date: { now: () => clock.now },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: 'token-exchange.js' });

  // Web-service-client stub (facilities <http-client>), surfaced on the initialized context.
  const webServiceClient = (id, uri) => ({
    get: () => {
      calls.fetches.push(id + ' ' + uri);
      return { getStatusCode: () => jwksStatus, getBody: () => jwksBody, getHeaders: () => ({}) };
    },
  });

  return { ctx, calls, exceptionFactory, webServiceClient, clock };
}

/**
 * Build an OAuthTokenExchangeUnInitializedProcedureContext double.
 * `subject` are the introspected subject-token claims; `roles`/`act`/`may_act` are
 * passed as Nashorn would see them (Java Map / List → here: plain object / array).
 */
function makeContext(rt, {
  clientId = COPILOT_CLIENT,
  subject = { sub: 'alice', scope: 'openid inspect:read llm:invoke ops:write', roles: ['sre'], acr: 'mfa' },
  actor = svid(),
  audience = 'mcp-gateway',
  audiences = audience === undefined ? [] : [audience],
  scopes = ['inspect:read'],
  formAudience = audience,
} = {}) {
  const recorded = { init: null, issued: null };
  const fullContext = {
    getDefaultAccessTokenData: () => ({
      sub: subject.sub,
      iss: 'https://curity.localtest.me/oauth/v2/oauth-anonymous',
      exp: nowSec() + 600,
      iat: nowSec(),
      scope: recorded.init.scopes.join(' '),
      aud: recorded.init.audiences.slice(),
    }),
    getDefaultAccessTokenJwtIssuer: () => ({
      issue: (data, delegation) => {
        recorded.issued = { data, delegation };
        return 'issued.access.token';
      },
    }),
    getWebServiceClient: (id, uri) => rt.webServiceClient(id, uri),
  };
  const delegation = { id: 'deleg-1' };
  const context = {
    getPresentedSubjectToken: () => javaMap(subject),
    getPresentedSubjectTokenDelegation: () => delegation,
    getRequest: () => ({
      getFormParameter: (name) => {
        if (name === 'actor_token') return actor ?? null;
        if (name === 'audience') return formAudience ?? null;
        return null;
      },
    }),
    getClient: () => ({ getId: () => clientId }),
    getRequestedScopes: () => scopes.slice(),
    getRequestedAudiences: () => audiences.slice(),
    subjectAttributes: () => ({ subject: subject.sub }),
    contextAttributes: () => ({}),
    getInitializedContext: (subjectAttrs, contextAttrs, audiences, scopes) => {
      recorded.init = { subjectAttrs, contextAttrs, audiences: [...audiences], scopes: [...scopes] };
      return fullContext;
    },
  };
  return { context, recorded, delegation };
}

function run(rt, opts) {
  const { context, recorded, delegation } = makeContext(rt, opts);
  const result = rt.ctx.result(context);
  return { result, recorded, delegation };
}
function runExpectingThrow(rt, opts) {
  const { context, recorded } = makeContext(rt, opts);
  try {
    rt.ctx.result(context);
  } catch (e) {
    return { error: e, recorded };
  }
  assert.fail('expected the procedure to throw');
}

// ─── baseline: the harness drives the real file end to end ──────────────────

test('copilot → mcp-gateway: issues inspect:read with act.sub=copilot and may_act=agentgateway', () => {
  const rt = loadProcedure();
  const { result, recorded, delegation } = run(rt);

  assert.equal(result.access_token, 'issued.access.token');
  assert.equal(result.scope, 'inspect:read');
  assert.equal(result.issued_token_type, 'urn:ietf:params:oauth:token-type:access_token');
  assert.deepEqual(recorded.init.audiences, ['mcp-gateway']);
  assert.deepEqual(recorded.init.scopes, ['inspect:read']);
  assert.deepEqual(plain(recorded.issued.data.act), { sub: SVID_COPILOT });
  assert.deepEqual(plain(recorded.issued.data.may_act), { sub: SVID_GATEWAY });
  assert.equal(recorded.issued.data.acr, 'mfa');
  assert.deepEqual(plain(recorded.issued.data.roles), ['sre']);
  assert.equal(recorded.issued.delegation, delegation);
  assert.equal(rt.calls.fetches.length, 1, 'exactly one JWKS fetch on a cold cache');
});

test('specialist → mcp-gateway: nests the inbound act chain under the new actor', () => {
  const rt = loadProcedure();
  const inboundAct = { sub: SVID_COPILOT };
  const { recorded } = run(rt, {
    clientId: SPECIALIST_CLIENT,
    actor: svid({ sub: SVID_SPECIALIST }),
    subject: {
      sub: 'alice',
      scope: 'inspect:read ops:write llm:invoke',
      roles: ['sre'],
      acr: 'mfa',
      act: inboundAct,
      may_act: { sub: SVID_SPECIALIST },
    },
    scopes: ['ops:write'],
  });
  assert.deepEqual(plain(recorded.issued.data.act), { sub: SVID_SPECIALIST, act: inboundAct });
  assert.deepEqual(recorded.init.scopes, ['ops:write']);
});

test('may_act on the subject token refuses a different (allow-listed) actor', () => {
  const rt = loadProcedure();
  // A copilot-held aud=agent-specialist token replayed by the copilot itself (fact #25).
  const { error } = runExpectingThrow(rt, {
    subject: { sub: 'alice', scope: 'inspect:read ops:write', roles: ['sre'], may_act: { sub: SVID_SPECIALIST } },
  });
  assert.match(error.description, /may_act/);
});

test('scope narrowing is requested ∩ subject ∩ policy(audience): ops:write for mcp-gateway is invalid_scope', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { scopes: ['ops:write'] });
  assert.equal(error.code, 'invalid_scope');
});

test('a client not in CLIENT_POLICY is refused', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { clientId: 'web' });
  assert.equal(error.code, 'invalid_client');
});

test('an actor SVID from another workload is refused even with a valid signature', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { actor: svid({ sub: SVID_SPECIALIST }) });
  assert.match(error.description, /agent-specialist/);
});

test('missing actor_token is invalid_request', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { actor: null });
  assert.equal(error.kind, 'badRequest');
  assert.match(error.description, /actor_token/);
});

test('warm cache: a second exchange with a known kid does not refetch the JWKS', () => {
  const rt = loadProcedure();
  run(rt);
  run(rt);
  assert.equal(rt.calls.fetches.length, 1);
});

// ─── item 1: JWKS refetch throttle ──────────────────────────────────────────

test('unknown kid inside the refetch window is refused WITHOUT another JWKS fetch', () => {
  const rt = loadProcedure();
  run(rt); // warms the cache with kid k1
  const { error } = runExpectingThrow(rt, { actor: svid({ kid: 'forged' }) });
  assert.equal(error.kind, 'badRequest');
  assert.match(error.description, /actor_token/);
  assert.equal(rt.calls.fetches.length, 1, 'no refetch: the cache was refreshed moments ago');
});

test('unknown kid after the refetch window refetches exactly once (rotation still self-heals)', () => {
  const rt = loadProcedure();
  run(rt);
  rt.clock.now += 31_000;
  runExpectingThrow(rt, { actor: svid({ kid: 'forged' }) });
  assert.equal(rt.calls.fetches.length, 2, 'one refetch after the window elapsed');
  runExpectingThrow(rt, { actor: svid({ kid: 'forged' }) });
  assert.equal(rt.calls.fetches.length, 2, 'and the window closes again');
});

// ─── item 2: error semantics on the wire ────────────────────────────────────
// Curity's 2-arg badRequestException(code, msg) maps `code` through the SDK ErrorCode
// enum; 'access_denied'/'invalid_scope' never match, so the wire shows
// error=invalid_request with the code PREFIXED into error_description. forbiddenException
// is the only way (on 11.4.x) to emit error=access_denied from a procedure.

test('role gate denies through forbiddenException so the wire carries error=access_denied', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, {
    subject: { sub: 'bob', scope: 'openid inspect:read llm:invoke ops:write', roles: ['developer'] },
    audience: 'agent-specialist',
    scopes: ['inspect:read', 'ops:write'],
  });
  assert.equal(error.kind, 'forbidden');
  assert.match(error.description, /sre.*oncall/);
});

test('actor_token verification failure logs the jose4j detail and returns a generic description', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { actor: svid({ aud: 'https://elsewhere.example' }) });
  assert.equal(error.kind, 'badRequest');
  assert.match(error.description, /actor_token/);
  assert.doesNotMatch(error.description, /jose4j|Exception/, 'no Java internals on the wire');
  assert.equal(rt.calls.warn.length, 1);
  assert.match(rt.calls.warn[0], /jose4j/, 'the detail goes to the server log');
});

test('invalid_request failures use the 1-arg form (no "invalid_request " prefix in the description)', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { actor: null });
  assert.equal(error.code, null);
});

// ─── item 3: allowedActor is the SAME constant may_act uses ─────────────────

test('every client policy pins its actor by the shared SPIFFE constant (no parallel regex to drift)', () => {
  const rt = loadProcedure();
  const P = rt.ctx.CLIENT_POLICY;
  assert.equal(P[COPILOT_CLIENT].allowedActor, rt.ctx.SPIFFE_COPILOT);
  assert.equal(P[SPECIALIST_CLIENT].allowedActor, rt.ctx.SPIFFE_SPECIALIST);
  assert.equal(P['agentgateway'].allowedActor, rt.ctx.SPIFFE_GATEWAY);
  assert.equal(P['mcp-ops'].allowedActor, rt.ctx.SPIFFE_MCP_OPS);
  assert.equal(P['mcp-inspect'].allowedActor, rt.ctx.SPIFFE_MCP_INSPECT);
  assert.equal(rt.ctx.SPIFFE_COPILOT, SVID_COPILOT);
  for (const k of Object.keys(P)) assert.equal(P[k].allowedActors, undefined, k + ' still carries the regex list');
});

test('actor match is exact: a SPIFFE ID that merely extends the allowed one is refused', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { actor: svid({ sub: SVID_COPILOT + '-evil' }) });
  assert.match(error.description, /allow-list/);
});

// ─── item 4: JWKS via the configured <http-client>, after the cheap checks ───

const SPIRE_JWKS_URL =
  'https://spire-spiffe-oidc-discovery-provider.spire-server.svc.cluster.local:443/keys';

test('the JWKS is fetched through the http-client-spiffe facility (truststore TLS), not a hand-rolled socket', () => {
  const rt = loadProcedure();
  run(rt);
  assert.deepEqual(rt.calls.fetches, ['http-client-spiffe ' + SPIRE_JWKS_URL]);
});

test('policy runs before crypto: a disallowed scope fails invalid_scope with ZERO JWKS fetches', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, { scopes: ['ops:write'], actor: svid({ kid: 'forged' }) });
  assert.equal(error.code, 'invalid_scope');
  assert.equal(rt.calls.fetches.length, 0);
});

test('a SPIRE discovery-provider outage is a server error, not the client\'s fault', () => {
  const rt = loadProcedure({ jwksStatus: 503 });
  const { error } = runExpectingThrow(rt);
  assert.equal(error.kind, 'internalServer');
  assert.equal(rt.calls.warn.length, 1);
});

test('the context is initialized without a dead actor_sub attribute (act is stamped on the token itself)', () => {
  const rt = loadProcedure();
  const { recorded } = run(rt);
  assert.equal(recorded.init.contextAttrs.actor_sub, undefined);
});

// ─── item 5: hygiene — requested audiences from the context, role gate after narrowing ──

test('the audience comes from context.getRequestedAudiences(), not a hand-read form parameter', () => {
  const rt = loadProcedure();
  const { result, recorded } = run(rt, { formAudience: null, audiences: ['mcp-gateway'] });
  assert.equal(result.scope, 'inspect:read');
  assert.deepEqual(recorded.init.audiences, ['mcp-gateway']);
});

test('exactly one audience is required: none → invalid_request, two → invalid_request', () => {
  const rt = loadProcedure();
  let r = runExpectingThrow(rt, { formAudience: null, audiences: [] });
  assert.equal(r.error.kind, 'badRequest');
  assert.match(r.error.description, /audience/);
  r = runExpectingThrow(rt, { formAudience: null, audiences: ['mcp-gateway', 'llm-gateway'] });
  assert.equal(r.error.kind, 'badRequest');
  assert.match(r.error.description, /audience/);
  assert.equal(rt.calls.fetches.length, 0);
});

test('role gate keys on what the AUDIENCE can grant: ops:write asked of a read-only audience is dropped, no role verdict', () => {
  const rt = loadProcedure();
  const { result } = run(rt, {
    subject: { sub: 'bob', scope: 'openid inspect:read llm:invoke ops:write', roles: ['developer'] },
    audience: 'mcp-gateway',
    scopes: ['inspect:read', 'ops:write'],
  });
  assert.equal(result.scope, 'inspect:read');
  assert.equal(rt.calls.exceptions.length, 0, 'no role verdict for a scope the audience never grants');
});

test('a wrong role is refused even when the acr TIA already withheld ops:write from the subject token (no silent narrowing into a step-up bob can never pass)', () => {
  const rt = loadProcedure();
  const { error } = runExpectingThrow(rt, {
    // bob, password-only: the ops:write TIA (acr=mfa) stripped the scope at login.
    subject: { sub: 'bob', scope: 'openid inspect:read llm:invoke', roles: ['developer'], acr: 'html-form' },
    audience: 'agent-specialist',
    scopes: ['inspect:read', 'ops:write', 'llm:invoke'],
  });
  assert.equal(error.kind, 'forbidden');
});
