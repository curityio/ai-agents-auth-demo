import { AlertTriangle, ShieldX } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import type { AgentFailure } from '@/lib/chat-rules';

/**
 * A denial is a verdict — the authorization chain doing its job — so it gets
 * its own headline and the reason in prose. Only a real failure is "failed",
 * and that one keeps the raw status + body for diagnosis during a demo.
 */
export function RequestFailure({
  failure,
}: {
  failure: Exclude<AgentFailure, { kind: 'step-up' }>;
}) {
  if (failure.kind === 'denied') {
    return (
      <Alert variant="destructive">
        <ShieldX className="h-4 w-4" />
        <AlertTitle>Access denied</AlertTitle>
        <AlertDescription>{failure.reason}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertTriangle className="h-4 w-4" />
      <AlertTitle>Request failed</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>{failure.message}</p>
        <p className="break-words font-mono text-xs opacity-80">{failure.detail}</p>
      </AlertDescription>
    </Alert>
  );
}
