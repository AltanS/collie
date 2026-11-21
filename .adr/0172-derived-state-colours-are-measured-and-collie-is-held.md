# 0172: Derived state colours are measured on every theme, and Collie's are held

- **Status:** Accepted in part (2026-11-21): D4 and D6 are in force; D2, D3, D5 and D10 wait for a decision
- **Date:** 2026-11-21
- **Trail:** The theme rules round of 2026-11-21 (`ui/theme-rules`). Step 1 added the themes set: R5 `contrast`
  read from painted pixels in the eight bundled looks and 24 generated themes (`web/e2e/themes/`). It found
  527 breaks in the bundled looks and 1407 in the generated ones. Nine generated themes pass the contrast report
  and still break 16 to 28 times each, so the breaks come from the colours the app derives, not from the theme
  file. Files: `web/src/components/ui/nav-edge.ts`, `agent-sidebar.tsx`, `actions-palette.tsx`,
  `wide-layout.tsx`, `settings-shell.tsx`, `app-header.tsx`, `web/e2e/themes/states.ts`.

## Context

A theme sets 43 colours. The app makes the rest: the hover fill, the chosen row, the open trigger, the focus
ring, the recess and the paper. Each was tuned on Collie and assumed on the others. The contrast report checks
the theme's tokens on `background` and `card`, never a derived colour on a derived ground.

Altan looked at the Collie theme on 2026-11-21 and said its hover states, focus rings and planes are right.

## Decision

1. **Every derived state colour is measured, on every look, from painted pixels.** The floors are in DESIGN.md
   §14. A break that is not fixed yet is waived by cause with a count per case that only goes down
   (`ceilings.json`).
2. **Collie is held.** The 241 state colours that passed in Collie light and dark on 2026-11-21 are kept in
   `collie-states.json`. A change that moves one by more than 0.02 in OKLab fails the set.
3. **D4: an accent re-pointed on a plane takes its ink with it.** `RECESS_ACCENT` sets `--accent` to the paper
   and `--accent-foreground` to `--foreground`, on the sidebar, the Settings list and the dashboard header.
4. **D6: the house ring on every focusable row.** The pane rows wear `FOCUS_RING`. The palette puts it on the
   row its wrapper holds, outside the keyboard highlight.

## Not decided here

- **D2 and D3, one ink layer for hover, selected and open.** Measured against the held states, an 8% ink hover
  keeps 9 of 72 within 0.02 (worst 0.157), and a 12% layer keeps 14 of 30 selected rows and 0 of 5 open
  triggers. In Collie light the recess's rows hover and select up to the paper, and the open look is a sky
  tint; an ink layer darkens and is grey. Adopting it means a new look for Collie, which is Altan's to see.
- **D5 and D10, clamps.** A ring held to 3:1 on several grounds, or a recess held so the muted ink keeps
  4.5:1, needs the lightness of two tokens in one expression. CSS relative colour reads one colour. The clamp
  can be made where a theme is applied (`lib/theme/store.ts`, `applyTheme`), which leaves Collie as it is.
  That is the same place as the schema question (a theme whose own text is under 4.5:1).

## Consequences

- A theme that sets a dark accent on a light page keeps the chosen row's words readable.
- A keyboard focus on a pane row or a palette row shows the same ring as every other control.
- 4 low-contrast and mid-grey generated themes gain one `theme-ink-low` break in two entries each: the chosen
  row now shows their own foreground, which is under 4.5:1. Their accent ink had hidden it on that one row.
