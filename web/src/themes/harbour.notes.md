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
  is too light for status chips at 4.5 and too far from the mirror. 0.21 keeps the Nord hue and sat
  near Collie's mirror ground `#0a0a0a`; since spec 18 the mirror stands on Harbour's own `#0a1216`
  (see The mirror). `card` and `chrome` are one raised surface at 0.255, as in `collie`.
- Inks: light `foreground` oklch(0.26 0.025 250) (#1b2530) is Nord's night used as ink; dark
  `foreground` oklch(0.93 0.012 240) is Nord's snow used as ink.
- `muted-foreground` is nearly neutral (chroma 0.008 light, 0.012 dark). The idle and unknown
  status inks carry the blue-grey tint, so the two must not share it (see Status).

## Lines and focus

- `rule` is visibly stronger than `border` in both halves: light 1.51 against 1.22, dark 2.48
  against 1.93 (each on `background`). Lines are opaque cool greys, not white at an alpha, so the
  measure is the paint.
- Dark lines moved on 2026-10-16 (M57 spec 12, counsel). The permission card's option button is
  `secondary` with a `border`, and dark `border` was oklch(0.3 0.02 250) on `secondary`
  oklch(0.3 0.022 252): 1.00, an invisible edge. Collie's dark value is 1.46. The three dark lines
  moved up the same ladder so the order border, input, rule holds:

  | dark token | old                     | new                     | old / new on background | on card     | on secondary |
  | ---------- | ----------------------- | ----------------------- | ----------------------- | ----------- | ------------ |
  | `border`   | oklch(0.3 0.02 250)     | oklch(0.4 0.02 250)     | 1.30 / 1.93             | 1.16 / 1.71 | 1.00 / 1.48  |
  | `input`    | oklch(0.33 0.02 250)    | oklch(0.42 0.02 250)    | 1.45 / 2.09             | 1.28 / 1.86 | 1.11 / 1.60  |
  | `rule`     | oklch(0.4 0.025 250)    | oklch(0.46 0.025 250)   | 1.93 / 2.48             | 1.71 / 2.20 | 1.48 / 1.90  |

  `border` on `secondary` is now 1.48, above collie's 1.46, and `border` on `background` rose from
  1.30 to 1.93, so it did not drop. `input` and `rule` moved only to keep `border` below `input`
  below `rule`, as in `collie`. Light stays: `border` on `secondary` is 1.09 there, near collie's
  1.06.
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
| light background | 5.44   | 5.25    | 5.13 | 5.24 | 6.13    | 5.26 |
| light card      | 6.04    | 5.78    | 5.63 | 5.80 | 6.72    | 5.78 |
| light grain line | 5.07   | 4.85    | 4.75 | 4.89 | 5.66    | 4.87 |
| dark background | 5.37    | 7.52    | 6.78 | 6.34 | 5.35    | 7.03 |
| dark card       | 4.67    | 6.56    | 5.93 | 5.54 | 4.70    | 6.16 |
| dark grain line | 4.93    | 6.88    | 6.21 | 5.81 | 4.91    | 6.44 |

- Spec 18 moved the six light inks down by 0.02 to 0.03 in lightness (blocked 0.47 to 0.45,
  working 0.47 to 0.45, done 0.46 to 0.44, idle 0.46 to 0.45, unknown 0.42 to 0.41, info 0.46 to
  0.43), because the grain ground's line colour is darker than the page and every chip must clear
  4.5 on it too. Dark needed no move. The grain line is the page with 4 percent of `foreground`
  (surface.ts, `GROUND_GRAIN_LINE`); it was 6 percent when the inks moved, so they keep a margin.

- Hues: blocked 20, working 72 to 80, done 140 to 145, info 225. Blocked and done are 0.24 apart in
  oklab light and 0.23 dark (floor 0.15).
- Idle and unknown are a lavender grey (hue 280, chroma 0.045 to 0.05), unknown 0.04 to 0.06 darker
  than idle, as in `collie`. They needed more chroma than `collie`'s 0.03 because every surface here
  is already blue-grey: at 0.03 they read as plain muted text. RGB distance now: idle to unknown
  20.4 light, 31.8 dark; idle to muted ink 21.3 and 45.0; unknown to muted ink 26.5 and 23.3.
- Tightest cells: light done on the grain line (4.75), dark blocked on the card (4.67). Darken the
  light one and lighten the dark one if either moves; never the reverse.

## Syntax

Inks read like an editor, from the two families: keyword Nord blue (258), string Solarized cyan
(188), constant Nord purple (325), property Nord orange (50 to 55), entity Solarized yellow (90 to
95), comment a quiet blue-grey (265, chroma 0.025 to 0.04). No green and no red, so the added row
(done /12) and the deleted row (blocked /12) keep their meaning. Strings are cyan, not Nord's green,
for that reason.

| ink      | light page | card | added | deleted | dark page | card | added | deleted |
| -------- | ---------- | ---- | ----- | ------- | --------- | ---- | ----- | ------- |
| keyword  | 6.03       | 6.69 | 5.06  | 4.93    | 8.26      | 7.32 | 6.56  | 6.93    |
| string   | 5.85       | 6.49 | 4.91  | 4.78    | 9.82      | 8.70 | 7.80  | 8.24    |
| constant | 6.06       | 6.72 | 5.08  | 4.95    | 8.26      | 7.32 | 6.56  | 6.93    |
| property | 5.94       | 6.59 | 4.98  | 4.86    | 8.60      | 7.62 | 6.83  | 7.22    |
| entity   | 6.18       | 6.86 | 5.19  | 5.06    | 11.18     | 9.90 | 8.88  | 9.38    |
| comment  | 5.91       | 6.56 | 4.96  | 4.84    | 6.11      | 5.42 | 4.86  | 5.13    |

Every cell clears 4.5 (spec 18: the light row tints follow the darker status inks; lowest string on a deleted row, 4.78). The closest pair of inks is 0.079 apart in oklab (string and comment, light);
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

Since spec 18 Harbour carries its own terminal palette. The ground is `#0a1216`, a near-black blue,
and not Solarized's base03 `#002b36`. The reason: the mirror's ground ends where the transcript
ends, and the page shows under it. In light the mirror is turned over (`invert(1) hue-rotate(180deg)`,
ADR 0002), and base03 turned over is a pale cyan `#bae5f0`, 1.17 on the page: a cyan card cut off
mid-screen. So the ground is computed back from the light page: `#0a1216` turned over is `#e8f0f4`,
the light `background` itself (1.00), as Collie's `#0a0a0a` turns into its own near-white page. In
dark the ground is 1.07 below the page `#121920`, a slightly deeper well that keeps the blue lean.
The composer's chrome still stands on the mirror as a control.

## Face

Atkinson Hyperlegible Next (key `atkinson`), the Braille Institute face for low vision. Letters
that are easy to mix up in a path or a hash (I l 1, 0 O) are drawn apart. Real weights 400 to 700.

## The whole sheet (schema version 2, spec 18)

Calm, like an editor: soft corners on lifted cards, a woven grain under the page, thin icon lines,
a Space Grotesk title over an Atkinson body, and a Solarized terminal. Every one of the twelve
tokens is named in the file.

| token     | word or value        | spec 15 | why                                                                    |
| --------- | -------------------- | ------- | ---------------------------------------------------------------------- |
| radius    | soft                 | soft    | Takes the edge off the cool grey without turning a control into a pill. |
| shadow    | lifted               | default | Soft corners alone were hard to see (spec 15 review); a lift shows them. |
| density   | default              | default | Rows keep the density a terminal reader expects.                       |
| weight    | default              | default | Atkinson's regular is already clear; the theme is quiet, not loud.     |
| border    | default              | default | Lines stay 1px, as in an editor.                                       |
| ground    | grain                | flat    | A fine woven texture under the page, like chart paper in a harbour office. |
| chrome    | page                 | page    | The bars stay the page colour, so the grain runs edge to edge.         |
| rows      | rules                | rules   | Rows in one framed group, like the lines of a file tree.               |
| icons     | thin                 | default | A 1.5 stroke matches the light editor feel.                            |
| labels    | caps                 | caps    | Small capitals read like the section heads of an editor sidebar.       |
| display   | grotesk              | none    | Titles in Space Grotesk, the sister of Space Mono, a coder's face.     |
| ansi      | Solarized-like       | none    | The terminal palette editor people know, on a near-black blue.         |

- The palette, dark space. Ground `#0a1216` (see The mirror), ink `#839496` (base0, 5.98). Slots: 0
  `#073642` (base02), 1 `#f0504a` red, 2 `#859900` green, 3 `#eed98a`, 4 `#268bd2` blue, 5
  `#e8559a` magenta, 6 `#2aa198` cyan, 7 `#eee8d5` (base2), 8 `#657b83` (base00), 9 `#e26a33`
  orange, 10 `#a4b832`, 11 `#f6e7b0`, 12 `#6aaee6`, 13 `#6c71c4` violet, 14 `#5fc4b9`, 15 `#fdf6e3`
  (base3). Solarized's own accents fill 2, 4, 6 and 13, and a lighter step of them fills 1, 5 and 9.
  Three places leave Solarized: its red, magenta and orange (`#dc322f`, `#d33682`, `#cb4b16`) read
  1.74, 1.74 and 1.78 on the light half's inverted base03 (ADR 0002), under Collie's own 2.06 and
  2.15, so they move a step lighter; on the final ground they read 2.40, 2.54 and 2.87 turned over
  in light and 5.36, 5.58 and 5.71 in dark; its yellow
  `#b58900` has a relative luminance of 0.29 and slot 3 belongs to the bright set (above 0.6), so
  slot 3 is a light Solarized-tinted yellow; and Solarized puts greys in 10, 11, 12 and 14, where
  base01 measures under 3 on base03, so those slots are lighter accents. Lowest slot on the ground:
  8 at 4.24, then 13 at 4.32 (floor 3); slot 0 (exempt) is 1.45. Turned over in light the lowest
  coloured slot is 4 at 2.82 (Collie's red is 2.06). The bright set has a luminance of 0.70 to 0.92;
  the brightest of the rest is 14 at 0.45.
- Space Grotesk is one extra woff2 (27 KB), loaded only under this theme, for the titles and the
  header line.

### Lowest pairs, the whole report (74 checks, 0 fail)

- Light: the done chip on the grain line, 4.75, then destructive text on the grain line, 4.77.
  `rule` on the grain line is 1.39 (floor 1.3).
- Dark: the blocked chip on a card, 4.67, then the unknown chip on a card, 4.70.
