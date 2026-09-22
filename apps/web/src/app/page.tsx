import { auth } from '@/auth';
import { AppShell } from '@/components/app-shell';
import { PersonaCards } from '@/components/persona-cards';
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
      {session ? <Chat asking={session.asking} /> : <PersonaCards />}
    </AppShell>
  );
}
