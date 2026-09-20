import { Loader2 } from 'lucide-react';

import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Placeholder for the Result card while a request is in flight. A request spans
 * an LLM call, an MCP round-trip and several token exchanges, so it sets the
 * expectation that an answer card is coming rather than leaving a blank gap.
 */
export function ResultSkeleton() {
  return (
    <Card role="status" aria-busy="true" aria-live="polite" className="animate-fade-in-up">
      <CardHeader>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          Asking the copilot… exchanging tokens, calling tools, composing an answer.
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-24 rounded-md" />
          <Skeleton className="h-8 w-20 rounded-md" />
        </div>
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-9/12" />
        <Skeleton className="h-4 w-10/12" />
        <Skeleton className="h-4 w-6/12" />
      </CardContent>
    </Card>
  );
}
