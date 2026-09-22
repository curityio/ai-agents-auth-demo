/**
 * The landing page's persona sheet describes demo data that lives elsewhere
 * (roles in Curity's add-roles procedure). These tests pin the sheet to that
 * source so the cards can never promise a role Curity does not assign.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PERSONAS } from '../src/lib/personas';
import { PersonaCards } from '../src/components/persona-cards';

function rolesFromProcedure(): Record<string, string[]> {
  const src = readFileSync(
    resolve(__dirname, '../../../k8s/curity/procedures/add-roles.js'),
    'utf8',
  );
  const out: Record<string, string[]> = {};
  const re = /attributes\.subject == '(\w+)'\) \{[\s\S]*?attributes\.roles = \[([^\]]*)\]/g;
  for (const m of src.matchAll(re)) {
    out[m[1]!] = [...m[2]!.matchAll(/'(\w+)'/g)].map((r) => r[1]!);
  }
  return out;
}

describe('PERSONAS', () => {
  it('lists exactly alice, bob and carol', () => {
    expect(PERSONAS.map((p) => p.username)).toEqual(['alice', 'bob', 'carol']);
  });
  it('carries the roles the Curity add-roles procedure actually assigns', () => {
    const fromCurity = rolesFromProcedure();
    expect(Object.keys(fromCurity).sort()).toEqual(['alice', 'bob', 'carol']);
    for (const p of PERSONAS) expect(p.roles, p.username).toEqual(fromCurity[p.username]);
  });
  it('nobody is forced through a second factor at login — MFA is the RFC 9470 step-up, once', () => {
    // A forced second factor via the mfa-totp ACTION leaves acr=html-form on the
    // token, so the step-up fires anyway and the user types a TOTP twice.
    const src = readFileSync(
      resolve(__dirname, '../../../k8s/curity/procedures/add-roles.js'),
      'utf8',
    );
    expect(src).not.toMatch(/attributes\.requireSecondFactor\s*=/);
  });
});

describe('PersonaCards', () => {
  const html = renderToStaticMarkup(<PersonaCards />);
  it('renders one card per persona with name, roles and a sign-in button naming the user', () => {
    for (const p of PERSONAS) {
      const card = html.match(new RegExp(`<li[^>]*data-persona="${p.username}"[\\s\\S]*?</li>`))?.[0] ?? '';
      expect(card, p.username).toContain(p.displayName);
      expect(card).toContain(p.roles.join(', '));
      expect(card).not.toMatch(/at login|forced/);
      expect(card).toContain(`Sign in as ${p.username}`);
      expect(card).toMatch(/<button[^>]*type="button"/);
    }
  });
  it('wears the outcome as a tinted badge, not a loud one', () => {
    expect(html).toMatch(/text-success[^>]*>[^<]*step-up, then every tool/);
    expect(html).toMatch(/text-destructive[^>]*>[^<]*ops:write refused/);
    expect(html).toMatch(/text-warn[^>]*>[^<]*one tool refused/);
  });
  it('carries no numbered markers or all-caps labels', () => {
    expect(html).not.toMatch(/>0[123]</);
    expect(html).not.toMatch(/>USERNAME<|>ROLES</); // "MFA" is an acronym, not a label style
  });
});
