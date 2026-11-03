# Collie New: palette notes

The reasoning behind `collie-new.json` (JSON has no comments). Collie New is Collie, bolder and
easier to read. It is still black and white like the dog mark, with neutral greys, but every
pair that carries text or an edge is held well above what `collie` measures, the face is Atkinson
Hyperlegible Next, and the shape is the one people found easy in Harbour: soft corners, roomy
steps, cards for rows. The review that started it is `experiments/theme-readability-2026-11-03/FINDINGS.md`
(findings 4 and 6 to 10 are the ones a theme can fix). `collie` itself is untouched, byte for byte.

Measured with `contrastReport` from `lib/theme/schema.ts` (plain sRGB alpha, the pessimistic side of
the browser's mix) and the same arithmetic for the rows the gate does not cover: chips on the band,
syntax and host inks on the added and deleted row tints, and the terminal palette before and after
the light-mode inversion. The report passes all 58 checks in both halves.

## Surfaces

- One neutral key for both halves: chroma 0 on inks, at most 0.004 at hue 80 (a warm hint, no blue
  cast) on every surface. Nothing here reads as tinted.
- Light `background` is oklch(0.955 0.003 80) (#f1f0ee). `collie` is 0.97; that leaves a white card
  1.09 above the page, which the review called too close. At 0.955 the card, pure white, stands
  1.14 above it. `chrome`, `secondary` and `muted` sit a step below the page at 0.915 (#e4e3e0,
  1.13 below the page), `accent` at 0.885 for the pressed state, so rest, hover and active stay three
  values.
- Dark `background` is oklch(0.17 0.003 80) (#100f0e), `card` 0.235 (1.15 above), `secondary`,
  `muted` and the band 0.28 (1.32 above the page), `accent` 0.32. `chrome` follows the band.
- Inks: light `foreground` oklch(0.14 0 0), dark oklch(0.985 0 0). The page is further from white
  than `collie`'s, so text on the page is 17.48 (light) against `collie`'s 18.16, and on a card
  19.91 against 19.80. Dark is 18.35 on the page against 18.97, and 15.96 on a card against 17.2.
  All far over AAA; the card is where text sits.
- `muted-foreground` is oklch(0.40 0.004 80) light and oklch(0.80 0.004 80) dark: 8.12 and 10.22 on
  the page (`collie` 6.04 and 7.66), and 7.21 and 7.76 on the band, so quiet text is AAA on every
  surface it can stand on. The review's finding 4 (the composer belt at 3.98) and finding 7 (the faded
  muted ink) start from this value.
- The band is `chrome: band`, which paints the header and the two bars with `secondary` and a
  `border` edge. Foreground, muted-foreground, blocked and every chip are measured on it below.

## Lines and focus

- `border` is opaque grey, not white at an alpha, so the number is the paint. Light oklch(0.82 0.004
  80): 1.74 on a card (`collie` 1.26). Dark oklch(0.42 0.003 80): 1.97 on a card (`collie` 1.42).
- `input` is the edge of a field, held at 3:1 (WCAG 1.4.11). Light oklch(0.64 0.004 80): 3.36 on a
  card, 2.95 on the page. Dark oklch(0.58 0.003 80): 3.88 on a card, 4.47 on the page. `collie` is
  1.26 and 1.58.
- `rule` is stronger than `border` in both halves: light 2.18 on the page against 1.53, dark 3.49
  against 2.27. It is the line that matters (a divider, a dashed ring); `collie`'s is 1.33 and 2.06.
- `border: strong` draws every bare `border` and `divide-*` at 2px, so the 1.74 edge is also twice as
  wide. Cards read as cards without a shadow, and the `lifted` shadow only adds depth.
- `ring` is oklch(0.5 0 0) light (5.28 on the page) and oklch(0.76 0 0) dark (8.93).
- `pane-active` is not set, so the frame of the active pane column keeps the `:root` pair, as in
  Harbour. The file is version 2.

## The one accent

- `primary` is neutral: light oklch(0.2 0 0) under oklch(0.985 0 0) (17.34), dark oklch(0.96 0 0)
  under the page colour (17.10). It is the dog's black and white. The only colour on a surface is
  `control-on`, a pale sky tint as in `collie` (light oklch(0.88 0.06 235), its ink 8.70; dark
  oklch(0.34 0.06 240), its ink 9.21).
- `destructive` stays red. Light oklch(0.5 0.21 27) under near-white (6.30 for the filled button),
  5.77 as text on the page, 6.57 on a card, 5.12 on the band. Dark oklch(0.72 0.19 22) under the
  page colour (6.83), 5.94 on a card, 5.19 on the band. `collie`'s dark filled button is near white on
  light red (2.77, the one known failure of its own report); this one does not carry it.

## Status

`collie`'s hues (blocked 25, working 72, done 152, idle and unknown 250, info 230). Light inks are 0.01
to 0.04 darker than `collie`'s (blocked 0.43, working 0.43, done 0.41, idle 0.42, unknown 0.38, info
0.42), dark inks 0.01 to 0.1 lighter or less saturated where the band needs it (blocked
oklch(0.8 0.15 24)). Chip = ink over the ink at /15 over the ground.

| chip on          | blocked | working | done | idle | unknown | info |
| ---------------- | ------- | ------- | ---- | ---- | ------- | ---- |
| light background | 5.45    | 5.75    | 5.54 | 5.92 | 6.89    | 5.35 |
| light card       | 6.17    | 6.46    | 6.27 | 6.65 | 7.80    | 6.05 |
| light band       | 4.87    | 5.15    | 4.96 | 5.30 | 6.17    | 4.79 |
| dark background  | 7.01    | 8.58    | 7.60 | 7.36 | 6.75    | 8.34 |
| dark card        | 5.86    | 7.19    | 6.34 | 6.13 | 5.65    | 7.03 |
| dark band        | 5.12    | 6.20    | 5.53 | 5.29 | 4.91    | 6.06 |

- Tightest cells: light info on the band (4.79), dark unknown on the band (4.91). Darken the light
  inks and lighten the dark ones if either moves; never the reverse.
- Blocked and done are far apart in oklab, as in `collie` (floor 0.15).
- Idle and unknown keep `collie`'s pair rule: same hue, chroma 0.02 to 0.03, unknown below idle.

## Syntax and hosts

The hues are `collie`'s (keyword 350, string 250, constant 55, property 200, entity 300, comment
neutral; hosts 221, 41, 302, 132, 352, 185, 262, 325, 241, 280). Only the lightness moved.

