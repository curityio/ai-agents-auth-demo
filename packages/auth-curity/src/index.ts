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
export {
  buildIdentityAttributes,
  decorateSpanWithIdentity,
  upstreamVerifiedIdentityAttributes,
} from './identity-span.js';
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
export {
  createDpopKey,
  createDpopProof,
  verifyDpopProof,
  accessTokenHash,
  cnfJkt,
  tokenCnfJkt,
  DpopProofError,
  DpopReplayCache,
  type DpopKey,
  type DpopProofInput,
  type VerifyDpopProofOptions,
} from './dpop.js';
