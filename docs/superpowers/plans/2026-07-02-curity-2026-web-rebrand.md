# Curity 2026 Web Rebrand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `apps/web` from the 2023 light theme to Curity's 2026 brand refresh (dark navy→purple, single purple accent, Figtree, amber-for-step-up).

**Architecture:** The app uses the shadcn/ui token pattern — HSL CSS variables in `globals.css` surfaced as Tailwind colors in `tailwind.config.ts`. Flipping the token values recolors ~80% of the app; the rest is brand-utility rework (`.bg-app`, `.mesh-hero`, `.glass`, `.text-gradient`) plus a handful of hardcoded-color hand-fixes.

**Tech Stack:** Next.js (App Router), Tailwind CSS, shadcn/ui, `next/font/google`, class-variance-authority.

## Global Constraints

- **No light backgrounds; no palette mixing** — never leave a white/near-white surface or an old steel-grey/magenta value in place (2026 style guide, verbatim prohibition).
- **One accent, adapted:** purple (`#7B4FD4` / `#C084FC`) is the only interactive/emphasis accent. Semantic colors are used *only* for state: **amber `#F59E3A`** for step-up/MFA, green for success, red for denial/error. No decorative competing accents.
- **Font:** Figtree (Google Fonts, OFL) substitutes for the proprietary Google Sans as `--font-sans`. Mono stays Roboto Mono.
- **Token names must not change** — only their values. This keeps component class names stable.
- **CSS variables use bare `H S% L%`** (no `hsl(...)` wrapper), matching the existing file.
- **Verification gate for every code task:** `pnpm --filter web typecheck` must pass. Final task additionally runs `pnpm --filter web build` and a visual sweep. (There are no styling unit tests; this is a visual change — do not invent fake ones.)
- Do **not** touch the pre-existing uncommitted changes (`.gitignore`, `k8s/curity/configmap.yaml`).

## Brand color → HSL reference (used throughout)

| Name | Hex | `H S% L%` |
|---|---|---|
| Deep Navy (base) | `#0D0B1A` | `248 41% 7%` |
| Midnight (card) | `#130E2B` | `250 51% 11%` |
| Card fill (popover) | `#1C1440` | `251 53% 13%` |
| Purple mid (surface) | `#2D1B69` | `254 59% 26%` |
| Purple accent (primary) | `#7B4FD4` | `260 61% 57%` |
| Bright purple | `#C084FC` | `270 95% 75%` |
| Lilac (highlight) | `#C9A8FF` | `263 100% 83%` |
| Amber (warm/step-up) | `#F59E3A` | `32 90% 59%` |
| Body text | `#D4D8F0` | `231 48% 89%` |
| Muted grey | `#A5A5A5` | `0 0% 65%` |

## File Structure

- `apps/web/src/app/globals.css` — token values (`:root`) + brand utilities. **Primary leverage.**
- `apps/web/tailwind.config.ts` — add `warn` color mapping.
- `apps/web/src/app/layout.tsx` — Figtree font swap.
- `apps/web/src/components/app-shell.tsx` — header bg + hero heading accent.
- `apps/web/src/components/ui/alert.tsx` — dark-tune semantic variants.
- `apps/web/src/app/chat.tsx` — point step-up alert at the amber `warning` variant.
- `apps/web/src/components/copy-button.tsx` — copied-check color → token.
- `apps/web/src/components/inspect-view.tsx` — warning icon → token.

---

### Task 1: Flip design tokens + rework brand utilities

**Files:**
- Modify: `apps/web/src/app/globals.css` (whole `:root` block + utilities)
- Modify: `apps/web/tailwind.config.ts:39-49` (add `warn` color)

**Interfaces:**
- Produces: token values consumed by every component; new `--warn`/`--warn-foreground` variables and a `warn` Tailwind color (`warn`, `warn-foreground`) used by Task 4.

- [ ] **Step 1: Replace the `:root` block in `globals.css`**

Replace lines 5–46 (the comment + `@layer base { :root { … } }`) with:

