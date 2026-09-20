import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ResultSkeleton } from '../src/components/result-skeleton';

describe('ResultSkeleton', () => {
  it('announces itself as busy with a readable label', () => {
    const html = renderToStaticMarkup(<ResultSkeleton />);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="status"');
    expect(html).toMatch(/Asking the copilot/);
  });
});
