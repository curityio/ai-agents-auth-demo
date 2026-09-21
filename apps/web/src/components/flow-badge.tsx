import { Eye, Lock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { Flow } from '@/lib/chat-rules';

/**
 * Names the delegation flow a panel is showing. Same icons and colours as the
 * prompt groups on the Ask card — and as the hero animation: lilac = read,
 * amber = privileged — so the MFA-gated chain reads at a glance wherever it
 * appears.
 */
const FLOW_BADGE: Record<
  Flow,
  { label: string; variant: 'secondary' | 'warning'; Icon: typeof Eye; iconClass: string }
> = {
  read: { label: 'Read flow', variant: 'secondary', Icon: Eye, iconClass: 'text-accent-violet' },
  privileged: { label: 'Privileged flow', variant: 'warning', Icon: Lock, iconClass: '' },
};

export function FlowBadge({ flow }: { flow: Flow }) {
  const { label, variant, Icon, iconClass } = FLOW_BADGE[flow];
  return (
    <Badge variant={variant} className="gap-1 font-sans">
      <Icon className={`h-3 w-3 ${iconClass}`.trim()} />
      {label}
    </Badge>
  );
}
