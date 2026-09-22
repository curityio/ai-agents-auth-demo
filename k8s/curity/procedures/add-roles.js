/**
 * Transformation procedure — assigns `roles` per user at login.
 * A write role (`sre` OR `oncall`) gates `ops:write` in the token-exchange procedure;
 * mcp-ops then applies the finer per-tool split (`Config.toolRequiredRoles`):
 * on-call may restart/scale; only `sre` may set_deployment_image.
 * @param {se.curity.identityserver.procedures.context.TransformationProcedureContext} context
 * @returns {*}
 */
function result(context) {
  var attributes = context.attributeMap;
  if (attributes.subject == 'alice') {
    // sre: full write tier.
    attributes.roles = ['sre'];
  } else if (attributes.subject == 'carol') {
    // on-call: may restart/scale (write role) but NOT set_deployment_image (needs sre).
    attributes.roles = ['oncall'];
  } else if (attributes.subject == 'bob') {
    // developer: no write role
    attributes.roles = ['developer'];
  }

  return attributes;
}
