import * as React from 'react';

import { cn } from '@/lib/utils';

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        // Admin .field: --surface-darker fill, 6px radius, spot-purple focus ring
        // with a --color-spot-strong border (themes/_curity.scss form tokens).
        'flex min-h-[80px] w-full rounded-md border border-border bg-surface-darker px-3 py-2 text-sm placeholder:text-muted-foreground/70 transition-[border-color,box-shadow] hover:border-white/30 focus-visible:border-primary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-spot/40 disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = 'Textarea';

export { Textarea };
