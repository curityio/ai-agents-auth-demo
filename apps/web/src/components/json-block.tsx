import { cn } from '@/lib/utils';

export function JsonBlock({ data, className }: { data: unknown; className?: string }) {
  return (
    <pre
      className={cn(
        'scrollbar-thin max-h-[28rem] overflow-auto rounded-md border border-white/10 bg-surface-darker p-3.5 font-mono text-xs leading-relaxed text-foreground/85',
        className,
      )}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
