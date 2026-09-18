import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  // Admin UI .pill / .severity: fully rounded, bold, small tracking.
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-[0.02em] transition-colors focus:outline-none focus:ring-2 focus:ring-ring/50',
  {
    variants: {
      variant: {
        // .pill-primary — --color-spot-strong fill, white text (counter badge).
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-white/10 text-foreground',
        // .pill-danger — solid fill.
        destructive: 'border-transparent bg-destructive text-destructive-foreground',
        // .severity-* — outlined in the status colour, text in the same colour.
        success: 'border-success/70 bg-success/10 text-success',
        warning: 'border-warn/70 bg-warn/10 text-warn',
        outline: 'border-white/30 text-foreground',
        muted: 'border-transparent bg-white/[0.06] text-muted-foreground',
        // Spot-purple outline (admin .severity default border).
        spot: 'border-spot/60 bg-spot/10 text-spot-light',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
