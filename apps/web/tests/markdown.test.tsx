/**
 * The copilot's answer is model prose that arrives as Markdown (bullets,
 * inline code, tables). Pin that the answer box renders it as HTML rather than
 * showing raw `*` and backticks, and that GFM tables work.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/components/markdown';

describe('Markdown', () => {
  it('renders bullets and inline code as elements', () => {
    const html = renderToStaticMarkup(<Markdown>{'- `order-service` is **Running**'}</Markdown>);
    expect(html).toContain('<ul');
    expect(html).toContain('<code');
    expect(html).toContain('<strong');
    expect(html).not.toContain('`');
  });

  it('renders GFM tables', () => {
    const html = renderToStaticMarkup(
      <Markdown>{'| pod | status |\n| --- | --- |\n| a | Running |'}</Markdown>,
    );
    expect(html).toContain('<table');
    expect(html).toContain('Running');
  });

  it('does not render raw HTML from the model', () => {
    const html = renderToStaticMarkup(<Markdown>{'hi <b onclick="x()">bold</b> there'}</Markdown>);
    expect(html).not.toContain('<b');
    expect(html).not.toContain('onclick');
    expect(html).toContain('bold');
  });
});
