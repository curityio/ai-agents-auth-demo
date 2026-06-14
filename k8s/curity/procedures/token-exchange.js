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
// SPIRE's own provider over its cluster-DNS Service name; see httpsGet() for
// the trust-all TLS rationale.
var SPIRE_JWKS_URL =
  'https://spire-spiffe-oidc-discovery-provider.spire-server.svc.cluster.local/keys';

// Cross-invocation cache: the jose4j verification resolver plus the set of kids
// it covers. If Curity preserves procedure script state between calls this
// avoids a fetch per exchange; if not, it harmlessly refetches each call.
// Correctness never depends on persistence — see getResolver().
var JWKS_CACHE = { resolver: null, kids: {} };

var SPIRE_TRUST_DOMAIN = 'spiffe://demo.curity.local';
// `/ns/` (not `/ns/agents/sa/`) so MCP SVIDs (…/ns/mcp/sa/mcp-ops,
// …/ns/mcp/sa/mcp-observability) also pass the actor sub prefix check.
// The exact-ID gate remains each client's `allowedActors` regex.
var SPIRE_AGENT_PREFIX = SPIRE_TRUST_DOMAIN + '/ns/';
var EXPECTED_ACTOR_AUD = 'https://curity.localtest.me/oauth/v2/oauth-token';

// Per-client policy: scopes are keyed BY AUDIENCE so a client cannot request
// a privileged scope for an audience that doesn't accept it. Without this,
// copilot — which legitimately needs `ops:write` when forwarding to
// `agent-specialist` — could also obtain `ops:write` for the read-only
// `mcp-observability` audience and leak that capability to anything down
// the line that's less strict than that MCP's own middleware.
//
// Exchange paths the procedure must support:
//   - agent-copilot      ─exch→ audience=mcp-observability   scope=obs:read
//   - agent-copilot      ─exch→ audience=agent-specialist    scope=obs:read ops:write
//     (the token copilot forwards over A2A; act.sub=copilot)
//   - agent-specialist   ─exch→ audience=mcp-ops             scope=ops:write
//     (subject is the just-received Bearer, so act nests automatically)
var CLIENT_POLICY = {
  // agent-copilot and agent-specialist are CIMD ephemeral clients: their client
  // ID is the HTTPS URL Curity dereferenced for the metadata document, so the
  // policy is keyed by that exact URL (context.getClient().getId() returns it).
  // The allowedActors SPIFFE regexes are unchanged — the workload identity that
  // signs the actor_token is still the agent's K8s service account.
  'https://copilot.localtest.me/.well-known/oauth-client': {
    perAudience: {
      'mcp-observability': { scopes: ['obs:read'] },
      'agent-specialist': { scopes: ['obs:read', 'ops:write'] }
    },
    allowedActors: [/^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-copilot$/]
  },
  'https://specialist.localtest.me/.well-known/oauth-client': {
    perAudience: {
      'mcp-ops': { scopes: ['ops:write'] },
      'mcp-observability': { scopes: ['obs:read'] }
    },
    allowedActors: [/^spiffe:\/\/demo\.curity\.local\/ns\/agents\/sa\/agent-specialist$/]
  },
  // MCPs are confidential clients exchanging to their backend API.
  'mcp-ops': {
    perAudience: {
      'ops-api': { scopes: ['ops:write'] }
    },
    allowedActors: [/^spiffe:\/\/demo\.curity\.local\/ns\/mcp\/sa\/mcp-ops$/]
  },
  'mcp-observability': {
    perAudience: {
      'obs-api': { scopes: ['obs:read'] }
    },
    allowedActors: [/^spiffe:\/\/demo\.curity\.local\/ns\/mcp\/sa\/mcp-observability$/]
  }
};

