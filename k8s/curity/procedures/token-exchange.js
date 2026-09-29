/*
 * SPIFFE actor_token validation for RFC 8693 token exchange.
 *
 * //TODO : Move this to a plugin.
 *
 * Accepts a SPIFFE JWT-SVID as the actor_token, verifies it against SPIRE's
 * live JWKS (fetched at runtime from the SPIRE OIDC Discovery Provider), and
 * narrows audience+scope per a static client policy.
 *
 * Context type: OAuthTokenExchangeUnInitializedProcedureContext.
 * Issuance flow:  validate inputs  →  getInitializedContext(...)
 *                                  →  getDefaultAccessTokenJwtIssuer().issue(...)
 *                                  →  return standard response shape.
 *
 * SPIRE signature verification uses jose4j (bundled with Curity at
 * jose4j-0.9.6.jar) and the Nashorn engine's Java interop. Curity's built-in
 * `getPresentedActorToken()` expects
 * the actor to be server-issued, so we bypass it and read the raw form
 * parameter directly.
 *
 * @param {se.curity.identityserver.procedures.context.OAuthTokenExchangeUnInitializedProcedureContext} context
 */

// SPIRE signing keys are fetched at runtime from the SPIRE OIDC Discovery
// Provider's JWKS endpoint, so the procedure always verifies actor_tokens
// against SPIRE's CURRENT signing key. No embedded snapshot to go stale on a
// fresh cluster or after SPIRE key rotation. The fetch is an in-cluster hop to
// SPIRE's own provider over its cluster-DNS Service name, through the
// `http-client-spiffe` facility — see fetchJwks(). The port is explicit because
// the web-service client is built from the URI's port component.
var SPIRE_JWKS_URL =
  'https://spire-spiffe-oidc-discovery-provider.spire-server.svc.cluster.local:443/keys';

// Cross-invocation cache: the jose4j verification resolver, the set of kids it
// covers, and when it was last (re)built. Curity compiles a procedure once and
// gives each worker thread its own global scope (Nashorn Bindings are
// thread-local), so this is filled once per thread, needs no locking, and is
// reset whenever a config commit rebuilds the procedure. Correctness never
// depends on persistence — see getResolver().
var JWKS_CACHE = { resolver: null, kids: {}, fetchedAt: 0 };

// An unknown `kid` triggers a refetch so SPIRE key rotation self-heals — but
// only once per window. Without this floor any authenticated client could make
// Curity hit SPIRE's discovery provider once per request by sending a forged
// `kid` (measured: one new TCP connection per call). SPIRE rotates JWT keys on
// the order of hours, so a 30 s floor costs nothing on a real rotation.
var JWKS_REFETCH_MIN_INTERVAL_MS = 30000;

var SPIRE_TRUST_DOMAIN = 'spiffe://demo.curity.local';
var EXPECTED_ACTOR_AUD = 'https://curity.localtest.me/oauth/v2/oauth-token';

// Workload SPIFFE IDs, named ONCE. Each client's `allowedActor` (who may present
// the actor_token) and each audience's `mayAct` (who may present the ISSUED token
// next) are both spelled with these, so the two gates cannot drift apart. The
// actor gate is exact string equality — no regex, no prefix check.
// agent-copilot never appears as a `mayAct` here: it is the FIRST actor, so the
// only token naming it is the login token stamped by authorization-code.js.
var SPIFFE_COPILOT = SPIRE_TRUST_DOMAIN + '/ns/agents/sa/agent-copilot';
var SPIFFE_SPECIALIST = SPIRE_TRUST_DOMAIN + '/ns/agents/sa/agent-specialist';
var SPIFFE_GATEWAY = SPIRE_TRUST_DOMAIN + '/ns/mcp/sa/agentgateway';
var SPIFFE_MCP_OPS = SPIRE_TRUST_DOMAIN + '/ns/mcp/sa/mcp-ops';
var SPIFFE_MCP_INSPECT = SPIRE_TRUST_DOMAIN + '/ns/mcp/sa/mcp-inspect';

