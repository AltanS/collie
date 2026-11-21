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
   - the ring 3:1 on the page, card, recess, paper, band, muted fill and each plane's hover and selected fill;
   - the foreground and the muted ink keep 4.5:1 on a plane and on a fill, or what they have on the page when the
     theme gives less, and a plane stays on the page's side of the ink;
   - a plane 0.025 off its neighbour. Collie's own steps are 0.045 to 0.06;
   - the firm edge (`--edge-firm`, ADR 0171) 3:1 on the recess, the page and the paper;
   - the frame of the pane you are in (`--pane-active`, ADR 0174) 3:1 on the recess, the page and the paper.
2. **Collie is the reference.** `derive.test.ts` puts Collie's base tokens through the function. They are read
   from `src/themes/collie.json`, which `src/themes/themes.test.ts` holds equal to `index.css`'s `:root`, token by
   token; the relations `derive.ts` mirrors are held to `index.css`'s own lines in `derive.test.ts`, so the
   stylesheet cannot move alone. Every derived token must come out as Collie paints it, within 0.005 in OKLab, in
   both halves. The worst is 0.0021, the dark recess. The themes set holds the state colours Collie painted on
   2026-11-21 (`collie-states.json`), within 0.02. `derive.golden.test.ts` holds the output for both halves of the
   four bundled looks as one snapshot, so any drift shows as a diff, and a change to it bumps `DERIVE_VERSION`.
3. **It runs in `applyTheme`, for every theme applied.** The three other shipped themes are included. The result
   is one `light-dark()` per derived token, set inline after the base tokens. A theme's own `ring`, `surface-recess`
   or `surface-paper` is a start, and the floor may move it. A theme file gains no field. Collie applies no theme:
   its stylesheet holds the same relations, and the reference test holds the two together. A derivation that fails
   (a value it cannot read) sets no derived token, logs one warning and applies the rest of the theme.
   `applyTheme` stores the result, keyed by the theme id, a hash of its halves and `DERIVE_VERSION`; `theme-init.js`
   sets that copy before the first paint and derives nothing itself. A stale copy is ignored.
4. **The classes read variables.** `--state-hover`, `--state-on` and `--state-open` are pointed at a plane's triple
   by `RECESS_ACCENT`, `PAPER_PLANE` and `PAGE_PLANE`, and the root holds the page's. A plane points `--accent` at
   its `--state-on` too. `HOVER_FILL`, `TRIGGER_OPEN`, the ghost and outline buttons and the pane row read them.
5. **A re-pointed accent takes its ink** (`--accent-foreground` to `--foreground` on the recess), and **every
   focusable row wears the house ring** (`FOCUS_RING`).
6. **A theme whose own text is under 4.5:1 is warned about and applied as it is** (Altan, 2026-11-21: "we warn,
   that's it"). No adjustment at load, no refusal: the contrast report warns, and the theme's own inks stay. The
   derived state colours work from those inks, so `deriveReport` can name floors that cannot be met, and that is
   accepted.

## Not decided here

- The field edge. The frame of the pane you are in is ADR 0174.
- A per-theme "use my colours exactly" switch, and an app note when a floor moved a colour.
- The sites that still draw a state with their own class (`hover:bg-muted/60`, `bg-accent`, `bg-control-on`):
  DESIGN.md §14 says to read the variables; the sweep is the next part.

## Consequences

- Where a site reads the variables, a theme, imported or shipped, gets a hover, a selection, an open trigger off
  its ground and a ring at 3:1, with no word in its file. Not every site does yet: about 80 class lines in 55 files
  still draw a state with their own class (`hover:bg-muted/60`, `bg-accent`, `bg-control-on`), and there the
  stylesheet's relation holds with no floor.
- It is best effort where floors fight. A ring can be 3:1 on every ground only when such a lightness exists; a
  plane can keep its gap only while the inks still read on it. `deriveReport` says which floors were not met (the
  token, the floor, the value reached) and how the planes ended; `derive.test.ts` pins the counts. Over the three
  other bundled looks and the 24 generated themes on 2026-11-21: 10 of 27 looks miss a floor somewhere, none
  misses the ring floor, 2 have a light recess lighter than the page, and 5 have planes that sit on each other.
- Nightwatch, Daylight and Harbour change look, and so does every installed theme: their state colours, planes,
  ring and firm edge are now the derived ones.
- The state variables (`--state-hover-<plane>` and the rest) are internal names, not a contract for a theme file. A
  theme that sets one is not supported, and the names may change.
- Collie paints as before. A change to its stylesheet's relations that is not made in `derive.ts` too fails the
  reference test.
- On a device's first visit with a theme, before the app has stored a copy, the first frame shows the stylesheet's
  relations with no floor until React applies the theme.
