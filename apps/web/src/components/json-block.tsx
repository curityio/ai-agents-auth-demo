import { cn } from '@/lib/utils';

export function JsonBlock({ data, className }: { data: unknown; className?: string }) {
  return (
    <pre
      className={cn(
        'max-h-[28rem] overflow-auto rounded-lg border bg-muted/40 p-3.5 font-mono text-xs leading-relaxed text-foreground/80',
        className,
      )}
    >
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
