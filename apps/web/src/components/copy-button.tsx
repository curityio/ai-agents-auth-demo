'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

import { Button } from '@/components/ui/button';

/** Copy `value` to the clipboard, flashing a confirmation for ~1.5s. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — no-op; the raw
      // token is still visible for manual selection.
    }
  }

  return (
    <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={onCopy}>
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
