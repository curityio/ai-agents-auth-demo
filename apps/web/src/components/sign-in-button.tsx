'use client';

import { signIn } from 'next-auth/react';
import { LogIn } from 'lucide-react';

// `prompt=login` forces a fresh password entry even when Curity still holds an SSO
// session for the previous person: signing out of the app clears only its own cookie.
// The Curity client itself no longer sets force-authn (the step-up in chat.tsx relies
// on the password SSO session to skip the TOTP authenticator's username page), so
// every LOGIN entry point must ask for it explicitly — this button and persona-cards.tsx.

import { Button, type ButtonProps } from '@/components/ui/button';

export function SignInButton({
  children = 'Sign in with Curity',
  ...props
}: ButtonProps) {
  return (
    <Button onClick={() => void signIn('curity', { callbackUrl: '/' }, { prompt: 'login' })} {...props}>
      <LogIn />
      {children}
    </Button>
  );
}