- Light syntax inks sit at 0.43 to 0.46 (`collie` 0.45 to 0.5). On a card 7.11 to 8.13, on the page
  6.24 to 7.14, on the band 5.54 to 6.34, on a row tinted by done or blocked at /12 (over a card or
  the page) at least 4.97. Lowest cell: the comment ink, oklch(0.46 0.004 80), on a row tinted over
  the page (4.97).
- Light hosts sit at 0.45 (`collie` 0.46), 7.06 to 8.38 on a card, lowest 4.94 (host 5 on a tinted row over the page).
- Dark syntax inks sit at 0.78 to 0.82, 7.19 to 9.91 on a card, lowest 5.73 (comment on an added row).
- Dark hosts keep `collie`'s lightness except two: host 2 (purple) moved from 0.714 to 0.74 and
  host 9 (indigo) from 0.673 to 0.70 with less chroma, so each clears 4.5 on the band and on a tinted
  row. 5.83 to 10.85 on a card, lowest 4.64 (host 9 on a deleted row).

## Face and shape

Atkinson Hyperlegible Next for the text (key `atkinson`, real weights 400 to 700, so `bold` is drawn
and not synthesised). Aldrich stays as the display face: h1, h2 and the brand line keep the voice of
the default. Aldrich has one weight and is 13 percent wider than the system face (review finding 10),
which is why it leaves the rows and the meta text.

| token   | word     | why                                                                         |
| ------- | -------- | --------------------------------------------------------------------------- |
| radius  | soft     | Takes the edge off without turning a control into a pill; a marked row wears a ring. |
| shadow  | lifted   | Cards stand off the page without a hard line; the border carries the edge.   |
| density | roomy    | The step is 0.28rem, 12 percent more air; icons and the dog stay pinned.     |
| weight  | bold     | Medium is 600 and semibold 700, which Atkinson draws for real.                |
| border  | strong   | A 2px edge in a 1.74 grey; the strongest word the table has.                 |
| ground  | flat     | The page stays one plain colour; no texture under the text.                   |
| chrome  | band     | Header and bars on `secondary`, with a `border` edge: a step from the page.   |
| rows    | cards    | Every row its own card and edge, with a gap; no frame of lines.               |
| icons   | default  | A stroke of 2 (the table has thin, default and heavy; heavy would be loud).   |
| labels  | sentence | No small capitals and no tracking; section labels read as words.              |

Every word exists in `surface.ts`. Nothing was approximated.

