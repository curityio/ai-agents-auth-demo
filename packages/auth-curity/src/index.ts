export { getOidcConfig, type OidcConfig } from './oidc.js';
export { verifyJwt, type VerifyJwtOptions, type VerifiedJwt } from './verify.js';
export { CurityAuthError } from './errors.js';
export {
  exchangeToken,
  type ClientAuth,
  type ExchangeTokenParams,
  type ExchangeTokenResult,
} from './exchange.js';
export {
  createCimdIdentity,
  type CimdIdentity,
  type CimdMetadataDocument,
  type CreateCimdIdentityParams,
} from './cimd.js';
export { buildIdentityAttributes, decorateSpanWithIdentity } from './identity-span.js';
export { buildExchangeAttributes, type ExchangeSpanInput } from './exchange-span.js';
export {
  oboLog,
  formatOboLog,
  summarizeJwt,
  activeTraceId,
  flattenAct,
  type OboKind,
  type OboLogEvent,
  type JwtSummary,
} from './obo-log.js';
