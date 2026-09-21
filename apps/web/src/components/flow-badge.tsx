import { Eye, Lock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { Flow } from '@/lib/chat-rules';

/**
 * Names the delegation flow a panel is showing. Same icons and colour as the
 * prompt chips (amber = privileged), so the MFA-gated chain reads at a glance
 * wherever it appears.
 */
const FLOW_BADGE: Record<
  Flow,
  { label: string; variant: 'secondary' | 'warning'; Icon: typeof Eye }
> = {
  read: { label: 'Read flow', variant: 'secondary', Icon: Eye },
  privileged: { label: 'Privileged flow', variant: 'warning', Icon: Lock },
};

export function FlowBadge({ flow }: { flow: Flow }) {
  const { label, variant, Icon } = FLOW_BADGE[flow];
  return (
    <Badge variant={variant} className="gap-1 font-sans">
      <Icon className="h-3 w-3" />
      {label}
    </Badge>
  );
}