// Per-client policy: scopes are keyed BY AUDIENCE so a client cannot request
// a privileged scope for an audience that doesn't accept it. Without this,
// copilot — which legitimately needs `ops:write` when forwarding to
// `agent-specialist` — could also obtain `ops:write` for the read-only
// `mcp-inspect` audience and leak that capability to anything down
// the line that's less strict than that MCP's own middleware.
//
// Exchange paths the procedure must support:
//   - agent-copilot      ─exch→ audience=mcp-gateway         scope=inspect:read
//   - agent-copilot      ─exch→ audience=agent-specialist    scope=inspect:read ops:write llm:invoke
//     (the token copilot forwards over A2A; act.sub=copilot; llm:invoke rides
//     along because this token becomes the specialist's subject token)
//   - agent-copilot      ─exch→ audience=llm-gateway         scope=llm:invoke
//   - agent-specialist   ─exch→ audience=mcp-gateway         scope=inspect:read ops:write
//     (subject is the just-received Bearer, so act nests automatically)
//   - agent-specialist   ─exch→ audience=llm-gateway         scope=llm:invoke
//   - agentgateway       ─exch→ audience=mcp-inspect   scope=inspect:read
//   - agentgateway       ─exch→ audience=mcp-ops             scope=ops:write
//     (the agentgateway's exchange-shim narrowing the aud=mcp-gateway caller
//     token per tool-target; act gains the gateway's SPIFFE ID)
//   - mcp-inspect  ─exch→ audience=inspect-api             scope=inspect:read
//   - mcp-ops            ─exch→ audience=ops-api             scope=ops:write
var CLIENT_POLICY = {
  // agent-copilot and agent-specialist are CIMD ephemeral clients: their client
  // ID is the HTTPS URL Curity dereferenced for the metadata document, so the
  // policy is keyed by that exact URL (context.getClient().getId() returns it).
  // `allowedActor` is still the workload identity that signs the actor_token —
  // the agent's K8s service account — not the CIMD URL.
  'https://copilot.localtest.me/.well-known/oauth-client': {
    perAudience: {
      'mcp-gateway': { scopes: ['inspect:read'], mayAct: SPIFFE_GATEWAY },
      'agent-specialist': {
        scopes: ['inspect:read', 'ops:write', 'llm:invoke'],
        mayAct: SPIFFE_SPECIALIST
      },
      // Terminal: the gateway swaps in the configured LLM provider's upstream
      // credential rather than exchanging again, so this token is never a
      // subject_token. No next actor to name.
      'llm-gateway': { scopes: ['llm:invoke'] }
    },
    allowedActor: SPIFFE_COPILOT
  },
  'https://specialist.localtest.me/.well-known/oauth-client': {
    perAudience: {
      'mcp-gateway': { scopes: ['inspect:read', 'ops:write'], mayAct: SPIFFE_GATEWAY },
      'llm-gateway': { scopes: ['llm:invoke'] }
    },
    allowedActor: SPIFFE_SPECIALIST
  },
  // agentgateway: confidential client (named after the workload, NOT the
  // `mcp-gateway` audience it fronts) fanning out to the two MCP backends,
  // narrowing the broad aud=mcp-gateway caller token per tool-target.
  agentgateway: {
    perAudience: {
      'mcp-inspect': { scopes: ['inspect:read'], mayAct: SPIFFE_MCP_INSPECT },
      'mcp-ops': { scopes: ['ops:write'], mayAct: SPIFFE_MCP_OPS }
    },
    allowedActor: SPIFFE_GATEWAY
  },
  // MCPs are confidential clients exchanging to their backend API. Both are
  // terminal: {inspect,ops}-api consume the token, they never exchange onward.
  'mcp-ops': {
    perAudience: {
      'ops-api': { scopes: ['ops:write'] }
    },
    allowedActor: SPIFFE_MCP_OPS
  },
  'mcp-inspect': {
    perAudience: {
      'inspect-api': { scopes: ['inspect:read'] }
    },
    allowedActor: SPIFFE_MCP_INSPECT
  }
};

/*
 * Error helpers. How a procedure exception reaches the wire is NOT obvious:
 *   - badRequestException(code, desc) runs `code` through the SDK ErrorCode enum
 *     (uppercase names), so an OAuth code like 'invalid_scope' never matches and
 *     Curity answers error=invalid_request with the code PREFIXED into
 *     error_description ("invalid_scope no scope intersects…"). Clients key on
 *     that prefix, so it is kept deliberately for invalid_scope/invalid_client.
 *   - badRequestException(desc) (1-arg) is the clean error=invalid_request.
 *   - forbiddenException(desc) is the only way on 11.4.x to emit a REAL
 *     error=access_denied (HTTP 403). 11.5.0 adds an exact-code overload
 *     (badRequestException(code, desc, true)) that could carry RFC 8693's
 *     invalid_target verbatim — adopt it once the image moves.
 */
