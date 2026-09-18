import { ShieldCheck } from 'lucide-react';

import { auth } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { SignInButton } from '@/components/sign-in-button';
import { Chat } from './chat';

export default async function Home() {
  const session = await auth();
  const displayName = session?.user?.name ?? session?.user?.email ?? session?.user?.id ?? '';

  return (
    <AppShell signedIn={!!session} displayName={displayName} email={session?.user?.email}>
      {session ? (
        <Chat />
      ) : (
        <div className="surface-card mx-auto max-w-md p-8 text-center">
          <div className="tile tile-spot mx-auto mb-4 h-14 w-14 rounded-lg">
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
