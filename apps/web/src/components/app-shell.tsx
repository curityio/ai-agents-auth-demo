import type { ReactNode } from 'react';
import Link from 'next/link';
import { Fingerprint, KeyRound, ShieldAlert, Radar, ArrowUpRight } from 'lucide-react';

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

/**
 * Page chrome styled after the Curity Admin UI: a 60px --surface-dark top bar
 * with the logo and an outlined product tag (the admin's "ADMIN UI" pill), a
 * hero rendered as the same flat ringed card every other section uses, and a
 * quiet footer. Colour is reserved for meaning — the one loud purple is the
 * hero wash.
 */
export function AppShell({ signedIn, displayName, email, children }: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-card">
        <div className="mx-auto flex h-[60px] w-full max-w-5xl items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-3.5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/curity-logo-landscape-white.svg" alt="Curity" className="h-6 w-auto" />
            <span className="inline-flex h-7 items-center rounded-full border border-white/20 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-white/75">
              SRE Copilot
            </span>
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
        {/* Hero — the admin card, filled with the spot-purple wash. */}
        <section className="surface-card overflow-hidden">
          <div className="surface-hero relative rounded-[inherit] px-7 py-11 sm:px-10 sm:py-14">
            <span className="nav-pill inline-flex items-center gap-2 px-3 py-1 text-xs font-medium text-white">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75 motion-reduce:hidden" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
              </span>
              Live demo
            </span>

            <h1 className="mt-6 max-w-2xl text-4xl font-bold leading-[1.08] tracking-tight text-white sm:text-5xl">
              Secure AI agent authorization,{' '}
              <span className="text-gradient">demonstrated.</span>
            </h1>

            <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/80 sm:text-lg">
              A DevOps copilot that reads observability data and manages workloads on a
              user&rsquo;s behalf. Every hop authenticated, scoped to least privilege, MFA-gated
              for privileged actions, and fully traceable. No standing credentials, no
              over-broad access.
            </p>

            <div className="mt-8 flex flex-wrap gap-2">
              {CAPABILITIES.map(({ icon: Icon, label }) => (
                <span
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/25 px-3 py-1.5 text-xs font-medium text-white/90"
                >
                  <Icon className="h-3.5 w-3.5 text-spot-light" />
                  {label}
                </span>
              ))}
            </div>
          </div>
        </section>

        <div className="mt-8">{children}</div>
      </main>

      <footer className="mt-4 border-t border-white/10 bg-card/60">
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
