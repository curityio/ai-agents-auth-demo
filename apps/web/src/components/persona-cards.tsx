'use client';

import { signIn } from 'next-auth/react';
import { LogIn } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PERSONAS, type Persona } from '@/lib/personas';

/**
 * Signed-out landing: the three people you can become, and what will happen
 * to each. Replaces a generic "sign in to get started" card so the room learns
 * the three-act structure before the first login.
 *
 * The button sends `login_hint` (Curity's HTML Form authenticator pre-fills
 * the username — verified against 11.4) and `prompt=login`. The latter is
 * load-bearing: signing out of this app clears only its own cookie, so without
 * it Curity's SSO session would silently sign the PREVIOUS person back in.
 */
function signInAs(p: Persona) {
  void signIn('curity', { callbackUrl: '/' }, { login_hint: p.username, prompt: 'login' });
}

function PersonaCard({ p }: { p: Persona }) {
  return (
    <li
      data-persona={p.username}
      className="glass flex flex-col rounded-2xl p-5"
    >
      <h3 className="text-base font-bold tracking-tight">{p.displayName}</h3>
      <p className="mt-0.5 text-sm text-muted-foreground">{p.job}</p>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">username</dt>
        <dd className="font-mono">{p.username}</dd>
        <dt className="text-muted-foreground">roles</dt>
        <dd className="font-mono">{p.roles.join(', ')}</dd>
      </dl>

      {/* The verdict heads the story it summarises, so the name row stays one line. */}
      <div className="mt-4 flex-1">
        <Badge variant={p.outcome} className="whitespace-nowrap">
          {p.verdict}
        </Badge>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.story}</p>
      </div>

      <Button
        type="button"
        variant="outline"
        className="mt-5 w-full"
        onClick={() => signInAs(p)}
      >
        <LogIn />
        Sign in as {p.username}
      </Button>
    </li>
  );
}

export function PersonaCards() {
  return (
    <section aria-labelledby="personas-title" className="animate-fade-in-up">
      <div className="max-w-2xl">
        <h2 id="personas-title" className="text-xl font-bold tracking-tight">
          Sign in as one of the three seeded users
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          Same copilot, same cluster. Everyone signs in with a password and the first privileged
          action requires a TOTP code. What each person may do after that is decided by Curity,
          the gateway and the tool servers, with every decision displayed on this page in real time.
        </p>
      </div>
      <ul className="mt-6 grid gap-4 md:grid-cols-3">
        {PERSONAS.map((p) => (
          <PersonaCard key={p.username} p={p} />
        ))}
      </ul>
    </section>
  );
}
