import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolVisibility, type TierResult } from '../src/components/tool-visibility';

const READ: TierResult = {
  tier: 'inspect',
  route: '/inspect/mcp',
  status: 'ok',
  tools: [
    { name: 'get_pod_logs', description: 'Fetch recent logs for a pod' },
    { name: 'list_pods', description: 'List pods in a namespace' },
  ],
};
const WRITE_ALICE: TierResult = {
  tier: 'ops',
  route: '/ops/mcp',
  status: 'ok',
  tools: [
    {
      name: 'set_deployment_image',
      description: 'Set the container image',
      requiredRoles: ['sre'],
      callable: true,
    },
    {
      name: 'restart_deployment',
      description: 'Rollout-restart a deployment',
      requiredRoles: ['sre', 'oncall'],
      callable: true,
    },
  ],
};
// carol (oncall): passes the write-role gate on restart, fails the sre gate on set image.
const WRITE_CAROL: TierResult = {
  ...WRITE_ALICE,
  tools: WRITE_ALICE.tools.map((t) =>
    t.requiredRoles && !t.requiredRoles.includes('oncall') ? { ...t, callable: false } : t,
  ),
};
const WRITE_STEPUP: TierResult = {
  tier: 'ops',
  route: '/ops/mcp',
  status: 'step-up',
  acrValues: 'mfa',
  scope: 'ops:write',
};

describe('ToolVisibility', () => {
  it('renders one row per tool with its description, in the fixed order', () => {
    const html = renderToStaticMarkup(<ToolVisibility tiers={[READ]} />);
    expect(html.indexOf('list_pods')).toBeLessThan(html.indexOf('get_pod_logs'));
    expect(html).toContain('List pods in a namespace');
    expect(html).toContain('Fetch recent logs for a pod');
  });

  it('separates the requirement from the verdict in the tier header', () => {
    const html = renderToStaticMarkup(<ToolVisibility tiers={[READ, WRITE_STEPUP]} />);
    expect(html).toContain('requires inspect:read');
    expect(html).toContain('2 tools listed for you');
    expect(html).toContain('requires ops:write');
    expect(html).toContain('not listed · step-up required');
  });

  it('uses the legend icons: eye for the read tier, lock for the write tier', () => {
    const html = renderToStaticMarkup(<ToolVisibility tiers={[READ, WRITE_ALICE]} />);
    // The tier icon immediately precedes the tier title in the header.
    expect(html).toMatch(/lucide-eye[^]{0,800}?Read tier/);
    expect(html).toMatch(/lucide-lock[^]{0,800}?Write tier/);
  });

  it('shows the role gate on a gated tool even when this user passes it', () => {
    const html = renderToStaticMarkup(<ToolVisibility tiers={[WRITE_ALICE]} />);
    const row = html.match(/<li[^>]*data-tool="set_deployment_image"[\s\S]*?<\/li>/)?.[0] ?? '';
    expect(row).toContain('role sre');
    expect(row).toContain('lucide-check');
    expect(row).not.toContain('needs sre');
  });

  it('marks a gated tool this user cannot call', () => {
    const html = renderToStaticMarkup(<ToolVisibility tiers={[WRITE_CAROL]} />);
    const row = html.match(/<li[^>]*data-tool="set_deployment_image"[\s\S]*?<\/li>/)?.[0] ?? '';
    expect(row).toContain('needs sre');
    expect(row).toContain('lucide-lock');
    expect(html).toContain('Listed ≠ callable');
  });

  it('renders the whole role matrix: a multi-role requirement reads "role sre or oncall"', () => {
    // Every ops tool now publishes its required roles, so the card shows the
    // hierarchy per row rather than one badge that looks like an exception.
    const html = renderToStaticMarkup(<ToolVisibility tiers={[WRITE_CAROL]} />);
    const row = html.match(/<li[^>]*data-tool="restart_deployment"[\s\S]*?<\/li>/)?.[0] ?? '';
    expect(row).toContain('role sre or oncall');
    expect(row).toContain('lucide-check');
    expect(row).not.toContain('needs');
  });

  it('states the gate each tier had to pass', () => {
    const text = renderToStaticMarkup(<ToolVisibility tiers={[READ, WRITE_ALICE]} />).replace(
      /<[^>]+>/g,
      '',
    );
    expect(text).toContain('inspect:read is on the copilot');
    expect(text).toContain('acr=mfa');
  });
});
