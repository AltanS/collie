# Daylight: the palette and why

Daylight is for direct sun and for low vision. It keeps Collie's layout, radius and status meaning
and changes only colour and the face. Every value is oklch. The numbers below are measured with
`contrastReport` from `lib/theme/schema.ts` (plain sRGB alpha, the pessimistic side of the browser's
oklab mix) and a scratch script that uses the same arithmetic for the pairs the report does not
cover. Rerun both after any change; never estimate.

## Rules this theme holds

- Body text at AAA, 7:1 or better, on the page and on a card, in both halves. That covers
  `foreground` and `muted-foreground`, because quiet text is still text a person must read.
- `border` and `rule` a clear step stronger than collie's, and `rule` still the stronger of the two.
- Status on a blue to orange axis. Red-green colour blindness keeps the blue to yellow axis, so
  blocked (orange) and done (blue) stay apart for it. Lightness steps apart too: 0.15 in light, 0.13
  in dark, so they also separate in greyscale. oklab distance 0.29 light, 0.30 dark (floor 0.25).
- `destructive` is the one red. No status, syntax ink or host hue sits in the red band.
- Every status chip (ink over its own 15 percent wash) at 4.5 or better on `background` and `card`.
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
| blocked | 0.50 0.128 52 orange | 0.81 0.13 60 orange | needs you, the warm end |
| working | 0.47 0.18 300 violet | 0.77 0.12 300 violet | busy, cool but not blue |
| done    | 0.35 0.13 260 blue   | 0.68 0.14 255 blue   | finished, the cool end  |
| idle    | 0.45 0.03 250 grey   | 0.74 0.03 250 grey   | quiet pair, idle above  |
| unknown | 0.41 0.03 250 grey   | 0.69 0.03 250 grey   | unknown 0.04 to 0.05 below |
| info    | 0.46 0.08 220 teal   | 0.80 0.12 220 cyan   | not a status, the prerelease strip |

- Light lightness order: blocked 0.50, working 0.47, info 0.46, idle 0.45, unknown 0.41, done 0.35.
  Dark: blocked 0.81, info 0.80, working 0.77, idle 0.74, unknown 0.69, done 0.68.
- Working is violet, not amber: amber beside orange would make working and blocked look alike, and
  for red-green colour blindness they would merge. Violet and done blue are 0.12 apart in light.
- Idle and unknown keep collie's pair rule: same hue, unknown below idle, chroma 0.03 so they read
  as a tint and not as `muted-foreground`.
- The diff rows follow: added rows wash in done blue, deleted rows in blocked orange. Blue and
  orange is the diff pair that red-green colour blindness reads.

## Syntax and host

- Syntax inks keep off the two row tints, so no blue near 255 and no orange near 52, and no red:
  keyword magenta 345, string green 150 (green is free here, added is blue), constant violet 295,
  property teal 195, entity gold 95, comment equal to `muted-foreground`.
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

- The pane mirror is not themed in v1 (ADR 0002). Its ground is `#0a0a0a` in dark and `#f5f5f5`
  inverted in light. Against daylight's page that is 1.02:1 in dark and 1.04:1 in light, a whisper
  of a seam. The direction asked for these two page values; closing the seam would need `0.97` and
  `0.145`, which is collie again. Look at it on the phone in sun before the merge.

## Measured table

`contrastReport` over `daylight.json`, both halves. Every finding passes.

| check                                  | light | dark  |
| -------------------------------------- | ----- | ----- |
| foreground on background               | 19.30 | 18.59 |
| foreground on card                     | 20.14 | 16.60 |
| muted-foreground on background         | 8.10  | 10.90 |
| muted-foreground on card               | 8.45  | 9.74  |
| primary-foreground on primary          | 17.95 | 16.96 |
| destructive-foreground on destructive  | 6.36  | 7.51  |
| status-blocked chip, background / card | 4.83 / 5.05 | 8.64 / 7.19 |
| status-working chip, background / card | 5.67 / 5.89 | 7.62 / 6.37 |
| status-done chip, background / card    | 8.40 / 8.79 | 5.93 / 5.02 |
| status-idle chip, background / card    | 5.68 / 5.91 | 7.20 / 6.04 |
| status-unknown chip, background / card | 6.65 / 6.90 | 6.12 / 5.20 |
| status-info chip, background / card    | 5.28 / 5.49 | 8.84 / 7.38 |
| rule on background                     | 1.99  | 2.98  |
| blocked apart from done (oklab)        | 0.29  | 0.30  |

Lowest finding: light, blocked chip on background, 4.83. Lowest in dark: done chip on card, 5.02.

Outside the report, same arithmetic: border on background 1.46 light and 1.73 dark (collie 1.16 and
1.26); rule 1.99 and 2.98 (collie 1.34 and 2.06); destructive as text on the page 6.36 and 7.56;
syntax inks on page, card, added row and deleted row 5.46 or better in light (entity on the added
row is the tightest) and 7.99 or better in dark; host glyphs 6.5 or better on their tag.
