/**
 * Transformation procedure — assigns `roles` per user at login.
 * A write role (`sre` OR `oncall`) gates `ops:write` in the token-exchange procedure;
 * the agentgateway then splits ops tools per-role (hierarchical, `sre` ⊇ `oncall`):
 * on-call may restart/scale; only `sre` may set_deployment_image.
 * @param {se.curity.identityserver.procedures.context.TransformationProcedureContext} context
 * @returns {*}
 */
function result(context) {
  // the 'context.attributeMap' content comes from the configured 'attributes-location' (subject-attributes, context-attributes, or action-attributes)
  var attributes = context.attributeMap;

  if (attributes.subject == 'alice') {
    // sre: full write tier. NO forced login MFA — alice is the step-up demo user
    // (ops:write triggers the on-demand RFC 9470 acr=mfa challenge at ops-api).
    attributes.roles = ['sre', 'oncall'];
  } else if (attributes.subject == 'carol') {
    // on-call: may restart/scale (write role) but NOT set_deployment_image (needs sre).
    // Forced login MFA (like bob) keeps carol's story on the per-tool role split, not step-up.
    attributes.roles = ['oncall'];
    attributes.requireSecondFactor = true;
  } else if (attributes.subject == 'bob') {
    attributes.roles = ['developer'];
    // trigger TOTP MFA for bob
    attributes.requireSecondFactor = true;
  }

  // the returned attributes will be assigned to the configured 'attributes-location'
  return attributes;
}
