/**
 * Transformation procedure — assigns `roles` per user at login.
 * The `sre` role here is what gates `ops:write` in the token-exchange procedure.
 * @param {se.curity.identityserver.procedures.context.TransformationProcedureContext} context
 * @returns {*}
 */
function result(context) {
  // the 'context.attributeMap' content comes from the configured 'attributes-location' (subject-attributes, context-attributes, or action-attributes)
  var attributes = context.attributeMap;

  if (attributes.subject == 'alice') {
    attributes.roles = ['sre', 'oncall'];
  } else if (attributes.subject == 'bob') {
    attributes.roles = ['developer'];
    // trigger TOTP MFA for bob
    attributes.requireSecondFactor = true;
  }

  // the returned attributes will be assigned to the configured 'attributes-location'
  return attributes;
}
