# Harbour: palette notes

The reasoning behind `harbour.json` (JSON has no comments). Harbour is for people who come from
terminal and editor culture: a cool blue-grey in the family of Nord and Solarized, low chroma, one
teal accent, and a light half in the same key. The rules are the ones `index.css` states for the
theme `collie`; only the values are new. Measured with `contrastReport` from `lib/theme/schema.ts`
(plain sRGB alpha, the pessimistic side of the browser's mix) and the same arithmetic for the rows
the gate does not cover.

## Surfaces

- One key for both halves: hue 235 to 252, chroma 0.004 to 0.025. Every surface stays under 0.03,
  so the page reads as tinted grey, not as blue.
- Light `background` is oklch(0.95 0.01 235) (#e8f0f4), close to Nord's snow (#eceff4) but a touch
  cooler. `card` is a lift to 0.985, `chrome`, `muted` and `secondary` sit a step below the page at
  0.915, `accent` a step below that at 0.89, so the switcher keeps three separate values (rest,
  hover, active), as in `collie`.
- Dark `background` is oklch(0.21 0.018 250) (#121920). Nord's own night (#2e3440) is L 0.32; that
  is too light for status chips at 4.5 and too far from the mirror. 0.21 keeps the Nord hue and sits
  near the mirror's #0a0a0a. `card` and `chrome` are one raised surface at 0.255, as in `collie`.
- Inks: light `foreground` oklch(0.26 0.025 250) (#1b2530) is Nord's night used as ink; dark
  `foreground` oklch(0.93 0.012 240) is Nord's snow used as ink.
- `muted-foreground` is nearly neutral (chroma 0.008 light, 0.012 dark). The idle and unknown
  status inks carry the blue-grey tint, so the two must not share it (see Status).

## Lines and focus

- `rule` is visibly stronger than `border` in both halves: light 1.51 against 1.22, dark 1.93
  against 1.30 (each on `background`). Lines are opaque cool greys, not white at an alpha, so the
  measure is the paint.
- `ring` is the teal at a mid lightness: 3.88 on the light page, 6.81 on the dark one. Both clear
  the 3:1 floor for a focus mark at full strength.

## The one accent

- `primary` is teal near hue 190 (Nord frost #8fbcbb, Solarized cyan #2aa198): light
  oklch(0.47 0.075 192) under a near-white ink (6.31), dark oklch(0.78 0.07 190) under the page
  colour (9.09). It is the only saturated surface in the theme.
- `control-on` is a pale frost cyan (hue 215), a state tint and not a second accent. Its ink clears
  7.18 light and 8.27 dark.
- `destructive` stays red. Light oklch(0.52 0.16 22) under near white (5.75). Dark
  oklch(0.68 0.14 20) under the dark page ink (5.86), so the filled button is a light red with dark
  text. `collie` keeps white on light red there (2.77); harbour does not. As text on the page the
  red reads 5.18 light and 5.75 dark.

## Status

Nord's aurora at the lightness `collie` uses. Chip = ink over the ink at /15 over the ground.

| chip on         | blocked | working | done | idle | unknown | info |
| --------------- | ------- | ------- | ---- | ---- | ------- | ---- |
| light background | 5.03   | 4.85    | 4.76 | 5.07 | 5.85    | 4.67 |
| light card      | 5.58    | 5.34    | 5.27 | 5.56 | 6.48    | 5.13 |
| dark background | 5.37    | 7.52    | 6.78 | 6.34 | 5.35    | 7.03 |
| dark card       | 4.67    | 6.56    | 5.93 | 5.54 | 4.70    | 6.16 |

- Hues: blocked 20, working 72 to 80, done 140 to 145, info 225. Blocked and done are 0.24 apart in
  oklab light and 0.23 dark (floor 0.15).
- Idle and unknown are a lavender grey (hue 280, chroma 0.045 to 0.05), unknown 0.04 to 0.06 darker
  than idle, as in `collie`. They needed more chroma than `collie`'s 0.03 because every surface here
  is already blue-grey: at 0.03 they read as plain muted text. RGB distance now: idle to unknown
  19.9 light, 31.8 dark; idle to muted ink 22.4 and 45.0; unknown to muted ink 23.0 and 23.3.
- Tightest cells: light info on the page (4.67), dark blocked on the card (4.67). Darken the light
  one and lighten the dark one if either moves; never the reverse.

## Syntax

Inks read like an editor, from the two families: keyword Nord blue (258), string Solarized cyan
(188), constant Nord purple (325), property Nord orange (50 to 55), entity Solarized yellow (90 to
95), comment a quiet blue-grey (265, chroma 0.025 to 0.04). No green and no red, so the added row
(done /12) and the deleted row (blocked /12) keep their meaning. Strings are cyan, not Nord's green,
for that reason.

| ink      | light page | card | added | deleted | dark page | card | added | deleted |
| -------- | ---------- | ---- | ----- | ------- | --------- | ---- | ----- | ------- |
| keyword  | 6.03       | 6.69 | 5.10  | 4.97    | 8.26      | 7.32 | 6.56  | 6.93    |
| string   | 5.85       | 6.49 | 4.95  | 4.82    | 9.82      | 8.70 | 7.80  | 8.24    |
| constant | 6.06       | 6.72 | 5.13  | 4.99    | 8.26      | 7.32 | 6.56  | 6.93    |
| property | 5.94       | 6.59 | 5.03  | 4.89    | 8.60      | 7.62 | 6.83  | 7.22    |
| entity   | 6.18       | 6.86 | 5.23  | 5.10    | 11.18     | 9.90 | 8.88  | 9.38    |
| comment  | 5.91       | 6.56 | 5.01  | 4.88    | 6.11      | 5.42 | 4.86  | 5.13    |

Every cell clears 4.5. The closest pair of inks is 0.079 apart in oklab (string and comment, light);
`collie`'s closest is 0.080.

## Hosts

Ten hues, interleaved like `collie`'s, cool first: cyan 200, orange 48, purple 302, lime 112,
pink 352, teal 172, blue 255, orchid 326, sky 240, indigo 278. The warm ones carry less chroma in
dark than `collie` (Nord's calm), the cool ones carry the colour. Lightness also varies by slot
(dark 0.66 to 0.86, light 0.43 to 0.51) so neighbours on the wheel still part. Glyph on the ground:
light 4.93 to 7.70 on the page and 5.47 to 8.54 on the card; dark 5.49 to 11.71 and 4.86 to 10.37.
The closest pair is 0.051 light and 0.062 dark (`collie`: 0.040 and 0.065). The closest host to a
status is sky against info at 0.043 light and cyan against info at 0.042 dark (`collie`: 0.018 and
0.008); info is never drawn beside a host mark.

## The mirror

A theme does not touch the mirror in v1, so the seam is a fact to record, not to fix. Dark page
against the mirror's #0a0a0a: 1.12 (the mirror reads as a slightly deeper well, like an editor's
terminal panel). Light page against the inverted mirror's #f5f5f5: 1.06. The composer's chrome
stands on the mirror at 1.18 light and 1.26 dark, so the grab handle still reads as a control.

## Face

Atkinson Hyperlegible Next (key `atkinson`), the Braille Institute face for low vision. Letters
that are easy to mix up in a path or a hash (I l 1, 0 O) are drawn apart. Real weights 400 to 700.