function invalidRequest(description) {
  throw exceptionFactory.badRequestException(description);
}

function failWithCode(code, description) {
  throw exceptionFactory.badRequestException(code, description);
}

function accessDenied(description) {
  throw exceptionFactory.forbiddenException(description);
}

/*
 * Read the `sub` out of an RFC 8693 §4.4 `may_act` claim.
 *
 * The claim identifies the parties permitted to act for the subject. We emit it
 * as `{ "sub": "<spiffe id>" }`; on the way back IN, `getPresentedSubjectToken()`
 * hands object claims to the script as a java.util.Map (Curity builds the token
 * data with Attributes.asMap(), a LinkedHashMap per nested object — verified in
 * the 11.4 source), so `.get('sub')` is the one shape to read. `act` is forwarded
 * opaquely and never needs reading into.
 *
 * Returns null for an absent claim, which callers treat as "no constraint".
 */
function mayActSub(raw) {
  if (raw === null || typeof raw === 'undefined' || typeof raw.get !== 'function') {
    return null;
  }
  var sub = raw.get('sub');
  return sub === null || typeof sub === 'undefined' ? null : String(sub);
}

function setToArray(s) {
  var out = [];
  if (!s) return out;
  if (Array.isArray(s)) return s.slice();
  if (typeof s.iterator === 'function') {
    var it = s.iterator();
    while (it.hasNext()) out.push(String(it.next()));
    return out;
  }
  // Plain JS iterable / array-like
  for (var i = 0; i < s.length; i++) out.push(String(s[i]));
  return out;
}

// Normalize a multi-valued claim to a JS string array. Handles:
//   - null / undefined  → []
//   - Java Set          → iterated via setToArray
//   - JS Array          → sliced via setToArray
//   - space-delimited string (e.g. "sre oncall") → split then filtered
// setToArray alone does NOT split strings; it would iterate them
// character-by-character via the array-like fallback.
function claimToArray(v) {
  if (!v) return [];
  if (typeof v === 'string') return v.split(/\s+/).filter(Boolean);
  return setToArray(v);
}

// Fetch SPIRE's JWKS through the `http-client-spiffe` facility (configmap
// <facilities><http><client>): TLS is validated against Curity's server-truststore,
// which carries the demo's shared root CA that the discovery provider's SVID
// chains to. Hostname verification is disabled ON THAT CLIENT because the cert's
// SAN is the external name (oidc-discovery.demo.curity.local), not the in-cluster
// Service FQDN dialled here. Only the INITIALIZED procedure context exposes web
// service clients, which is why the actor is verified after getInitializedContext().
var SPIRE_JWKS_HTTP_CLIENT = 'http-client-spiffe';

function fetchJwks(fullContext) {
  var response = fullContext.getWebServiceClient(SPIRE_JWKS_HTTP_CLIENT, SPIRE_JWKS_URL).get();
  var status = response.getStatusCode();
  if (status !== 200) {
    throw new Error('SPIRE JWKS endpoint answered HTTP ' + status);
  }
  return String(response.getBody());
}

// Read the `kid` from a compact-JWS header WITHOUT verifying — used only to
// decide whether the cached key set already covers this token's signing key.
function jwtHeaderKid(rawJwt) {
  var parts = String(rawJwt).split('.');
  if (parts.length < 2) {
    return null;
  }
  var Base64 = Java.type('java.util.Base64');
  var JavaString = Java.type('java.lang.String');
  var bytes = Base64.getUrlDecoder().decode(parts[0]);
  var header = JSON.parse(new JavaString(bytes, 'UTF-8'));
  return header.kid ? String(header.kid) : null;
}

