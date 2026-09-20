import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { cn } from '@/lib/utils';

/**
 * Renders the copilot's answer. Model prose arrives as Markdown (bullets,
 * inline code, GFM tables); react-markdown never emits raw HTML from the
 * source, so anything HTML-shaped the model returns is shown as text.
 * Styling is scoped via the `.md` utility in globals.css.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
        {children}
      </ReactMarkdown>
    </div>
  );
}
