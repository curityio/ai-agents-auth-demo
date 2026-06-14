'use client';

import { signIn } from 'next-auth/react';
import { LogIn } from 'lucide-react';

import { Button, type ButtonProps } from '@/components/ui/button';

export function SignInButton({
  children = 'Sign in with Curity',
  ...props
}: ButtonProps) {
  return (
    <Button onClick={() => void signIn('curity', { callbackUrl: '/' })} {...props}>
      <LogIn />
      {children}
    </Button>
  );
}