```css
/* Curity 2026 brand palette (v2.1): dark-first — deep-navy base, purple-mid
   surfaces, single purple accent with lilac highlight, amber warm accent for
   step-up. Light text. Replaces the 2023 light theme. (curity.io / styleguide-2026) */
@layer base {
  :root {
    --background: 248 41% 7%; /* deep navy #0D0B1A */
    --foreground: 0 0% 100%; /* white headings; body uses /70–/80 */

    --card: 250 51% 11%; /* midnight #130E2B */
    --card-foreground: 0 0% 100%;

    --popover: 251 53% 13%; /* card fill #1C1440 */
    --popover-foreground: 0 0% 100%;

    --primary: 260 61% 57%; /* purple #7B4FD4 */
    --primary-foreground: 0 0% 100%;

    /* Brand accents — collapsed to the purple/lilac family (teal/magenta gone) */
    --accent-violet: 263 100% 83%; /* lilac #C9A8FF */
    --accent-cyan: 260 61% 57%; /* purple */
    --accent-fuchsia: 270 95% 75%; /* bright purple #C084FC */

    --secondary: 250 40% 16%; /* dark purple surface */
    --secondary-foreground: 231 30% 90%;

    --muted: 250 40% 16%;
    --muted-foreground: 231 20% 72%; /* readable lavender-grey */

    --accent: 254 45% 22%; /* purple tint for hover states */
    --accent-foreground: 263 100% 83%; /* lilac */

    --destructive: 0 72% 62%; /* bright red, legible on dark */
    --destructive-foreground: 0 0% 100%;

    --success: 142 60% 58%; /* green, legible on dark */
    --success-foreground: 240 30% 8%;

    --warn: 32 90% 59%; /* amber #F59E3A — step-up */
    --warn-foreground: 240 30% 8%;

    --border: 254 35% 22%; /* purple-tinted */
    --input: 254 35% 22%;
    --ring: 260 61% 57%;

    --radius: 0.5rem;
  }
}
```

- [ ] **Step 2: Rework the utility layer in `globals.css`**

Replace the entire `@layer utilities { … }` block (currently lines 63–126) with:

```css
@layer utilities {
  /* Page backdrop: deep-navy base with a purple radial aurora that brightens
     toward the top-right (per the 2026 guide). */
  .bg-app {
    background-color: hsl(248 41% 7%);
    background-image:
      radial-gradient(60rem 60rem at 100% -10%, hsl(260 61% 57% / 0.22), transparent 60%),
      radial-gradient(52rem 52rem at 0% 0%, hsl(254 59% 26% / 0.2), transparent 55%),
      radial-gradient(45rem 45rem at 50% 120%, hsl(270 95% 75% / 0.08), transparent 60%);
    background-attachment: fixed;
  }

  /* Subtle dotted grid overlay (low-alpha white reads on dark). */
  .bg-grid {
    background-image: radial-gradient(hsl(0 0% 100% / 0.08) 1px, transparent 1px);
    background-size: 26px 26px;
  }

  /* Brand icon/hero surface — purple-mid base with a lilac→purple aurora. */
  .mesh-hero {
    background-color: hsl(254 59% 26%);
    background-image:
      radial-gradient(40rem 30rem at -2% -10%, hsl(263 100% 83% / 0.35), transparent 58%),
      radial-gradient(36rem 30rem at 104% 4%, hsl(270 95% 75% / 0.55), transparent 54%),
      radial-gradient(42rem 36rem at 86% 116%, hsl(260 61% 57% / 0.75), transparent 62%),
      radial-gradient(34rem 30rem at 4% 122%, hsl(248 41% 12%), transparent 55%);
  }

  /* Frosted dark-purple cards: 1px purple-tinted border, soft shadow,
     hairline lilac top-light, and a subtle inner glow on hover. */
  .glass {
    background-color: hsl(251 53% 13% / 0.72);
    backdrop-filter: blur(12px);
    border: 1px solid hsl(254 40% 34% / 0.55);
    box-shadow:
      0 1px 2px hsl(248 60% 3% / 0.4),
      0 10px 30px -16px hsl(248 60% 3% / 0.7),
      inset 0 1px 0 hsl(263 100% 83% / 0.06);
    transition: box-shadow 0.2s ease;
  }
  .glass:hover {
    box-shadow:
      0 1px 2px hsl(248 60% 3% / 0.4),
      0 12px 34px -14px hsl(248 60% 3% / 0.75),
      inset 0 0 34px hsl(270 95% 75% / 0.08),
      inset 0 1px 0 hsl(263 100% 83% / 0.08);
  }
  .glass-strong {
    background-color: hsl(251 53% 13% / 0.85);
    backdrop-filter: blur(14px);
    border: 1px solid hsl(254 40% 38% / 0.6);
    box-shadow:
      0 14px 40px -16px hsl(248 60% 3% / 0.8),
      inset 0 1px 0 hsl(263 100% 83% / 0.08);
  }

  /* Gradient text for emphasis spans (lilac → bright purple). */
  .text-gradient {
    background-image: linear-gradient(100deg, hsl(263 100% 83%), hsl(270 95% 75%));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  /* Thin scrollbar for code blocks. */
  .scrollbar-thin::-webkit-scrollbar {
    height: 6px;
    width: 6px;
  }
  .scrollbar-thin::-webkit-scrollbar-thumb {
    background: hsl(0 0% 100% / 0.18);
    border-radius: 9999px;
  }
}
```