function fail(code, description) {
  throw exceptionFactory.badRequestException(code, description);
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

// Fetch a URL over HTTPS and return the response body as a string. Uses a
// per-connection trust-all TLS config — deliberate and scoped to THIS
// connection only, never the JVM default: it is an in-cluster hop to SPIRE's
// own discovery provider, and the provider's cert is issued for the external
// name (oidc-discovery.demo.curity.local) so hostname verification could not
// pass against the in-cluster Service FQDN regardless.
function httpsGet(url) {
  var SSLContext = Java.type('javax.net.ssl.SSLContext');
  var X509TrustManager = Java.type('javax.net.ssl.X509TrustManager');
  var HostnameVerifier = Java.type('javax.net.ssl.HostnameVerifier');
  var URL = Java.type('java.net.URL');
  var BufferedReader = Java.type('java.io.BufferedReader');
  var InputStreamReader = Java.type('java.io.InputStreamReader');

  var trustAll = new X509TrustManager({
    checkClientTrusted: function (chain, authType) {},
    checkServerTrusted: function (chain, authType) {},
    getAcceptedIssuers: function () {
      return Java.to([], 'java.security.cert.X509Certificate[]');
    }
  });
  var ctx = SSLContext.getInstance('TLS');
  ctx.init(null, Java.to([trustAll], 'javax.net.ssl.TrustManager[]'), null);

  var conn = new URL(url).openConnection();
  conn.setSSLSocketFactory(ctx.getSocketFactory());
  conn.setHostnameVerifier(
    new HostnameVerifier({
      verify: function (hostname, session) {
        return true;
      }
    })
  );
  conn.setRequestMethod('GET');
  conn.setConnectTimeout(3000);
  conn.setReadTimeout(3000);

  var reader = null;
  try {
    reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), 'UTF-8'));
    var body = '';
    var line;
    while ((line = reader.readLine()) !== null) {
      body += line;
    }
    return body;
  } finally {
    if (reader !== null) {
      reader.close();
    }
  }
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
// JWKS and rebuilds. This refetch-on-unknown-kid is what makes the procedure
// self-heal across SPIRE key rotation and fresh clusters with zero manual steps.
// The provider emits clean keys (no `use` field), so no use-stripping is needed.
function getResolver(neededKid) {
  if (JWKS_CACHE.resolver && neededKid && JWKS_CACHE.kids[neededKid]) {
    return JWKS_CACHE.resolver;
  }
  var body = httpsGet(SPIRE_JWKS_URL);
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
  return resolver;
}

// Verify a SPIFFE JWT-SVID using jose4j; returns a plain JS object with
// { sub } on success or throws via `fail()` on any validation failure.
function verifySpiffeSvid(rawJwt) {
  if (!rawJwt) {
    fail('invalid_request', 'actor_token is required');
  }

  var resolver, consumer, claims;
  try {
    resolver = getResolver(jwtHeaderKid(rawJwt));
    consumer = new Packages.org.jose4j.jwt.consumer.JwtConsumerBuilder()
      .setVerificationKeyResolver(resolver)
      .setExpectedAudience(EXPECTED_ACTOR_AUD)
      .setRequireSubject()
      .setRequireExpirationTime()
      .setAllowedClockSkewInSeconds(30)
      .build();
    claims = consumer.processToClaims(rawJwt);
  } catch (e) {
    fail('invalid_request', 'actor_token signature/structure invalid: ' + e);
  }

  var sub = String(claims.getSubject());
  if (!sub || sub.indexOf(SPIRE_AGENT_PREFIX) !== 0) {
    fail('invalid_request', 'actor sub must start with ' + SPIRE_AGENT_PREFIX);
  }
  return { sub: sub };
}

