# Daylight: the palette and why

Daylight is for direct sun and for low vision. It keeps Collie's layout and status meaning and
changes the colour, the face and the shape (see "The whole sheet" at the end). Every value is oklch. The numbers below are measured with
`contrastReport` from `lib/theme/schema.ts` (plain sRGB alpha, the pessimistic side of the browser's
oklab mix) and a scratch script that uses the same arithmetic for the pairs the report does not
cover. Rerun both after any change; never estimate.

## Rules this theme holds

- Body text at AAA, 7:1 or better, on the page, on a card and at the foot of the gradient ground,
  in both halves. That covers `foreground` and `muted-foreground`, because quiet text is still text
  a person must read.
- `border` and `rule` a clear step stronger than collie's, and `rule` still the stronger of the two.
- Status on a blue to orange axis. Red-green colour blindness keeps the blue to yellow axis, so
  blocked (orange) and done (blue) stay apart for it. Lightness steps apart too: 0.09 in light, 0.13
  in dark, so they also separate in greyscale. oklab distance 0.28 light, 0.30 dark (floor 0.25).
- `destructive` is the one red. No status, syntax ink or host hue sits in the red band.
- Every status chip (ink over its own 15 percent wash) at 4.5 or better on `background`, `card` and
  the foot of the gradient.
- `themes.test.ts` holds the AAA floor, the 0.25 distance and the line steps as tests.

## Surfaces

- Light page `0.985`, near white but not white, card pure white. The step is small (1.04:1) on
  purpose: in sun a grey page reads as dirty. Cards are drawn by the stronger `border` instead.
- Dark page `0.12`, a step below collie's `0.145`, so the page is closer to black in a dark room and
  text gains contrast. Card and chrome `0.2` (1.12:1 on the page), the same one raised surface, as
  in collie, where dark chrome equals dark card.
- Light `chrome`, `muted` and `secondary` at `0.93`, `accent` at `0.9`. Resting page 0.985, hover
  `muted/60` near 0.95, active 0.9: three values a switcher can still tell apart.
- `primary` stays neutral, near black on light and near white on dark (17.9 and 17.0 for its text).
  A blue primary would sit beside the blue of done and blur what blue means here.
- `control-on` keeps collie's sky tint with more chroma in light (0.07 at L 0.87), so an armed
  control reads in sun. Its text is 9.3 on it in both halves.
