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
    story: 'Reads freely. Privileged actions ask for a TOTP code, then go through.',
  },
  {
    username: 'bob',
    displayName: 'Bob Bergström',
    job: 'Backend developer',
    roles: ['developer'],
    verdict: 'ops:write refused',
    outcome: 'destructive',
    story: 'Reads freely. Every privileged action is refused.',
  },
  {
    username: 'carol',
    displayName: 'Carol Carlsson',
    job: 'On-call engineer this week',
    roles: ['oncall'],
    verdict: 'one tool refused',
    outcome: 'warning',
    story:
      "Reads freely and may restart or scale. Changing a deployment's image is refused at the tool server.",
  },
];

/**
 * The persona behind a session label — a username (`alice`), an email
 * (`alice@demo.curity.local`) or a full name (`Alice Andersson`). The login
 * scope carries no `profile`, so what Curity sends as the user's name varies;
 * this lets the header draw the same person the landing card did.
 */
export function findPersona(label: string | undefined): Persona | undefined {
  if (!label) return undefined;
  const key = label.replace(/@.*/, '').trim().toLowerCase();
  return PERSONAS.find((p) => p.username === key || p.displayName.toLowerCase() === key);
}