function result(context) {
  // 1. Subject token (Curity-issued, already introspected).
  var subjectToken = context.getPresentedSubjectToken();
  if (subjectToken === null) {
    fail('invalid_request', 'subject_token is required');
  }
  var presentedDelegation = context.getPresentedSubjectTokenDelegation();

  // 2. Actor token (SPIRE-issued; we verify the signature ourselves).
  var actorRaw = context.getRequest().getFormParameter('actor_token');
  var actor = verifySpiffeSvid(actorRaw);

  // 3. Per-client policy.
  var clientId = context.getClient().getId();
  var policy = CLIENT_POLICY[clientId];
  if (!policy) {
    fail('invalid_client', 'client ' + clientId + ' is not configured for token exchange');
  }
  if (
    !policy.allowedActors.some(function (re) {
      return re.test(actor.sub);
    })
  ) {
    fail(
      'invalid_request',
      'actor SPIFFE ID ' + actor.sub + ' is not on the allow-list for client ' + clientId
    );
  }

  // 4. Audience: single string requested via form param. Look it up in the
  //    per-audience map — its presence is the allow-list, its `scopes` array
  //    is the per-audience scope cap.
  var requestedAudience = context.getRequest().getFormParameter('audience');
  var audPolicy = requestedAudience ? policy.perAudience[requestedAudience] : null;
  if (!audPolicy) {
    fail(
      'invalid_request',
      'audience ' + requestedAudience + ' not allowed for client ' + clientId
    );
  }
  var allowedScopesForAudience = audPolicy.scopes;

  // 5. Scope narrowing: requested ∩ subject ∩ policy(audience). Keying scopes
  //    by audience prevents the cross-product leak where a client could pull
  //    a privileged scope under an unprivileged audience.
  var subjectScopes = String(subjectToken.get('scope') || '')
    .split(/\s+/)
    .filter(Boolean);
  var requestedSet = context.getRequestedScopes(); // Java Set<String>
  var requested = setToArray(requestedSet);
  if (requested.length === 0) requested = subjectScopes;
  // 5a. Role gate — deny early if ops:write is requested without sre role.
  //     `subjectToken.get('roles')` may be a Java Set, JS array, space-delimited
  //     string (e.g. "sre oncall"), or null. claimToArray() handles all four shapes;
  //     setToArray alone would iterate a string character-by-character.
  var subjectRoles = claimToArray(subjectToken.get('roles'));
  if (requested.indexOf('ops:write') !== -1 && subjectRoles.indexOf('sre') === -1) {
    fail('access_denied', "user lacks required role 'sre' for ops:write");
  }

  var narrowed = requested.filter(function (s) {
    return subjectScopes.indexOf(s) !== -1 && allowedScopesForAudience.indexOf(s) !== -1;
  });
  if (narrowed.length === 0) {
    fail(
      'invalid_scope',
      'no scope intersects subject + policy for client ' +
        clientId +
        ' / audience ' +
        requestedAudience
    );
  }

  // 6. Initialize the procedure context with narrowed audience+scope, and
  //    expose `actor_sub` as a context attribute so a token-claims mapper can
  //    project it into the JWT's `act.sub` claim. If no mapper is wired, the
  //    token still issues — it just won't carry `act.sub` until the mapper
  //    is added (separate configmap change).
  var subjectAttrs = context.subjectAttributes() || {};
  var contextAttrs = context.contextAttributes() || {};
  contextAttrs.actor_sub = actor.sub;

  var fullContext = context.getInitializedContext(
    subjectAttrs,
    contextAttrs,
    [requestedAudience],
    narrowed
  );

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
  // the delegation chain. The role gate (step 5a above) runs on every exchange
  // that requests ops:write — but `roles` lives only on the user's login token.
  // Without re-emitting it here, the 2nd hop (agent-specialist -> mcp-ops) would
  // read an empty roles claim off the (agent-issued) subject token and falsely
  // deny a user who legitimately holds `sre`. Re-emit as an array, mirroring the
  // acr propagation above. claimToArray handles Set/array/space-string/null.
  var inboundRoles = claimToArray(subjectToken.get('roles'));
  if (inboundRoles.length > 0) {
    tokenData.roles = inboundRoles;
  }

  var issuedAccessToken = fullContext
    .getDefaultAccessTokenJwtIssuer()
    .issue(tokenData, presentedDelegation);

  return {
    scope: narrowed.join(' '),
    access_token: issuedAccessToken,
    token_type: 'bearer',
    expires_in: 300, // 5 min — matches spiffe-helper JWT-SVID TTL ceiling
    issued_token_type: 'urn:ietf:params:oauth:token-type:access_token'
  };
}