- `ring` is a clear blue, 6.4 light and 9.2 dark on the page, well over the 3:1 non-text floor.
- `input` is 3.1 light and 4.0 dark on the page, so a text field has an edge a low-vision reader can
  find (WCAG 1.4.11 asks 3:1 for a field's boundary). `border` stays lighter so cards do not shout.

## Status

| token   | light              | dark              | role                     |
| ------- | ------------------ | ----------------- | ------------------------ |
| blocked | 0.43 0.11 52 orange  | 0.81 0.13 60 orange | needs you, the warm end |
| working | 0.45 0.18 300 violet | 0.77 0.12 300 violet | busy, cool but not blue |
| done    | 0.34 0.17 265 blue   | 0.68 0.14 255 blue   | finished, the cool end  |
| idle    | 0.43 0.03 250 grey   | 0.74 0.03 250 grey   | quiet pair, idle above  |
| unknown | 0.39 0.03 250 grey   | 0.69 0.03 250 grey   | unknown 0.04 to 0.05 below |
| info    | 0.43 0.075 220 teal  | 0.80 0.12 220 cyan   | not a status, the prerelease strip |

- Light lightness order: working 0.45, blocked 0.43, info 0.43, idle 0.43, unknown 0.39, done 0.34.
  Spec 18 moved the light statuses down (blocked from 0.50, working 0.47, done 0.35, idle 0.45,
  unknown 0.41, info 0.46), because the gradient ground's foot is darker than the page and the
  chips must clear 4.5 there too. Done gained chroma (0.13 to 0.17, hue 260 to 265, in gamut) so it
  stays 0.28 from the darker blocked.
  Dark: blocked 0.81, info 0.80, working 0.77, idle 0.74, unknown 0.69, done 0.68.
- Working is violet, not amber: amber beside orange would make working and blocked look alike, and
  for red-green colour blindness they would merge. Violet and done blue are 0.11 apart in lightness
  in light, 0.15 in oklab.
- Idle and unknown keep collie's pair rule: same hue, unknown below idle, chroma 0.03 so they read
  as a tint and not as `muted-foreground`.
- The diff rows follow: added rows wash in done blue, deleted rows in blocked orange. Blue and
  orange is the diff pair that red-green colour blindness reads.

## Syntax and host

- Syntax inks keep off the two row tints, so no blue near 255 and no orange near 52, and no red:
  keyword magenta 345, string green 150 (green is free here, added is blue), constant violet 295,
  property teal 195, entity gold 95, comment equal to `muted-foreground` (both 0.38 in light since
  spec 18, 0.42 before).
- Host hues keep off blocked (40 to 85), done (245 to 270), working (285 to 315) and red. The ten:
  cyan 190, pink 350, lime 138, indigo 278, gold 95, sky 237, green 155, fuchsia 325,
  chartreuse 118, emerald 172, in slot order so neighbours sit far apart. Light at L 0.44 with the
  most in-gamut chroma up to 0.2; dark at L 0.78 (indigo 0.72, it has no chroma higher up).
- Every value is in sRGB gamut, checked without the clamp.

## The face

Geist 1.800 (SIL OFL 1.1), key `geist`, 23 KB woff2, Latin plus Latin Extended A, wght 400 to 700.
Plain geometric shapes, open counters and a tall x-height read well at small sizes in glare. Its bold
is a real drawn weight, so `font-synthesis-weight: none` costs it nothing.

## Known and accepted

- Spec 18 gives the mirror its own palette with a warm ground `#1a1612`. In dark that is 1.13 on
  the page, a terminal well a shade above the black; in light it inverts to a warm near-white
  `#ece8e4`, 1.17 on the page. Collie's own mirror sat at 1.02 and 1.04 here.

## Measured table

`contrastReport` over `daylight.json`, both halves, 74 checks. Every finding passes.

| check                                  | light | dark  |
| -------------------------------------- | ----- | ----- |
| foreground on background               | 19.30 | 18.59 |
| foreground on card                     | 20.14 | 16.60 |
| foreground on the gradient foot        | 14.41 | 15.80 |
| muted-foreground on background         | 9.63  | 10.90 |
| muted-foreground on card               | 10.05 | 9.74  |
| muted-foreground on the gradient foot  | 7.19  | 9.27  |
| primary-foreground on primary          | 17.95 | 16.96 |
| destructive-foreground on destructive  | 6.36  | 7.51  |
| status-blocked chip, background / card / foot | 6.34 / 6.59 / 4.84 | 8.64 / 7.19 / 6.79 |
| status-working chip, background / card / foot | 6.11 / 6.34 / 4.66 | 7.62 / 6.37 / 6.01 |
| status-done chip, background / card / foot    | 8.89 / 9.23 / 6.71 | 5.93 / 5.02 / 4.75 |
| status-idle chip, background / card / foot    | 6.18 / 6.42 / 4.68 | 7.20 / 6.04 / 5.69 |
| status-unknown chip, background / card / foot | 7.21 / 7.49 / 5.50 | 6.12 / 5.20 / 4.87 |
| status-info chip, background / card / foot    | 5.97 / 6.20 / 4.56 | 8.84 / 7.38 / 6.97 |
| destructive text on the gradient foot  | 4.75  | 6.42  |
| rule on background / on the foot       | 1.99 / 1.48 | 2.98 / 3.14 |
| blocked apart from done (oklab)        | 0.28  | 0.30  |

Lowest finding: light, the info chip on the gradient foot, 4.56, then the working chip there, 4.66.
Dark: the done chip on the gradient foot, 4.75, then the unknown chip there, 4.87. The foot is
`--background` mixed with 12 percent of `--primary` (surface.ts), near black in light and near white
in dark, so the gradient darkens the light page and lifts the dark one.

Outside the report, same arithmetic: border on background 1.46 light and 1.73 dark (collie 1.16 and
1.26); rule 1.99 and 2.98 (collie 1.34 and 2.06); destructive as text on the page 6.36 and 7.56;
syntax inks on page, card, added row and deleted row 5.43 or better in light (entity on the added
row is the tightest) and 7.99 or better in dark; host glyphs 6.5 or better on their tag.

## The whole sheet (schema version 2, spec 18)

Open, airy and a little playful: round corners, rows as separate cards that float on a page which
deepens toward the foot, roomy steps, sentence-case labels and Atkinson titles over a Geist body.
Every one of the twelve tokens is named in the file.

| token     | word or value          | spec 15 | why                                                                 |
| --------- | ---------------------- | ------- | ------------------------------------------------------------------- |
| radius    | round                  | round   | Soft, friendly corners; a marked row wears a ring, never a left bar. |
| shadow    | lifted                 | lifted  | Cards rise off a near-white page that has little tone of its own.   |
| density   | roomy                  | roomy   | More air and larger targets for a thumb in sun.                     |
| weight    | default                | default | The colour already holds body text at 7:1; no need for a heavier face. |
| border    | default                | default | The lines are already a step stronger than Collie's.                |
| ground    | gradient               | flat    | The page deepens toward the foot, so white cards stand out below.   |
| chrome    | page                   | page    | The bars stay the page colour, so the gradient is the one effect on the page. |
| rows      | cards                  | rules   | Every row is its own lifted card, filled with `card`, with a gap, the playful look. |
| icons     | default                | default | Lucide's own 2 stroke matches Geist's regular weight.               |
| labels    | sentence               | caps    | Section labels in sentence case read as friendly, not as legends.   |
| display   | atkinson               | none    | Titles in Atkinson Hyperlegible, a second face for the low-vision promise. |
| ansi      | high-contrast palette  | none    | Vivid slots on a warm dark ground, readable in glare.               |

- The palette, dark space. Ground `#1a1612`, ink `#f5f0e8` (15.86). Slots: 0 `#3a332c`, 1
  `#ff5f56`, 2 `#5fd068`, 3 `#ffd84a`, 4 `#5aa9ff`, 5 `#e07ce8`, 6 `#3fd6d0`, 7 `#f2efe9`, 8
  `#8a827a`, 9 `#ff8a80`, 10 `#7ad683`, 11 `#ffeb8a`, 12 `#8cc4ff`, 13 `#f0a6f5`, 14 `#6ad8d2`, 15
  `#ffffff`. Lowest slot on the ground: 8 at 4.76, then 1 at 6.02 (floor 3). The bright set has a
  relative luminance of 0.71 to 1.00; the brightest of the rest is 14 at 0.57 (line 0.6).
- Atkinson is one extra woff2 (23 KB), loaded only under this theme, for the titles and the header line.

### Lowest pairs, the whole report (74 checks, 0 fail)

- Light: the info chip on the gradient foot, 4.56.
- Dark: the done chip on the gradient foot, 4.75.
