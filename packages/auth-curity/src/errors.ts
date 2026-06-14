export type CurityAuthErrorCode =
  | 'access_denied'
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
  | 'jwks_failed';

export class CurityAuthError extends Error {
  public readonly code: CurityAuthErrorCode;

  constructor(message: string, code: CurityAuthErrorCode, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CurityAuthError';
    this.code = code;
  }
}