// Return a jose4j verification key resolver covering `neededKid`. Reuses the
// cached resolver when it already knows the kid; otherwise (re)fetches SPIRE's
// JWKS and rebuilds — at most once per JWKS_REFETCH_MIN_INTERVAL_MS. This
// refetch-on-unknown-kid is what makes the procedure self-heal across SPIRE key
// rotation and fresh clusters with zero manual steps. The provider emits clean
// keys (no `use` field), so no use-stripping is needed.
function getResolver(fullContext, neededKid) {
  if (JWKS_CACHE.resolver !== null) {
    if (neededKid && JWKS_CACHE.kids[neededKid]) {
      return JWKS_CACHE.resolver;
    }
    if (Date.now() - JWKS_CACHE.fetchedAt < JWKS_REFETCH_MIN_INTERVAL_MS) {
      // Unknown kid, but the key set was refreshed moments ago: hand back the
      // current resolver and let jose4j refuse the token for lack of a key
      // rather than refetching on the attacker's schedule.
      return JWKS_CACHE.resolver;
    }
  }
  var body;
  try {
    body = fetchJwks(fullContext);
  } catch (e) {
    // Not the caller's fault: SPIRE's discovery provider is unreachable or
    // broken. Surface it as a server error (→ OAuth server_error), never as an
    // invalid actor_token, so the agents' OBO log shows the right culprit.
    logger.warn('SPIRE JWKS fetch failed: ' + e);
    throw exceptionFactory.internalServerException('SPIRE JWKS unavailable');
  }
  var keySet = new Packages.org.jose4j.jwk.JsonWebKeySet(body);
  var keys = keySet.getJsonWebKeys();
  var resolver = new Packages.org.jose4j.keys.resolvers.JwksVerificationKeyResolver(keys);
  var kids = {};
  for (var i = 0; i < keys.size(); i++) {
    var kid = keys.get(i).getKeyId();
    if (kid) {
      kids[String(kid)] = true;
    }
  }
  JWKS_CACHE.resolver = resolver;
  JWKS_CACHE.kids = kids;
  JWKS_CACHE.fetchedAt = Date.now();
  return resolver;
}

// Verify a SPIFFE JWT-SVID using jose4j; returns a plain JS object with
// { sub } on success or throws (invalidRequest) on any validation failure.
function verifySpiffeSvid(fullContext, rawJwt) {
  var resolver = getResolver(fullContext, jwtHeaderKid(rawJwt));
  var claims;
  try {
    claims = new Packages.org.jose4j.jwt.consumer.JwtConsumerBuilder()
      .setVerificationKeyResolver(resolver)
      .setExpectedAudience(EXPECTED_ACTOR_AUD)
      .setRequireSubject()
      .setRequireExpirationTime()
      .setAllowedClockSkewInSeconds(30)
      .build()
      .processToClaims(rawJwt);
  } catch (e) {
    // Java exception text (class names, jose4j internals) belongs in the server
    // log, not in an OAuth error_description handed to the client.
    logger.warn('actor_token rejected: ' + e);
    invalidRequest('actor_token is not a valid SPIFFE JWT-SVID for this token endpoint');
  }
  // Which workloads may act is decided by the caller against CLIENT_POLICY
  // (exact SPIFFE ID); this function only establishes WHO signed the SVID.
  return { sub: String(claims.getSubject()) };
}

/*
 * Order of checks, cheapest and most caller-attributable first:
 *   1. inputs present            (subject_token, actor_token, audience)
 *   2. client policy             (CLIENT_POLICY, requested audience)
 *   3. scope narrowing + role    (requested ∩ subject ∩ policy; ops:write role gate)
 *   4. getInitializedContext     (Curity's own checks + Token Issuance Authorizers)
 *   5. actor_token verification  (jose4j against SPIRE's JWKS — needs the web
 *                                 service client only the initialized context has)
 *   6. allowedActor + may_act    (who presented the SVID vs who was permitted to)
 *   7. issue                     (act / may_act / acr / roles stamped on the token)
 * Steps 1–3 need no network or crypto, so a malformed or over-reaching request
 * costs nothing. Step 5 after 4 is a deliberate trade: a bad SVID is only found
 * after the TIAs ran, which is harmless (nothing is issued, nothing persisted).
 */
