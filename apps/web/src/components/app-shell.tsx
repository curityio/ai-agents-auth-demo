import type { ReactNode } from 'react';
import Link from 'next/link';
import { ShieldCheck, Fingerprint, KeyRound, ShieldAlert, Radar, ArrowUpRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { HeroStage } from '@/components/hero-stage';
import { SignInButton } from '@/components/sign-in-button';
import { UserMenu } from '@/components/user-menu';

// Each claim links to the panel that proves it (ids live on the cards in
// chat.tsx). Signed out, the panels do not exist, so the chips stay inert.
// Icon colours reuse meanings the page already has: lilac = identity (the
// workload boxes), fuchsia = exchange (a tint nothing else on the page uses —
// amber is taken: it means PRIVILEGED on the stage and step-up everywhere
// below, so the exchange chip must not wear it), the headline's pink = MFA,
// green = live/verified (the demo dot).
const CAPABILITIES = [
  {
    icon: Fingerprint,
    label: 'SPIFFE workload identity',
    target: '#identities',
    tint: 'text-accent-violet',
  },
  {
    icon: KeyRound,
    label: 'RFC 8693 token exchange',
    target: '#chain',
    tint: 'text-accent-fuchsia',
  },
  { icon: ShieldAlert, label: 'RFC 9470 step-up MFA', target: '#ask', tint: 'text-[#F7B9DE]' },
  { icon: Radar, label: 'OpenTelemetry tracing', target: '#result', tint: 'text-success' },
];

const CHIP_CLASS =
  'inline-flex items-center gap-1.5 rounded-full border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-medium text-white/90 backdrop-blur transition-colors hover:bg-white/20';

function CapabilityChips({ signedIn }: { signedIn: boolean }) {
  return (
    <div className="flex flex-wrap gap-2.5 lg:gap-2">
      {CAPABILITIES.map(({ icon: Icon, label, target, tint }) =>
        signedIn ? (
          <a
            key={label}
            href={target}
            title="Jump to the panel that proves this"
            className={`group ${CHIP_CLASS}`}
          >
            <Icon className={`h-4 w-4 ${tint}`} />
            {label}
            <ArrowUpRight className="h-3 w-3 opacity-0 transition-opacity group-hover:opacity-80" />
          </a>
        ) : (
          <span key={label} className={CHIP_CLASS}>
            <Icon className={`h-4 w-4 ${tint}`} />
            {label}
          </span>
        ),
      )}
    </div>
  );
}

interface AppShellProps {
  signedIn: boolean;
  displayName?: string | null;
  email?: string | null;
  /** acr of the current access token, shown on the user pill. */
  acr?: string;
  /** Access-token expiry (seconds since epoch), counted down in the user menu. */
  tokenExpiresAt?: number;
  children: ReactNode;
}

export function AppShell({
  signedIn,
  displayName,
  email,
  acr,
  tokenExpiresAt,
  children,
}: AppShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-4 px-6">
          <div className="flex items-center gap-4 sm:gap-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/curity-logo-landscape-white.svg" alt="Curity" className="h-7 w-auto" />
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
              acr={acr}
              expiresAt={tokenExpiresAt}
            />
          ) : (
            <SignInButton size="sm" />
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl flex-1 px-6 py-10">
        {/* Hero */}
        <section className="relative animate-fade-in-up overflow-hidden rounded-3xl">
          <div className="mesh-hero-enterprise animate-gradient-pan bg-[length:200%_200%] px-7 py-9 sm:px-10 sm:py-11 lg:py-8">
            {/* dotted texture + sheen */}
            <div className="bg-grid pointer-events-none absolute inset-0 opacity-30 [mask-image:radial-gradient(80%_80%_at_50%_0%,black,transparent)]" />
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/15 to-transparent" />

            <div className="relative">
              {/* On wide screens the copy sits in the stage's empty top-left quadrant. */}
              <div className="lg:absolute lg:left-0 lg:top-0 lg:z-10 lg:max-w-[580px]">
                <span className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/15 px-3 py-1 text-xs font-medium text-white backdrop-blur">
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-success shadow-[0_0_8px_2px_hsl(var(--success)/0.7)]" />
                  </span>
                  Live demo
                </span>

                <h1 className="mt-5 max-w-2xl text-4xl font-extrabold leading-[1.05] tracking-tight text-white sm:text-5xl lg:mt-3 lg:text-[2rem]">
                  Secure AI agent
                  <br />
                  authorization,{' '}
                  <span className="bg-gradient-to-r from-[#F7B9DE] to-[#FFEAF5] bg-clip-text text-transparent">
                    demonstrated.
                  </span>
                </h1>

                <p className="mt-4 max-w-2xl text-base leading-relaxed text-white/85 sm:text-lg lg:mt-2 lg:max-w-[520px] lg:text-sm">
                  A DevOps copilot that reads observability data and manages workloads on a
                  user&rsquo;s behalf. No standing credentials, no over-broad access.
                </p>

                {/* Below lg the chips stay in the copy; on the stage they move under it. */}
                <div className="mt-7 lg:hidden">
                  <CapabilityChips signedIn={signedIn} />
                </div>
              </div>

              {/* The stage the panels below prove, on wide screens only. */}
              <div className="hidden lg:block">
                <HeroStage signedIn={signedIn} footer={<CapabilityChips signedIn={signedIn} />} />
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
          <span className="flex items-center gap-4">
            {signedIn && process.env.AUTH_DEBUG === 'true' && (
              <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
                <Link href="/inspect">
                  Inspect session
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              </Button>
            )}
            <Button variant="link" size="sm" className="h-auto p-0 text-xs" asChild>
              <a
                href="https://github.com/curityio/ai-agents-auth-demo"
                target="_blank"
                rel="noreferrer"
              >
                Source on GitHub
                <ArrowUpRight className="h-3 w-3" />
              </a>
            </Button>
          </span>
        </div>
      </footer>
    </div>
  );
}
