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

export class CurityAuthError extends Error {
  public readonly code: CurityAuthErrorCode;

  constructor(message: string, code: CurityAuthErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CurityAuthError';
    this.code = code;
  }
}
