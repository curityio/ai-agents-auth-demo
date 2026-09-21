import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlowBadge } from '../src/components/flow-badge';

describe('FlowBadge', () => {
  it('renders the read flow neutral with an eye icon', () => {
    const html = renderToStaticMarkup(<FlowBadge flow="read" />);
    expect(html).toContain('Read flow');
    expect(html).toContain('lucide-eye');
    expect(html).not.toContain('bg-warn');
  });
  it('renders the privileged flow in the amber of the privileged prompt chips, with a lock', () => {
    const html = renderToStaticMarkup(<FlowBadge flow="privileged" />);
    expect(html).toContain('Privileged flow');
    expect(html).toContain('lucide-lock');
    expect(html).toContain('bg-warn');
  });
});
