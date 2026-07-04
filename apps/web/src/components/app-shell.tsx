import type { ReactNode } from 'react';
import Link from 'next/link';
import {
  ShieldCheck,
  Fingerprint,
  KeyRound,
  ShieldAlert,
  Radar,
  ArrowUpRight,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { SignInButton } from '@/components/sign-in-button';
import { UserMenu } from '@/components/user-menu';

const CAPABILITIES = [
  { icon: Fingerprint, label: 'SPIFFE workload identity' },
  { icon: KeyRound, label: 'RFC 8693 token exchange' },
  { icon: ShieldAlert, label: 'RFC 9470 step-up MFA' },
  { icon: Radar, label: 'OpenTelemetry tracing' },
];

interface AppShellProps {
  signedIn: boolean;
  displayName?: string | null;
  email?: string | null;
  children: ReactNode;
}

export function AppShell({ signedIn, displayName, email, children }: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-4 sm:gap-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/curity-logo-landscape-white.svg"
              alt="Curity"
              className="h-7 w-auto"
            />
            <span aria-hidden className="h-7 w-px bg-border" />
            <div className="flex items-center gap-3">
              <div className="mesh-hero flex h-9 w-9 items-center justify-center rounded-xl text-white shadow-lg shadow-primary/30 ring-1 ring-white/30">
                <ShieldCheck className="h-5 w-5" />
              </div>
              <div className="leading-tight">
                <div className="text-sm font-bold tracking-tight">SRE Copilot</div>
                <div className="text-xs text-muted-foreground">Secure AI agent operations</div>
              </div>
            </div>
          </div>
          {signedIn ? (
            <UserMenu
              name={displayName ?? ''}
              email={email ?? undefined}
              debug={process.env.AUTH_DEBUG === 'true'}
            />
          ) : (
            <SignInButton size="sm" />
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {/* Hero */}
        <section className="relative animate-fade-in-up overflow-hidden rounded-3xl">
          <div className="mesh-hero animate-gradient-pan bg-[length:200%_200%] px-7 py-12 sm:px-10 sm:py-14">
            {/* dotted texture + sheen */}
            <div className="bg-grid pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(80%_80%_at_50%_0%,black,transparent)]" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/15 to-transparent" />

            <div className="relative">
              <span className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/15 px-3 py-1 text-xs font-medium text-white backdrop-blur">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-white" />
                </span>
                Live demo
              </span>

              <h1 className="mt-5 max-w-2xl text-4xl font-extrabold leading-[1.05] tracking-tight text-white sm:text-5xl">
                Secure AI agent
                <br />
                authorization,{' '}
                <span className="bg-gradient-to-r from-[#C9A8FF] to-[#E9DEFF] bg-clip-text text-transparent">
                  demonstrated.
                </span>
              </h1>

              <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/85 sm:text-lg">
                A DevOps copilot that reads observability data and restarts workloads on a
                user&rsquo;s behalf — every hop authenticated, scoped to least privilege,
                MFA-gated for privileged actions, and fully traceable. No standing credentials,
                no over-broad access.
              </p>

              <div className="mt-7 flex flex-wrap gap-2.5">
                {CAPABILITIES.map(({ icon: Icon, label }) => (
                  <span
                    key={label}
                    className="inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur transition-colors hover:bg-white/20"
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        <div className="mt-8">{children}</div>
      </main>

      <footer className="mt-4 border-t border-border">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-6 py-6 text-xs text-muted-foreground">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/curity-logo-landscape-white.svg"
              alt="Curity"
              className="h-4 w-auto opacity-80"
            />
            <span>· SPIFFE · Istio Ambient — AI agent authentication &amp; authorization demo</span>
          </span>
          {signedIn && (
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
              <Link href="/api/whoami">
                Inspect session
                <ArrowUpRight className="h-3 w-3" />
              </Link>
            </Button>
          )}
        </div>
      </footer>
    </div>
  );
}
