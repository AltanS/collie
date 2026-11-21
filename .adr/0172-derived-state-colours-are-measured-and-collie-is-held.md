# 0172: One function derives a theme's state colours, and Collie is its reference

- **Status:** Accepted (2026-11-21)
- **Date:** 2026-11-21
- **Trail:** The theme rules round of 2026-11-21 (`ui/theme-rules`). Step 1 added the themes set: R5 `contrast`
  read from painted pixels in the eight bundled looks and 24 generated themes (`web/e2e/themes/`). It found
  527 breaks in the bundled looks and 1407 in the generated ones. Nine generated themes pass the contrast report
  and still break 16 to 28 times each, so the breaks come from the colours the app derives, not from the theme
  file. A first try with CSS state layers (the ink at 8% and 12% over the ground) kept only 9 of 72 of Collie's
  approved hovers and none of its 5 open triggers within 0.02. Files: `web/src/lib/theme/derive.ts`,
  `derive.test.ts`, `store.ts`, `web/src/index.css`, `components/ui/button.tsx`, `components/ui/nav-edge.ts`,
  `components/strip-column.tsx`, `components/agent-sidebar.tsx`, `actions-palette.tsx`, `wide-layout.tsx`,
  `settings-shell.tsx`, `app-header.tsx`, `web/e2e/themes/states.ts`.

## Context

A theme sets its base colours. The app makes the rest: the recess and the paper, the hover fill, the chosen row,
the open trigger, the focus ring. Each was tuned on Collie and assumed on the others. The contrast report checks
a theme's tokens on `background` and `card`, never a derived colour on a derived ground.

Altan looked at the Collie theme on 2026-11-21 and said its hover states, focus rings and planes are right.
Those states are not "ink on a ground": in Collie light a row on the recess hovers and selects up to the paper,
and "open" is the sky tint of `--control-on`. An ink layer can only darken a light ground and is grey. And CSS
cannot hold one token against another: relative colour reads one colour at a time.

## Decision

1. **One pure function, `deriveTokens(base, half)`, makes every state colour from a theme half's base tokens.** Each
   value is Collie's relation first (the expression Collie's stylesheet uses), then a floor: the lightness moves on
   in the direction the relation took until the value meets its floor, and the other way when that direction runs
   out of range. Hue and chroma stay. The floors:
   - a hover 0.04 in OKLab off its ground; a selected and an open fill 0.06;
   - the ring 3:1 on the page, card, recess, paper, band and muted fill;
   - the foreground and the muted ink keep 4.5:1 on a plane and on a fill, or what they have on the page when the
     theme gives less, and a plane stays on the page's side of the ink;
   - a plane 0.025 off its neighbour. Collie's own steps are 0.045 to 0.06.
2. **Collie is the reference.** `derive.test.ts` puts Collie's base tokens through the function. Every derived
   token must come out as Collie paints it, within 0.02 in OKLab, in both halves. The worst is 0.0021, the dark
   recess. The themes set holds the 241 state colours Collie painted on 2026-11-21, within 0.02.
3. **It runs in `applyTheme`, for every theme applied.** The three other shipped themes are included. The result
   is one `light-dark()` per derived token, set inline after the base tokens. A theme's own `ring`, `surface-recess`
   or `surface-paper` is where the floor starts, and the floor still applies. A theme file gains no field. Collie
   applies no theme: its stylesheet holds the same relations, and the reference test holds the two together.
4. **The classes read variables.** `--state-hover`, `--state-on` and `--state-open` are pointed at a plane's triple
   by `RECESS_ACCENT`, `PAPER_PLANE` and `PAGE_PLANE`, and the root holds the page's. A plane points `--accent` at
   its `--state-on` too. `HOVER_FILL`, `TRIGGER_OPEN`, the ghost and outline buttons and the pane row read them.
5. **A re-pointed accent takes its ink** (`--accent-foreground` to `--foreground` on the recess), and **every
   focusable row wears the house ring** (`FOCUS_RING`).

## Not decided here

- A floor on a theme's own text (the schema question). It would be one more step before the planes.
- The field edge, the focus frame and `--edge-firm`: the next part of this round.
- The sites that still draw a state with their own class (`hover:bg-muted/60`, `bg-accent`, `bg-control-on`):
  DESIGN.md §14 says to read the variables; the sweep is the next part.

## Consequences

- Every theme, imported or shipped, gets a visible hover, a visible selection, an open trigger off its ground and a
  ring at 3:1, with no word in its file.
- Collie paints as before. A change to its stylesheet's relations that is not made in `derive.ts` too fails the
  reference test.
- The derived tokens are set when React applies the theme, not by `theme-init.js`. Until then the stylesheet's
  relations hold: Collie's, from the theme's own base tokens, with no floor.
