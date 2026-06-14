export const STEP_UP_CODE = -33001; // app-specific A2A/JSON-RPC error code

export interface StepUpFields {
  acrValues: string;
  resourceMetadata: string;
  scope: string;
}

export interface StepUpPayload {
  code: number;
  message: string;
  data: StepUpFields;
}

export class StepUpRequiredError extends Error {
  readonly acrValues: string;
  readonly resourceMetadata: string;
  readonly scope: string;
  constructor(fields: StepUpFields) {
    super(`step-up required: acr_values=${fields.acrValues}`);
    this.name = 'StepUpRequiredError';
    this.acrValues = fields.acrValues;
    this.resourceMetadata = fields.resourceMetadata;
    this.scope = fields.scope;
  }
  toPayload(): StepUpPayload {
    return {
      code: STEP_UP_CODE,
      message: this.message,
      data: {
        acrValues: this.acrValues,
        resourceMetadata: this.resourceMetadata,
        scope: this.scope,
      },
    };
  }
  static fromPayload(p: StepUpPayload): StepUpRequiredError {
    return new StepUpRequiredError(p.data);
  }
}

export function isStepUpPayload(p: unknown): p is StepUpPayload {
  if (typeof p !== 'object' || p === null) return false;
  if ((p as { code?: number }).code !== STEP_UP_CODE) return false;
  const data = (p as { data?: unknown }).data;
  return (
    typeof data === 'object' && data !== null &&
    (data as { acrValues?: unknown }).acrValues !== undefined
  );
}
