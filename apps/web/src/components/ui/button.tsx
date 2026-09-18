import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  // Admin UI buttons: 8px radius, medium weight, no drop shadow; focus is a
  // 2px spot-purple ring (common/buttons/_buttons-base.scss).
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // .button-primary: --color-spot-strong fill inside a 1px --color-spot hairline.
        default:
          'border border-spot/90 bg-primary text-primary-foreground hover:bg-primary/85 active:bg-primary/75',
        destructive:
          'border border-destructive/60 bg-destructive text-destructive-foreground hover:bg-destructive/85',
        // .button-white-outline: transparent with a white hairline.
        outline:
          'border border-white/80 bg-transparent text-foreground hover:bg-white/10 active:bg-white/15',
        secondary:
          'border border-border bg-secondary text-secondary-foreground hover:bg-accent',
        ghost: 'hover:bg-white/10 hover:text-foreground',
        link: 'text-spot-text underline-offset-4 hover:text-spot-light hover:underline',
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6',
        icon: 'h-9 w-9',
        // Fully-rounded nav/toolbar pill (Expert, Recent Work…).
        pill: 'h-8 rounded-full px-3.5 text-xs',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