function result(context) {
  // 1. Inputs. The subject token is Curity-issued and already introspected; the
  //    actor token is SPIRE-issued and verified by us in step 5.
  var subjectToken = context.getPresentedSubjectToken();
  if (subjectToken === null) {
    invalidRequest('subject_token is required');
  }
  var presentedDelegation = context.getPresentedSubjectTokenDelegation();
  var actorRaw = context.getRequest().getFormParameter('actor_token');
  if (!actorRaw) {
    invalidRequest('actor_token is required');
  }

  // 2. Per-client policy, keyed by client_id (the CIMD URL for the agents).
  var clientId = context.getClient().getId();
  var policy = CLIENT_POLICY[clientId];
  if (!policy) {
    failWithCode('invalid_client', 'client ' + clientId + ' is not configured for token exchange');
  }

  //    Audience: RFC 8693 allows several `audience` values; this demo issues to
  //    exactly one (the agents always send one). Look it up in the per-audience
  //    map — its presence is the allow-list, its `scopes` array is the cap.
  var audiences = setToArray(context.getRequestedAudiences());
  if (audiences.length !== 1) {
    invalidRequest('exactly one audience is required, got ' + audiences.length);
  }
  var requestedAudience = audiences[0];
  var audPolicy = policy.perAudience[requestedAudience];
  if (!audPolicy) {
    invalidRequest('audience ' + requestedAudience + ' not allowed for client ' + clientId);
  }
  var allowedScopesForAudience = audPolicy.scopes;

  // 3. Scope narrowing: requested ∩ subject ∩ policy(audience). Keying scopes
  //    by audience prevents the cross-product leak where a client could pull
  //    a privileged scope under an unprivileged audience.
  var subjectScopes = String(subjectToken.get('scope') || '')
    .split(/\s+/)
    .filter(Boolean);
  var requestedSet = context.getRequestedScopes(); // Java Set<String>
  var requested = setToArray(requestedSet);
  if (requested.length === 0) requested = subjectScopes;
  var narrowed = requested.filter(function (s) {
    return subjectScopes.indexOf(s) !== -1 && allowedScopesForAudience.indexOf(s) !== -1;
  });
  if (narrowed.length === 0) {
    failWithCode(
      'invalid_scope',
      'no scope intersects subject + policy for client ' +
        clientId +
        ' / audience ' +
        requestedAudience
    );
  }
  //    Role gate — ops:write requires a WRITE role: `sre` OR `oncall`. This is the
  //    coarse tier gate (may this user touch the ops write-tier at all). The finer
  //    per-tool split (on-call may restart/scale; only sre may set_deployment_image)
  //    is enforced downstream at mcp-ops, NOT at the agentgateway.
  //    It keys on requested ∩ policy(audience) — what this AUDIENCE could grant —
  //    and deliberately NOT on the subject token's scopes: a scope the audience
  //    never grants is dropped above and earns no role verdict (bob asking
  //    mcp-gateway for ops:write just gets inspect:read, exactly like alice), but
  //    a password-only bob whose token LACKS ops:write (the acr=mfa TIA withheld
  //    it at login) must still be told "wrong role" here. Narrowing on the
  //    subject instead would issue him a read-only token, the specialist's own
  //    ops:write exchange would then fail invalid_scope, and the agent would
  //    answer with an RFC 9470 step-up prompt he can never satisfy. Role is a
  //    property of the user, not of the session's authentication level.
  //    `subjectToken.get('roles')` may be a Java Set, JS array, space-delimited
  //    string (e.g. "sre oncall"), or null. claimToArray() handles all four shapes;
  //    setToArray alone would iterate a string character-by-character.
  var subjectRoles = claimToArray(subjectToken.get('roles'));
  var grantable = requested.filter(function (s) {
    return allowedScopesForAudience.indexOf(s) !== -1;
  });
  if (
    grantable.indexOf('ops:write') !== -1 &&
    subjectRoles.indexOf('sre') === -1 &&
    subjectRoles.indexOf('oncall') === -1
  ) {
    accessDenied("user lacks a write role ('sre' or 'oncall') for ops:write");
  }

  // 4. Initialize the procedure context with the narrowed audience+scope. This
  //    is where Curity runs its own checks and the Token Issuance Authorizers
  //    (e.g. `ops:write` requires acr=mfa). `act` is stamped directly on the
  //    token data in step 7, so no actor attribute is needed here.
  var fullContext = context.getInitializedContext(
    context.subjectAttributes() || {},
    context.contextAttributes() || {},
    [requestedAudience],
    narrowed
  );

  // 5. Actor token: verify the SPIFFE JWT-SVID against SPIRE's live JWKS.
  var actor = verifySpiffeSvid(fullContext, actorRaw);

  // 6. Who presented the SVID vs who was permitted to — two independent gates.
  //    6a. `allowedActor`: server-side config keyed by the REQUESTING CLIENT.
  if (actor.sub !== policy.allowedActor) {
    invalidRequest(
      'actor SPIFFE ID ' + actor.sub + ' is not on the allow-list for client ' + clientId
    );
  }
  //    6b. RFC 8693 §4.4 `may_act`: the SUBJECT token names who is permitted to act
  //        for it — a grant carried in the token itself and keyed by the subject.
  //        Both must agree, so a client-config mistake alone can't widen delegation,
  //        and the authority is verifiable by anyone holding the token without
  //        reading Curity's configuration.
  //
  //        Enforce-if-present: terminal tokens (…→llm-gateway, →inspect-api, →ops-api)
  //        carry no `may_act` because nothing exchanges them onward. Absent means
  //        unconstrained, which keeps a token minted before this claim existed
  //        working through its short lifetime rather than breaking mid-chain.
  var expectedActor = mayActSub(subjectToken.get('may_act'));
  if (expectedActor !== null && expectedActor !== actor.sub) {
    invalidRequest(
      'actor ' +
        actor.sub +
        ' is not authorized by the subject token may_act (' +
        expectedActor +
        ')'
    );
  }

  // 7. Build the JWT claims map and inject `act` so the issued access
  //    token carries the OBO actor chain. `getDefaultAccessTokenData()`
  //    returns the standard claim set (sub, iss, aud, exp, etc.); we add
  //    `act` on top before handing to the map-based issue() overload.
  //    Using `.issue(map, delegation)` instead of `.issue(subjectToken,
  //    delegation)` because Curity only emits `act` natively when the
  //    actor_token went through `getPresentedActorToken()` (server-issued
  //    tokens) — bypassed here because SPIFFE JWT-SVIDs are SPIRE-issued.
  //
  //    Nested act per RFC 8693 §4.1: when the subject token
  //    presented to *this* exchange already carries an `act` claim (i.e.
  //    the caller is an agent forwarding a token that was itself the
  //    product of an earlier exchange — agent-specialist's case), wrap
  //    that prior chain under the new actor instead of overwriting it.
  //    Innermost = oldest actor; outermost = most recent. The procedure
  //    stays direction-agnostic: copilot's depth-1 case has no inbound
  //    act, specialist's depth-2 case nests automatically.
  //
  //    `subjectToken.get('act')` shape across Curity versions varies:
  //    it can be a Map (Java), a JSON string, or null. We treat anything
  //    non-null/non-undefined as an opaque chain and pass it through.
  var tokenData = fullContext.getDefaultAccessTokenData();
  var inboundAct = subjectToken.get('act');
  if (inboundAct !== null && typeof inboundAct !== 'undefined') {
    tokenData.act = { sub: actor.sub, act: inboundAct };
  } else {
    tokenData.act = { sub: actor.sub };
  }

  // `may_act` counterpart to `act`: `act` records who DID act (audit, after the
  // fact), `may_act` grants who MAY act next (authorization, ahead of time).
  // Narrowed per hop exactly like scope — each issued token names only the single
  // workload that legitimately presents it next, taken from the per-audience
  // policy. Terminal audiences set none, so the claim is simply absent there.
  if (audPolicy.mayAct) {
    tokenData.may_act = { sub: audPolicy.mayAct };
  }

  // Propagate the standard OIDC `acr` (auth-context class) from the subject token
  // into the issued token so downstream resource servers can enforce MFA-level
  // requirements (RFC 9470 step-up) without re-introspecting the original user token.
  //
  // `acr` is a reserved claim name, so it can't be declared as a custom claim
  // definition — but a token procedure may set it directly on the token data.
  // The login token gets `acr` from the authorization-code procedure
  // (`acr-passthrough`); each exchange hop reads it off the subject and re-emits
  // it the same way, so the value survives the whole delegation chain.
  var inboundAcr = subjectToken.get('acr');
  if (inboundAcr !== null && typeof inboundAcr !== 'undefined') {
    tokenData.acr = inboundAcr;
  }

  // Propagate `roles` so the user's role context survives EVERY hop of
  // the delegation chain. The role gate (step 3 above) runs on every exchange
  // that narrows to ops:write — but `roles` lives only on the user's login token.
  // Without re-emitting it here, the 2nd hop (agent-specialist -> mcp-ops) would
  // read an empty roles claim off the (agent-issued) subject token and falsely
  // deny a user who legitimately holds `sre`. Re-emit as an array, mirroring the
  // acr propagation above (`subjectRoles` is already normalised).
  if (subjectRoles.length > 0) {
    tokenData.roles = subjectRoles;
  }

  var issuedAccessToken = fullContext
    .getDefaultAccessTokenJwtIssuer()
    .issue(tokenData, presentedDelegation);

  return {
    scope: narrowed.join(' '),
    access_token: issuedAccessToken,
    token_type: 'bearer',
    // Reported from the issued token's exp, so it follows each client's configured
    // access-token-ttl (600 s for every client in the demo configmap) — the agents'
    // exchange caches key their TTL on this value.
    expires_in: secondsUntil(tokenData.exp),
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
  };
}
