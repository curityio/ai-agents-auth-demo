import { describe, it, expect } from 'vitest';
import { StepUpRequiredError, isStepUpPayload, STEP_UP_CODE } from './step-up-error.js';

describe('StepUpRequiredError', () => {
  it('round-trips through toPayload/fromPayload', () => {
    const e = new StepUpRequiredError({
      acrValues: 'mfa',
      resourceMetadata: 'https://mcp-ops.localtest.me/.well-known/oauth-protected-resource',
      scope: 'ops:write',
    });
    const payload = e.toPayload();
    expect(payload.code).toBe(STEP_UP_CODE);
    expect(isStepUpPayload(payload)).toBe(true);
    const back = StepUpRequiredError.fromPayload(payload);
    expect(back.acrValues).toBe('mfa');
    expect(back.resourceMetadata).toBe(e.resourceMetadata);
    expect(back.scope).toBe('ops:write');
  });

  it('isStepUpPayload rejects unrelated payloads', () => {
    expect(isStepUpPayload({ code: -32000, message: 'other' })).toBe(false);
    expect(isStepUpPayload(null)).toBe(false);
    // correct code but no data — forces the data-checking branch
    expect(isStepUpPayload({ code: STEP_UP_CODE })).toBe(false);
    // data present but acrValues undefined
    expect(isStepUpPayload({ code: STEP_UP_CODE, data: {} })).toBe(false);
    // typeof null === 'object' trap
    expect(isStepUpPayload({ code: STEP_UP_CODE, data: null })).toBe(false);
  });
});
