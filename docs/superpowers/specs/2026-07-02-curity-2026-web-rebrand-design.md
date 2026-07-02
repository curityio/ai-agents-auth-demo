# Curity 2026 Rebrand — Web App

**Date:** 2026-07-02
**Branch:** `feat/curity-2026-rebrand`
**Scope:** `apps/web` (the Next.js BFF served at `https://app.localtest.me`)

## Goal

Restyle the web app to match Curity's **2026 brand refresh (v2.1)**. The current
app uses the *2023* visual language — white pages, navy headings, magenta-pink
spot accent, teal, Roboto. The 2026 brand is a near-total inversion: dark
navy→purple surfaces, a single purple accent, light text, and Google Sans.

Authoritative sources: `curity-styleguide-2026.pdf` and
`Curity_Brand_Template-2026.pptx` (both provided out-of-band, not committed).

## Brand facts (2026 v2.1)

**Palette**

| Role | Hex |
|---|---|
| Base background | `#0D0B1A` (Deep Navy) / `#0B0818` (template) |
| Background / midnight | `#130E2B` |
| Surface / purple mid | `#2D1B69` |
| Card fill | `#1C1440` |
| Primary accent (purple) | `#7B4FD4` · `#C084FC` (template highlight) |
| Highlight (lilac) | `#C9A8FF` |
| Warm accent (amber) | `#F59E3A` |
| Body text | `#D4D8F0` / white-70% |
| Heading | `#FFFFFF` |
| Muted | `#A5A5A5` |

**Typography** — Google Sans throughout (Light 300 display, 600 subheads, 400
body, Medium tracked 0.08em UI labels, mono for code). Section labels: 11px, 600,
tracked 0.14em, uppercase, purple-light. Hero: light-weight white title + lilac
accent line.

**Visual language** — dark-first, radial navy→purple gradient (intensity toward
top-right), frosted dark-purple cards with 1px purple-tinted border + 8px radius
and subtle inner glow on hover, purple-tinted low-opacity geometric/diamond
motifs, amber dot as sparing focal accent.

**Explicit prohibitions** — no light/white backgrounds; no mixing the old
steel-grey/magenta palette with the new purple system.

**One Accent Rule** — one purple highlight per view; everything else white or
`#D4D8F0`. (Adapted for an interactive app — see Decisions.)

## Decisions (resolved with user)

1. **Font:** Google Sans is proprietary and cannot be legally embedded in a web
   app. Substitute **Figtree** (Google Fonts, OFL) as `--font-sans` — closest
   free geometric-humanist match. Mono stays a code face (Roboto Mono / JetBrains
   Mono).
2. **Scope:** all user-facing routes — home/chat, sign-in, `/inspect`,
   header/footer, and shared `ui/*` components. `/preview` inherits the token
   flip but is not hand-audited.
3. **Logo:** keep the existing `ShieldCheck` glyph, restyled into the purple-glass
   icon-badge treatment (no external asset fetched).
4. **One Accent Rule, adapted:** purple is the brand/interactive accent
   (buttons, links, focus, emphasis, icon-badge gradient). Semantic colors are
   reserved strictly for *state*, retuned for dark: **amber `#F59E3A`** for
   step-up/MFA (this is the brand's own warm accent), green for success, red for
   denial/error. This keeps status legible without violating the spirit of the
   rule (no decorative competing accents).

## Architecture of the change

The app follows the shadcn/ui token pattern: colors flow through HSL CSS
variables in `globals.css`, surfaced as Tailwind color utilities via
`tailwind.config.ts`. Flipping the token values recolors ~80% of the app for
free. The remaining work is (a) reworking the brand utility classes and (b)
hand-fixing the ~27 spots that hardcode palette colors.

### 4.1 Tokens — `apps/web/src/app/globals.css`

Rewrite the `:root` HSL variables from light→dark:

- `--background` → Deep Navy `#0D0B1A`
- `--card`, `--popover` → Midnight / card fill (`#130E2B` / `#1C1440`)
- `--foreground`, `*-foreground` → white / `#D4D8F0`
- `--primary` → Purple `#7B4FD4`; `--ring` → purple; hover leans Lilac `#C9A8FF`
- `--secondary`, `--muted` → purple-tinted dark surfaces; muted-foreground `#A5A5A5`
- `--accent`, `--accent-foreground` → purple tint on dark
- `--accent-violet`/`--accent-cyan`/`--accent-fuchsia` → collapse to the
  purple/lilac family (kill teal/magenta)
- `--border`, `--input` → purple-tinted (`~#2D1B69`) at low alpha
- `--success` / `--destructive` → dark-tuned green / red
- add `--warn` (amber `#F59E3A`) for step-up

Rework utilities in place:
- `.bg-app` — dark navy base with a purple radial gradient brightening toward
  top-right (per the guide), replacing the near-white tinted backdrop.
- `.mesh-hero` — purple→lilac glass (already dark; retune to brand purples).
- `.glass` / `.glass-strong` — frosted **dark-purple** cards, 1px purple-tinted
  border, subtle inner glow on hover.
- `.text-gradient` — purple→lilac.
- `.bg-grid` — keep (white dots at low alpha read correctly on dark).

Update the leading comment block (currently describes the 2023 light palette).

### 4.2 Tailwind — `apps/web/tailwind.config.ts`

Add a `warn` color mapping (`hsl(var(--warn))`) alongside `success`/`destructive`.
Keep `darkMode: ['class']`. The token names stay the same, so component class
names don't churn.

### 4.3 Typography — `apps/web/src/app/layout.tsx`

Replace `Roboto` → `Figtree` from `next/font/google` (weights 300,400,500,600,700)
bound to `--font-sans`. Keep the mono variable. Body already applies `font-sans`.

### 4.4 Hardcoded-color hand-fixes

Concentrations (from grep of palette-literal classes):

- **`components/app-shell.tsx` (15)** — header `bg-white/80` → dark glass;
  hero heading gradient `from-pink-200 via-fuchsia-200 to-purple-200` →
  lilac/white; capability chips; footer. Shield icon-badge → purple-glass.
- **`components/ui/alert.tsx` (4)** — dark-tune `destructive`/`success`/`info`
  variants; map `info` (step-up) to amber `--warn`.
- **`app/chat.tsx` (4)** — remaining `text-white` on `.mesh-hero` badges stay
  white (correct on dark); audit `bg-secondary/*` surfaces read well.
- **`components/inspect-view.tsx`, `components/copy-button.tsx`, `app/page.tsx`,
  `app/inspect/page.tsx` (1 each)** — status/emphasis literals.

`.mesh-hero` icon badges (chat cards, OBO chain nodes) keep white glyphs — already
correct on dark.

## Testing / verification

- `pnpm --filter web build` and `pnpm --filter web typecheck` must pass.
- No styling unit tests exist; this is a visual change. Verify by running the app
  and inspecting each route (home signed-out, home signed-in/chat, result tabs,
  step-up alert, workload identities, OBO chain, `/inspect`) with Chrome DevTools
  MCP: confirm no light-background leftovers, adequate contrast (WCAG AA on body
  text), and one-accent discipline (purple interactive, amber only for step-up).

## Out of scope

- Other apps/services (agents, MCP servers, APIs) — no user-facing UI.
- Fetching/embedding official Curity logo assets.
- `/preview` hand-audit (inherits tokens only).
- The uncommitted `.gitignore` / `k8s/curity/configmap.yaml` changes present on
  the branch — left untouched.
