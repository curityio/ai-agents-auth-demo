/**
 * The three seeded demo users, as the landing page presents them.
 *
 * This is a DESCRIPTION of demo data, not a rule: roles are assigned by
 * `k8s/curity/procedures/add-roles.js` and every verdict on the signed-in page
 * comes from a real exchange. `personas.test.ts` pins the roles here to that
 * procedure so the sheet cannot drift from what Curity actually issues. The
 * same sheet is documented in docs/curity-seed.md (§Accounts) for whoever
 * registers the accounts — names and emails are typed at registration.
 */
export type PersonaOutcome = 'success' | 'warning' | 'destructive';

export interface Persona {
  /** Curity username — also the `login_hint` the card's button sends. */
  username: 'alice' | 'bob' | 'carol';
  displayName: string;
  /** Who they are, in one line. */
  job: string;
  roles: string[];
  /** Short verdict, worn as a badge. */
  verdict: string;
  outcome: PersonaOutcome;
  /** What will happen, from their point of view. */
  story: string;
}

export const PERSONAS: readonly Persona[] = [
  {
    username: 'alice',
    displayName: 'Alice Andersson',
    job: 'SRE lead',
    roles: ['sre'],
    verdict: 'step-up, then every tool',
    outcome: 'success',
    story: 'Reads freely. Privileged actions require MFA after that the actions will go through.',
  },
  {
    username: 'bob',
    displayName: 'Bob Bergström',
    job: 'Backend developer',
    roles: ['developer'],
    verdict: 'ops:write refused',
    outcome: 'destructive',
    story: 'Reads freely but denied all privileged actions.',
  },
  {
    username: 'carol',
    displayName: 'Carol Carlsson',
    job: 'On-call engineer this week',
    roles: ['oncall'],
    verdict: 'one tool refused',
    outcome: 'warning',
    story:
      'Reads freely. Privileged actions are limited. Changing an image action is refused at the tool server.',
  },
];