Roomy density at 360 and 412 wide is checked on the dashboard, the pane and Settings with this theme
picked (no horizontal overflow). `web/e2e/theme-surface-density.spec.ts` also walks every page at both
widths with an imported theme that names the largest word of every token, and that is the same
`roomy`, `strong` and `bold` this file uses.

## The mirror

The terminal palette is dark-space, gate-checked, and based on `collie`'s own slots with the review's
fixes (findings 1, 2, 12). The ground is `#100f0d`, computed back from the light page: turned over by
`invert(1) hue-rotate(180deg)` (ADR 0002, `mirror-space.ts`) it is `#f1f0ee`, the light `background`
itself (1.00), so the mirror's ground ends where the page begins in light, as in Harbour. In dark it
is 1.00 below the page `#100f0e`. Ink `#f2f1ef` is 16.97 on the ground and 16.94 on the turned-over
ground.

Every slot is measured twice: in dark space on `#100f0d`, and after the light-mode turn on `#f1f0ee`
(floor in the gate is 3, the target here 4.5). `collie`'s slots 1 to 14 turned over measure 2.0 to
4.3.

| slot | colour    | dark  | light (turned over) | note                                |
| ---- | --------- | ----- | ------------------- | ----------------------------------- |
| 0    | `#000000` | 1.10  | 1.14                | exempt: the colour of "no colour"   |
| 1    | `#ea8885` | 7.63  | 4.57                | red, see below                      |
| 2    | `#4dbb75` | 7.92  | 4.60                | green                               |
| 3    | `#e5e510` | 14.18 | 10.48               | bright set                          |
| 4    | `#57a7c7` | 7.08  | 4.54                | blue, review fix `#4ba8cc` nudged   |
| 5    | `#be85c6` | 6.71  | 4.54                | magenta, review fix `#bd81c0` nudged |
| 6    | `#4cbbbb` | 8.33  | 4.98                | cyan, moved toward teal             |
| 7    | `#e5e5e5` | 15.21 | 15.28               | bright set                          |
| 8    | `#9a9a9a` | 6.81  | 5.12                | review fix                          |
| 9    | `#ffa6a3` | 10.25 | 6.91                | bright red, lighter than slot 1     |
| 10   | `#45d07e` | 9.65  | 5.10                | bright green                        |
| 11   | `#f5f543` | 16.44 | 13.89               | bright set                          |
| 12   | `#709aeb` | 6.85  | 4.55                | bright blue                         |
| 13   | `#cf83d6` | 7.18  | 4.51                | bright magenta                      |
| 14   | `#65d0dc` | 10.59 | 6.85                | bright cyan                         |
| 15   | `#ffffff` | 19.16 | 18.44               | bright set                          |

- Red. The review proved that a saturated red cannot clear 4.5 in both spaces (`#e5484d` is 4.89 in
  dark and 2.31 turned over; `collie`'s `#cd3131` and `#f14c4c` are 2.05 and 2.51). The cost of passing
  is chroma. Slot 1 is oklch(0.73 0.12 22), a coral red: 7.63 and 4.57. Slot 9 is a lighter coral,
  10.25 and 6.91. If a stronger red is wanted, `#e5484d` is the review's choice and gives up
  2.2 points in light. Truecolor from an agent is not re-themed by any slot, so the structural fix
  (a light-native palette for the light mirror) is still the larger one.
- Slots 4 and 5 are the review's colours moved by one or two points of lightness, because
  `#4ba8cc` and `#bd81c0` measure 4.32 and 4.31 turned over, not 4.5.
- Bright set: slots 3, 7, 11 and 15 sit above relative luminance 0.6, every other slot at or below it
  (slot 14 is the closest, 0.53), as the gate and the Muse decorator require.

## The whole sheet (schema version 2)

Lowest pairs of the report: light, the info chip on the page (5.35), then the blocked chip on the
page (5.45); dark, the unknown chip on a card (5.65), then the blocked chip on a card (5.86).
`rule` on the page is 2.18 light and 3.49 dark (floor 1.3). Not in the report but held here: card on
page 1.14 and 1.15, band on page 1.13 and 1.32, muted-foreground on the band 7.21 and 7.76, `border`
on a card 1.74 and 1.97, `input` on a card 3.36 and 3.88, every chip on the band over 4.5.

Not in this file: the 157 uses of `text-[11px]`, the 57 of `text-[10px]` and the 17 alpha-faded muted
inks (review findings 6 and 7). Those are in components, not in a theme, and no theme can lift them.
