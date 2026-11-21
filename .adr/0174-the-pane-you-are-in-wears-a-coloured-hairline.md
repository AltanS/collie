# 0174: The pane you are in wears a coloured hairline

- **Status:** Accepted (2026-11-21)
- **Date:** 2026-11-21
- **Relates to:** [ADR 0120](./0120-on-a-large-screen-the-pane-screen-is-a-strip.md) (the strip and its focus),
  [ADR 0172](./0172-derived-state-colours-are-measured-and-collie-is-held.md) (the derived state colours).
- **Trail:** The pane-frame proposal round of 2026-11-21 (`ui/pane-frame`): five marks for the focused column of a
  row of panes on a large screen, drawn from the real components in two and three panes, the Terminal view and the
  four bundled themes. Altan picked option 4. Files: `web/src/components/strip-column.tsx`, `web/src/index.css`,
  `web/src/lib/theme/derive.ts`, `web/src/lib/theme/schema.ts`, `web/src/themes/collie.json`,
  `web/public/theme-init.js`, `web/e2e/wide-planes.spec.ts`, `web/e2e/strip-head.spec.ts`, `DESIGN.md` (§4, §14).

## Context

The focused column stood on the paper inside a 2px frame: the theme's `--pane-active` (Collie's ink) mixed 65% into
the page, clamped at L 0.55 in light. It was a grey ring a pixel from the keyboard focus ring, also 2px and grey,
so it read as a click's leftover focus. The clamp assumed which way a half goes: on a mid-grey page it fell to 2.1
to 2.66:1, and on a theme whose light half is dark it vanished (1.04:1; the themes set's `frame-on-mid-ground`).

## The options

1. **Today**, the 2px grey frame. Lost: it is the ring it should not be mistaken for.
2. **Quieter frame**, the same mix at 55% and 1px. Lost: still grey, so still a focus ring, only fainter.
3. **Accent line on top**, 2px of the "on" ink along the top edge. Lost: the Terminal view has no mark on the sides,
   and a top line reads as the tab bar's open tab.
4. **Colour frame**, a 1px hairline of the "on" ink mixed into the page. Picked.
5. **No frame, the others step back** (their ink muted). Lost: nothing marks the focus in the Terminal view, where
   every mirror is dark, and the dimmed panes read as disabled.

## Decision

1. **The focused column wears a 1px hairline in `--pane-active`, on the paper.** Every other column keeps a
   transparent 1px border on the page, so a focus change recolours and moves nothing. The Terminal view gets the
   same line. The width is `border-[1px]`, not `border`: the bare width follows a theme's `border` word (2px under
   `strong`, Nightwatch). The phone, the tablet and "Large-screen layout: Off" do not change.
2. **The token stays, and its value is the picked mix.** `--pane-active` is not retired and no second token is
   added: the frame reads one variable. In Collie's stylesheet it is `color-mix(in oklab,
   var(--control-on-foreground) 70%, var(--background))` in light and the same at 60% in dark. Mixed in OKLab, so
   the hue does not drift toward the page's own. `pane-active` joins `surface-recess` and `surface-paper` as a
   derived theme token: the file for `collie` holds no value, and a half that leaves it out takes the relation.
3. **It is a derived token with a floor.** `deriveTokens` makes it after the firm edge. The relation is a start
   colour mixed into the page by the half's share (70% light, 60% dark, in OKLab); the start is the theme's own
   `pane-active` when the half sets one, and `control-on-foreground` when it does not. Then the lightness is pushed
   away from the page until it holds 3:1 against the three grounds it touches, the recess at its left, the page at
   its right and the paper inside. A theme's own colour goes through the same mix, so the frame is as quiet in
   every theme: Altan asked for a subtler frame than the old one. The base tokens reach `deriveTokens` filled from
   the file for `collie`, which holds no `pane-active`, so a value there is always the theme's own.
   `DERIVE_VERSION` is 5. The reference test holds Collie's within 0.005 of the stylesheet: the distance is 0.0000
   in both halves.

## Measured

From the painted pixels at 1440x900 (`e2e/wide-planes.spec.ts`), against the recess, the page and the paper:

| half | recess | page | paper |
| --- | --- | --- | --- |
| Collie light | 4.27 | 4.98 | 5.67 |
| Collie dark | 5.60 | 5.29 | 4.70 |
| Daylight light | 4.79 | 5.57 | 5.81 |
| Daylight dark | 5.33 | 5.17 | 4.74 |
| Harbour light | 3.64 | 4.25 | 4.89 |
| Harbour dark | 5.21 | 4.75 | 4.20 |
| Nightwatch light | 3.11 | 3.63 | 4.22 |
| Nightwatch dark | 3.95 | 3.95 | 3.86 |

Nightwatch sets its own `pane-active` (amber); it goes through the mix. In dark the mix holds 3:1 as it is. In
light 70% of the amber into a near-white page is under 3:1 on the recess, and the floor darkens it. No other
bundled half needed the floor.

## Consequences

- The themes set's `frame-on-mid-ground` fell from 3 breaks to 0 and its waiver is gone; one `selected-fill-close`
  break on the mid-grey generated theme fell with it. No held Collie state moved: R5 holds the paper beside the
  frame, never the frame's own colour.
- The column's content starts a pixel higher (the frame is 1px where it was 2px).
- A theme's own `pane-active` is mixed 70% (light) or 60% (dark) into the page, where it used to be mixed 65%.
- The first frame never draws a theme's raw `pane-active`: `themes.css` (a shipped theme) and `theme-init.js` (an
  imported one) write it mixed into the page (`paneFrameMix`), with no floor, until the app sets the derived value.
- An export writes the theme's own start colour, never the derived frame, so an import mixes it once.
