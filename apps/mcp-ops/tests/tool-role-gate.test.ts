import { describe, expect, it } from 'vitest';
import { toolRoleDenial } from '../src/mcp.js';
import { DEFAULT_TOOL_REQUIRED_ROLES, parseToolRequiredRoles } from '../src/config.js';

describe('toolRoleDenial (per-tool role gate)', () => {
  it('allows a caller holding a required role', () => {
    expect(toolRoleDenial('set_deployment_image', ['sre'], ['sre'])).toBeNull();
  });

  it('denies an oncall-only caller, naming the tool, the required role and what the caller has', () => {
    const msg = toolRoleDenial('set_deployment_image', ['oncall'], ['sre']);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/set_deployment_image/);
    expect(msg).toMatch(/sre/);
    expect(msg).toMatch(/oncall/); // reports what the caller actually has
  });

  it('denies a caller with no roles', () => {
    const msg = toolRoleDenial('scale_deployment', [], ['sre', 'oncall']);
    expect(msg).toMatch(/none/);
  });

  it('allows if the caller has ANY of several required roles', () => {
    expect(toolRoleDenial('restart_deployment', ['oncall'], ['sre', 'oncall'])).toBeNull();
  });

  it('never gates a tool with an empty requirement', () => {
    expect(toolRoleDenial('restart_deployment', [], [])).toBeNull();
  });
});

describe('parseToolRequiredRoles (TOOL_REQUIRED_ROLES)', () => {
  it('defaults to the full matrix: restart/scale need a write role, set image needs sre', () => {
    expect(parseToolRequiredRoles(undefined)).toEqual(DEFAULT_TOOL_REQUIRED_ROLES);
    expect(DEFAULT_TOOL_REQUIRED_ROLES).toEqual({
      restart_deployment: ['sre', 'oncall'],
      scale_deployment: ['sre', 'oncall'],
      set_deployment_image: ['sre'],
    });
  });

  it('parses "tool=role role, tool=role" — commas between tools, whitespace or | between roles', () => {
    expect(
      parseToolRequiredRoles('restart_deployment=sre oncall, scale_deployment=sre|oncall,set_deployment_image=sre'),
    ).toEqual({
      restart_deployment: ['sre', 'oncall'],
      scale_deployment: ['sre', 'oncall'],
      set_deployment_image: ['sre'],
    });
  });

  it('an explicit value REPLACES the default map rather than merging into it', () => {
    // Otherwise there would be no way to un-gate a tool from the environment.
    expect(parseToolRequiredRoles('set_deployment_image=sre')).toEqual({ set_deployment_image: ['sre'] });
  });

  it('rejects a malformed entry loudly instead of silently un-gating a tool', () => {
    expect(() => parseToolRequiredRoles('set_deployment_image')).toThrow(/TOOL_REQUIRED_ROLES/);
    expect(() => parseToolRequiredRoles('set_deployment_image=')).toThrow(/TOOL_REQUIRED_ROLES/);
  });
});
