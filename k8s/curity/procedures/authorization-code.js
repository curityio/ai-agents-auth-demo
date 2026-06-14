/*
 * Authorization-code token procedure — emits the standard OIDC `acr` claim.
 *
 * Curity rejects a custom claim DEFINITION named `acr` (it's reserved), but a
 * token procedure may write `accessTokenData.acr` directly. We read the
 * authentication-context class the login produced (`context.contextAttributes().acr`,
 * populated by the `add-roles` transformation procedure) and project it onto the
 * issued access token so it propagates through the RFC 8693 exchange chain and
 * resource servers can enforce RFC 9470 step-up (`acr === 'mfa'`).
 *
 * @param {se.curity.identityserver.procedures.context.OpenIdConnectAuthorizationCodeTokenProcedureContext} context
 */
function result(context) {
  var delegationData = context.getDefaultDelegationData();
  var issuedDelegation = context.delegationIssuer.issue(delegationData);

  var accessTokenData = context.getDefaultAccessTokenData();
  accessTokenData.acr = context.contextAttributes().acr;
  // Narrow the access token's audience to just the resource it targets
  // (agent-copilot). The web-app client's <audience> list also carries
  // `web-app` so the ID token's `aud` includes the client_id (OIDC + Auth.js
  // require this) — but the access token doesn't need `web-app`, so we drop it
  // here. Overriding accessTokenData.aud leaves idTokenData.aud untouched.
  accessTokenData.aud = ['agent-copilot'];
  var issuedAccessToken = context.accessTokenIssuer.issue(accessTokenData, issuedDelegation);

  var refreshTokenData = context.getDefaultRefreshTokenData();
  var issuedRefreshToken = context.refreshTokenIssuer.issue(refreshTokenData, issuedDelegation);

  var responseData = {
    access_token: issuedAccessToken,
    scope: accessTokenData.scope,
    refresh_token: issuedRefreshToken,
    token_type: 'bearer',
    expires_in: secondsUntil(accessTokenData.exp)
  };

  var idTokenData = context.getDefaultIdTokenData();
  if (idTokenData) {
    var idTokenIssuer = context.idTokenIssuer;
    idTokenData.at_hash = idTokenIssuer.atHash(issuedAccessToken);

    responseData.id_token = idTokenIssuer.issue(idTokenData, issuedDelegation);
  }

  return responseData;
}
