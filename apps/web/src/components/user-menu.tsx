'use client';

import Link from 'next/link';
import { signOut } from 'next-auth/react';
import { Clock, LogOut, User2, ChevronsUpDown, KeyRound } from 'lucide-react';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { tokenLifetime } from '@/lib/session-view';
import { useNow } from '@/lib/use-now';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

function initials(label: string): string {
  const parts = label
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/**
 * How long the Curity access token has left. The 10-minute token is what
 * silently fails a demo — every panel then says "session expired" — so the
 * menu says it up front, and says what to do once it has expired.
 */
export function TokenCountdown({ expiresAt, now }: { expiresAt?: number; now: number }) {
  const life = tokenLifetime(expiresAt, now);
  if (!life) return null;
  const expired = life.level === 'expired';
  return (
    <div
      data-token-countdown
      className={cn(
        'flex items-center gap-2 px-2 py-1.5 text-xs',
        expired ? 'text-destructive' : life.level === 'low' ? 'text-warn' : 'text-muted-foreground',
      )}
      title="Curity access token — the one every request is exchanged from"
    >
      <Clock className="h-4 w-4 shrink-0" />
      <span>
        Access token <span className="font-mono">{expired ? 'expired' : life.label}</span>
        {expired && ' · sign in again'}
      </span>
    </div>
  );
}

export function UserMenu({
  name,
  email,
  debug = false,
  acr,
  expiresAt,
  now: nowProp,
}: {
  name: string;
  email?: string;
  debug?: boolean;
  /** The acr the next request will present — the sticky proof of step-up. */
  acr?: string;
  /** Access-token expiry, seconds since epoch (Auth.js `account.expires_at`). */
  expiresAt?: number;
  /** Clock override (ms) — tests inject it; the UI ticks its own. */
  now?: number;
}) {
  const tick = useNow(1000);
  const now = nowProp ?? tick;
  const life = tokenLifetime(expiresAt, now);
  const tokenLow = life !== null && life.level !== 'ok';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className={cn('h-10 gap-2 pl-1.5 pr-2.5', tokenLow && 'border-warn/60')}
          {...(tokenLow ? { 'data-token-low': true } : {})}
          title={life ? `Access token ${life.label}` : undefined}
        >
          <Avatar className="h-7 w-7">
            <AvatarFallback className="text-xs">{initials(name)}</AvatarFallback>
          </Avatar>
          <span className="hidden max-w-[10rem] truncate text-sm font-medium sm:inline">
            {name}
          </span>
          {acr && (
            <Badge
              data-acr
              variant={acr === 'mfa' ? 'success' : 'muted'}
              className="hidden font-mono text-[10px] sm:inline-flex"
              title="acr of the current access token"
            >
              {acr}
            </Badge>
          )}
          <ChevronsUpDown
            className={cn('h-4 w-4', tokenLow ? 'text-warn' : 'text-muted-foreground')}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex flex-col gap-0.5">
          <span className="text-sm font-semibold leading-none">{name}</span>
          {email && email !== name && (
            <span className="text-xs font-normal text-muted-foreground">{email}</span>
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <TokenCountdown expiresAt={expiresAt} now={now} />
        <DropdownMenuItem disabled>
          <User2 />
          Signed in via Curity
        </DropdownMenuItem>
        {debug && (
          <DropdownMenuItem asChild>
            <Link href="/inspect">
              <KeyRound />
              Inspect session
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:bg-destructive/10 focus:text-destructive [&_svg]:text-destructive"
          onSelect={() => void signOut({ callbackUrl: '/' })}
        >
          <LogOut />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
