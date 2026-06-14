export {
  type BearerUser,
  type BearerUserBuilderOptions,
  bearerFromContext,
  createBearerUserBuilder,
  isBearerUser,
} from './server.js';

export { type BearerTokenProvider, createBearerAuthHandler } from './client.js';

export {
  type StepUpFields,
  type StepUpPayload,
  StepUpRequiredError,
  isStepUpPayload,
  STEP_UP_CODE,
} from './step-up-error.js';
