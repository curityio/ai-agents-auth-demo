import { ShieldCheck } from 'lucide-react';

import { auth } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { SignInButton } from '@/components/sign-in-button';
import { Chat } from './chat';

export default async function Home() {
  const session = await auth();
  const displayName = session?.user?.name ?? session?.user?.email ?? session?.user?.id ?? '';

  return (
    <AppShell
      signedIn={!!session}
      displayName={displayName}
      email={session?.user?.email}
      acr={session?.asking?.acr}
      tokenExpiresAt={session?.tokenExpiresAt}
    >
      {session ? (
        <Chat asking={session.asking} />
      ) : (
        <div className="glass animate-fade-in-up mx-auto max-w-md rounded-2xl p-8 text-center">
          <div className="mesh-hero mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg shadow-primary/30 ring-1 ring-white/30">
            <ShieldCheck className="h-7 w-7" />
          </div>
          <h2 className="text-xl font-bold tracking-tight">Sign in to get started</h2>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Authenticate with Curity to interact with the copilot and watch the delegated
            authorization chain build in real time.
          </p>
          <div className="mt-6">
            <SignInButton className="w-full" size="lg" />
          </div>
        </div>
      )}
    </AppShell>
  );
}
