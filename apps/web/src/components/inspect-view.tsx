'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Layers, RefreshCw, ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { JsonBlock } from '@/components/json-block';
import { CopyButton } from '@/components/copy-button';
import { friendlyFetchError } from '@/lib/fetch-error';

interface ChainHop {
  hop: string;
  header: Record<string, unknown> | null;
  payload: Record<string, unknown> | null;
  /** Raw JWT — present because /api/inspect requests ?raw=1. */
  token?: string;
}

interface InspectResponse {
  sub?: string;
  expires_at?: number;
  chain: ChainHop[];
}

/** Render the TTL badge for a hop from its `exp` claim. */
function TtlBadge({ payload }: { payload: Record<string, unknown> | null }) {
  const exp = typeof payload?.exp === 'number' ? (payload.exp as number) : undefined;
  if (exp === undefined) return null;
  const remaining = Math.round(exp - Date.now() / 1000);
  if (remaining <= 0) {
    return <Badge variant="destructive">expired</Badge>;
  }
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  return <Badge variant="secondary">{m > 0 ? `${m}m ${s}s left` : `${s}s left`}</Badge>;
}

function TokenCard({ hop, primary }: { hop: ChainHop; primary?: boolean }) {
  return (
    <Card className={primary ? 'border-primary/40' : undefined}>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2 font-mono text-sm">
          {primary ? <KeyRound className="h-4 w-4 text-primary" /> : <Layers className="h-4 w-4 text-muted-foreground" />}
          {hop.hop}
        </CardTitle>
        <TtlBadge payload={hop.payload} />
      </CardHeader>
      <CardContent className="space-y-3">
        <JsonBlock data={{ header: hop.header, payload: hop.payload }} />
        {hop.token ? (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Raw JWT</span>
              <CopyButton value={hop.token} label="Copy token" />
            </div>
            <pre className="max-h-32 overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-foreground/70">
              {hop.token}
            </pre>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Raw token unavailable for this hop.</p>
        )}
      </CardContent>
    </Card>
  );
}

export function InspectView() {
  const [data, setData] = useState<InspectResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch('/api/inspect', { cache: 'no-store' });
      if (!r.ok) {
        setError(await friendlyFetchError(r, 'session tokens'));
        setData(null);
        return;
      }
      setData((await r.json()) as InspectResponse);
    } catch {
      setError("Couldn't load session tokens. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chain = data?.chain ?? [];
  const [userToken, ...exchanged] = chain;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
          <p className="text-sm text-muted-foreground">
            Every token available to this session right now — the Curity-issued user access token and
            each RFC&nbsp;8693 exchanged token. Raw JWTs are copyable. <strong>Debug-only.</strong>
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!error && userToken && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            User access token (Curity)
          </h2>
          <TokenCard hop={userToken} primary />
        </section>
      )}

      {!error && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Exchanged tokens (RFC 8693 on-behalf-of)
          </h2>
          {exchanged.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No exchanged tokens yet — run a copilot request first, then refresh.
            </p>
          ) : (
            <div className="space-y-3">
              {exchanged.map((hop, i) => (
                <TokenCard key={`${hop.hop}-${i}`} hop={hop} />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
