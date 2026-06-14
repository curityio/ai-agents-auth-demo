import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, KeyRound } from 'lucide-react';

import { auth } from '@/auth';
import { InspectView } from '@/components/inspect-view';

/**
 * Demo-only token inspector. Server-gated on AUTH_DEBUG=true (notFound otherwise,
 * matching the /api/inspect + /api/dev/token posture) and behind a session.
 */
// Force dynamic rendering: the AUTH_DEBUG gate below short-circuits with
// notFound() *before* auth() reads cookies, so Next.js sees no dynamic API on
// that path and would otherwise prerender this route statically — baking in a
// 404 (AUTH_DEBUG is unset at build time) that never re-checks the env at
// runtime. force-dynamic makes the gate run per-request, where AUTH_DEBUG is set.
export const dynamic = 'force-dynamic';

export default async function InspectPage() {
  if (process.env.AUTH_DEBUG !== 'true') {
    notFound();
  }
  const session = await auth();
  if (!session) {
    redirect('/');
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-10">
      <header className="mb-8 flex flex-col gap-3">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to copilot
        </Link>
        <div className="flex items-center gap-2.5">
          <div className="mesh-hero flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-lg shadow-primary/30 ring-1 ring-white/30">
            <KeyRound className="h-5 w-5" />
          </div>
          <div className="leading-tight">
            <h1 className="text-lg font-bold tracking-tight">Inspect session</h1>
            <p className="text-xs text-muted-foreground">Raw tokens available to this session</p>
          </div>
        </div>
      </header>

      <InspectView />
    </div>
  );
}