- [ ] **Step 3: Add the `warn` color in `tailwind.config.ts`**

In the `colors: { … }` object (after the `success` block at lines 35–38), add:

```ts
        warn: {
          DEFAULT: 'hsl(var(--warn))',
          foreground: 'hsl(var(--warn-foreground))',
        },
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS (no type errors; CSS is not typechecked but the config must stay valid TS).

- [ ] **Step 5: Commit**

```bash
cd /Users/suren/workspace/curity/ai-work/projects/ai-agents-auth-demo
git add apps/web/src/app/globals.css apps/web/tailwind.config.ts
git commit -m "feat(web): dark 2026 brand tokens + brand utilities

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Swap primary font to Figtree

**Files:**
- Modify: `apps/web/src/app/layout.tsx:3-11`

**Interfaces:**
- Consumes: nothing. Produces: `--font-sans` now bound to Figtree; `--font-mono` unchanged.

- [ ] **Step 1: Replace the font import + `sans` binding**

Change line 3 from:

```ts
import { Roboto, Roboto_Mono } from 'next/font/google';
```

to:

```ts
import { Figtree, Roboto_Mono } from 'next/font/google';
```

Then replace the `sans` declaration (lines 6–11):

```ts
const sans = Figtree({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});
```

Leave the `mono` (`Roboto_Mono`) block unchanged.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS. (If Figtree is misspelled, `next/font/google` throws a build-time error — the name is case-sensitive `Figtree`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/layout.tsx
git commit -m "feat(web): use Figtree as the Google Sans stand-in

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Fix app-shell hardcoded colors (header + hero accent)

**Files:**
- Modify: `apps/web/src/components/app-shell.tsx:33` (header background)
- Modify: `apps/web/src/components/app-shell.tsx:77-79` (hero heading accent gradient)

**Interfaces:**
- Consumes: `--background` token + `.mesh-hero` from Task 1. Produces: nothing downstream.

> Note: the rest of app-shell's `text-white`/`bg-white/xx`/`border-white/xx` occurrences sit **on the `.mesh-hero` purple hero** and are correct on dark — do not change them. Only the two spots below are wrong.

- [ ] **Step 1: Dark-tune the sticky header**

Change line 33 from:

```tsx
      <header className="sticky top-0 z-40 border-b border-border bg-white/80 backdrop-blur-xl supports-[backdrop-filter]:bg-white/70">
```

to:

```tsx
      <header className="sticky top-0 z-40 border-b border-border bg-background/70 backdrop-blur-xl supports-[backdrop-filter]:bg-background/60">
```

- [ ] **Step 2: Recolor the hero heading accent span**

Change lines 77–79 from:

```tsx
                <span className="bg-gradient-to-r from-pink-200 via-fuchsia-200 to-purple-200 bg-clip-text text-transparent">
                  demonstrated.
                </span>
```

to:

```tsx
                <span className="bg-gradient-to-r from-[#C9A8FF] to-[#E9DEFF] bg-clip-text text-transparent">
                  demonstrated.
                </span>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/app-shell.tsx
git commit -m "feat(web): dark header + lilac hero accent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Dark-tune semantic status colors

**Files:**
- Modify: `apps/web/src/components/ui/alert.tsx:11-16` (variants)
- Modify: `apps/web/src/app/chat.tsx:346` (step-up alert → `warning`)
- Modify: `apps/web/src/components/copy-button.tsx:25` (copied check)
- Modify: `apps/web/src/components/inspect-view.tsx:104` (warning icon)

**Interfaces:**
- Consumes: `warn` Tailwind color + `success`/`destructive`/`accent` tokens from Task 1.

- [ ] **Step 1: Rewrite the alert variants for dark**

Replace the `variant` object in `alertVariants` (lines 11–16) with:

```tsx
        default: 'bg-card text-card-foreground [&>svg]:text-foreground',
        destructive:
          'border-destructive/40 bg-destructive/10 text-destructive [&>svg]:text-destructive',
        warning:
          'border-warn/40 bg-warn/10 text-warn [&>svg]:text-warn',
        info: 'border-primary/40 bg-accent text-accent-foreground [&>svg]:text-accent-foreground',
```

- [ ] **Step 2: Point the step-up alert at the amber `warning` variant**

In `chat.tsx`, change line 346 from:

```tsx
        <Alert variant="info">
```

to:

```tsx
        <Alert variant="warning">
```

(Leave the error `Alert variant="destructive"` blocks unchanged.)

- [ ] **Step 3: Token-ize the copied-check color**

In `copy-button.tsx`, change line 25 from:

```tsx
      {copied ? <Check className="text-emerald-600" /> : <Copy />}
```

to:

```tsx
      {copied ? <Check className="text-success" /> : <Copy />}
```

- [ ] **Step 4: Token-ize the inspect warning icon**

In `inspect-view.tsx`, change line 104 from:

```tsx
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
```

to:

```tsx
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter web typecheck`
Expected: PASS. (`text-warn`/`text-success` resolve because `warn` was added to Tailwind in Task 1 and `success` already exists.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/ui/alert.tsx apps/web/src/app/chat.tsx apps/web/src/components/copy-button.tsx apps/web/src/components/inspect-view.tsx
git commit -m "feat(web): dark-tune status colors; amber step-up

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Full build + visual verification

**Files:** none (verification only).

- [ ] **Step 1: Production build**

Run: `pnpm --filter web build`
Expected: build succeeds; no unresolved Tailwind classes, no font errors.

- [ ] **Step 2: Typecheck the whole workspace touchpoint**

Run: `pnpm --filter web typecheck`
Expected: PASS.

- [ ] **Step 3: Visual sweep (signed-out shell)**

Start the app locally: `pnpm --filter web dev` (or use the deployed `https://app.localtest.me` if the cluster is up). With Chrome DevTools MCP, load the home page signed-out and confirm:
- Page background is deep navy with the purple top-right aurora — **no white surfaces**.
- Header is dark glass; hero is the purple `.mesh-hero`; "demonstrated." accent is lilac.
- Sign-in card is a frosted dark-purple `.glass` card; body text is legible (light on dark).
- Font is Figtree (geometric sans, not Roboto).

- [ ] **Step 4: Visual sweep (signed-in, if cluster available)**

If `https://app.localtest.me` is reachable with a session, verify: chat card, result tabs (Answer/Identity/Trace), the **step-up alert is amber**, success badges/scopes are green, error alerts are red, workload-identity cards + OBO chain nodes render on dark with purple `.mesh-hero` number badges, and `/inspect` matches. Confirm one-accent discipline (purple interactive; amber only on step-up).

- [ ] **Step 5: Final commit (only if any fixes were needed during verification)**

```bash
git add -A apps/web
git commit -m "fix(web): visual-verification adjustments for 2026 rebrand

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Dark tokens (spec §4.1) → Task 1. ✓
- Tailwind `warn` (§4.2) → Task 1 Step 3. ✓
- Figtree (§4.3) → Task 2. ✓
- Hardcoded fixes (§4.4): app-shell → Task 3; alert + chat step-up + copy-button + inspect-view → Task 4. ✓
- Adapted One-Accent Rule (§Decisions 4): amber step-up wired in Task 4 Steps 1–2; semantic green/red in Task 1 tokens + Task 4. ✓
- Scope = all user-facing routes (§5): home/chat/sign-in inherit tokens + app-shell/chat fixes; `/inspect` via inspect-view fix + tokens; shared `ui/*` via tokens. `/preview` inherits tokens (not hand-audited, per spec). ✓
- Verification (§6) → Task 5. ✓
- Git branch (§7) → already created (`feat/curity-2026-rebrand`); spec committed. ✓

**Placeholder scan:** none — every code step shows exact before/after.

**Type consistency:** token names unchanged; new `warn`/`warn-foreground` defined in Task 1 and consumed as `text-warn`/`border-warn`/`bg-warn` in Task 4; `variant="warning"` already exists in `alertVariants` and is now correctly dark-styled. ✓

**Note on `.mesh-hero` white text:** intentionally preserved in app-shell/chat/inspect — white glyphs on the purple hero are correct; only true light-on-light spots were changed.
