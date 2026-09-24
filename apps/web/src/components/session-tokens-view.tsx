'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { DelegationLedger, type LedgerHop } from '@/components/delegation-ledger';
import { friendlyFetchError } from '@/lib/fetch-error';

interface SessionTokensResponse {
  sub?: string;
  expires_at?: number;
  chain: LedgerHop[];
}

export function SessionTokensView() {
  const [data, setData] = useState<SessionTokensResponse | null>(null);
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
      setData((await r.json()) as SessionTokensResponse);
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-start gap-2">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <p className="text-sm text-muted-foreground">
            Every token available to this session right now — the Curity-issued user access token
            (hop 0) and each RFC&nbsp;8693 exchanged token, diffed against the token it was exchanged
            from. Raw JWTs are copyable under each hop. <strong>Debug-only.</strong>
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {!error && chain.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">
          No tokens yet — run a copilot request first, then refresh.
        </p>
      )}

      {!error && chain.length > 0 && <DelegationLedger chain={chain} showRaw />}
    </div>
  );
}
