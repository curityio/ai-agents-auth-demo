import { describe, expect, it } from 'vitest';
import { imageRoleDenial } from '../src/mcp.js';

describe('imageRoleDenial (set_deployment_image role gate)', () => {
  it('allows a caller holding a required role (sre)', () => {
    expect(imageRoleDenial(['sre', 'oncall'], ['sre'])).toBeNull();
  });

  it('denies an oncall-only caller and names the required role', () => {
    const msg = imageRoleDenial(['oncall'], ['sre']);
    expect(msg).not.toBeNull();
    expect(msg).toMatch(/sre/);
    expect(msg).toMatch(/oncall/); // reports what the caller actually has
  });

  it('denies a caller with no roles', () => {
    const msg = imageRoleDenial([], ['sre']);
    expect(msg).toMatch(/none/);
  });

  it('allows if the caller has ANY of several required roles', () => {
    expect(imageRoleDenial(['oncall'], ['sre', 'oncall'])).toBeNull();
  });
});
