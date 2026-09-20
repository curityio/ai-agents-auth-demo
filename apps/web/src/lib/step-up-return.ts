/**
 * The RFC 9470 step-up is a full-page OIDC redirect, which remounts the chat
 * and would discard the prompt the user typed. Before redirecting we stash it;
 * on return we take it back exactly once and auto-retry. Keeping the handshake
 * here (not inline in the component) gives the UI a fact to show the user —
 * "you are back from MFA, your request is being retried" — instead of a spinner
 * that fires for no visible reason.
 */
const MESSAGE_KEY = 'sre.pendingMessage';
const SCOPE_KEY = 'sre.pendingScope';
const RETRY_KEY = 'sre.autoRetry';

export interface StepUpReturn {
  message: string;
  scope: string;
  retry: boolean;
}

export function stashStepUp(storage: Storage, message: string, scope: string): void {
  storage.setItem(MESSAGE_KEY, message);
  storage.setItem(SCOPE_KEY, scope);
  storage.setItem(RETRY_KEY, '1');
}

/** One-shot: returns the stashed prompt and clears it, or null if none. */
export function takeStepUpReturn(storage: Storage): StepUpReturn | null {
  const message = storage.getItem(MESSAGE_KEY);
  if (message === null) return null;
  const scope = storage.getItem(SCOPE_KEY) ?? '';
  const retry = storage.getItem(RETRY_KEY) !== null;
  storage.removeItem(MESSAGE_KEY);
  storage.removeItem(SCOPE_KEY);
  storage.removeItem(RETRY_KEY);
  return { message, scope, retry };
}
