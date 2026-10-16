# Nightwatch: the palette and why

For the on-call phone in bed at night. The dark half is true black, so an OLED screen lights only
what carries information. The light half is a warm dusk for the same phone by day. The face is IBM
Plex Sans (key `plex`, SIL OFL 1.1): a calm humanist face with a real bold and tabular figures.

The reasoning in `index.css` (the comments on the `:root` block) still holds. This file records only
where Nightwatch picks its own values and what it measured. Numbers come from `contrastReport` in
`web/src/lib/theme/schema.ts` (the gate) plus the same arithmetic for the extra rows.

## Dark half

- `background` is `oklch(0 0 0)`, true black. `card` is L 0.16 and `chrome` L 0.21, both with a
  trace of warm hue 70. The spec asked for about 0.14 and 0.18. At 0.14 the card measured 1.06 on
  black, which reads as no step, so it went to 0.16 (1.08). Chrome went to 0.21 for a second reason:
  chrome sits on the terminal mirror, which was `#0a0a0a` under every theme until spec 17 gave a
  theme its own palette. At 0.18 chrome was 1.05 on that mirror and the grab handle stopped reading
  as a control. At 0.21 it is 1.12, the same step the default theme has; on Nightwatch's own black
  mirror ground (spec 18) it is 1.19.
- `foreground` is a warm off-white, L 0.9, not pure white. Less glare at night, still 15.5 on black.
- `primary` is the one dim amber: `oklch(0.75 0.09 70)`, chroma under 0.1. Its ink is a dark warm
  brown, 8.6 on the amber. As text (`text-primary` on the belt icons) it reads 9.3 on black.
- `destructive` has a DARK ink. A light red fill must clear 4.5 as text on black and on the card,
  and a fill dark enough for white text cannot. So the fill is `oklch(0.7 0.15 25)` and its ink is
  near black: 7.05 on the fill, 7.37 as text on black, 6.81 on the card. This fixes the one pair the
  default theme fails (2.77).
- `border`, `input` and `rule` are warm white at 14, 17 and 28 percent alpha, so they work on black
  and on the card alike. Rule 1.98 on black against border 1.28: the cut is clearly stronger.
- `ring` is amber `oklch(0.68 0.09 70)`: 7.15 on black, 6.6 on the card, 6.0 on chrome. The ring is
  drawn with `outline-offset-2` almost everywhere, so it sits on the ground, not on a primary fill.
- `control-on` stays a cool, low-chroma sky (L 0.27, chroma 0.035). A warm tint would look like the
  amber `working` chip. Ink on it 9.56.

## Light half

- `background` is `oklch(0.945 0.012 70)` (#f2ece4), a warm paper at dusk. `card` is a step lighter
  (0.975), `chrome` and `muted` a step darker (0.915), `accent` a step below that (0.89). The
  switcher still gets three separate values: resting, hover, active. `secondary` is the chrome band
  (spec 18, see "The whole sheet"), a deeper tan at 0.87.
- `primary` is a deep umber `oklch(0.47 0.1 60)`, the same hue as the dark amber but dark enough to
  be text: 6.0 on the page, 6.55 on the card, 6.55 under its light ink.
- `rule` 1.44 on the page against `border` 1.20. `ring` 4.07 on the page, 3.72 on chrome.
- `destructive` is a normal red fill with a light ink, 6.24. As text 5.63 on the page.

## Status: a step quieter, never under 4.5

Chroma is lower than the default in both halves (dark blocked 0.2 to 0.15, working 0.15 to 0.12,
done 0.16 to 0.11, info 0.15 to 0.1). Lightness is near the default. Two changes go further:

- Blocked and done now differ in LIGHTNESS as well as hue. Dark blocked L 0.67, done L 0.76; light
  blocked L 0.42, done L 0.45. A reader who confuses red and green still gets a step. The oklab
  distance is 0.25 dark and 0.24 light (floor 0.15).
- `working` is a yellow-olive at hue 95, not the primary amber (hue 70). The first pick (hue 72 light,
  85 dark) sat 0.029 (light) and 0.044 (dark) from `primary` in oklab, so the turning mark and the
  Send button read as one colour. Now light `oklch(0.45 0.1 95)` and dark `oklch(0.8 0.12 95)`; the
  distance to `primary` is now 0.063 (light) and 0.074 (dark), and the chip still clears 4.5 on both
  grounds.
- `idle` and `unknown` stay a cool pair (hue 250) on a warm page, so the hue keeps them apart from
  warm `muted-foreground`. The light pair was widened (0.46 and 0.41): rgb distance 25.1, the same
  band the default theme holds in dark. Dark pair 26.6.

Chip is `text-status-X` on `bg-status-X/15` over the ground (gate arithmetic, plain sRGB alpha).

| status  | light bg | light card | dark bg | dark card |
| ------- | -------- | ---------- | ------- | --------- |
| blocked | 5.99     | 6.52       | 5.71    | 5.08      |
| working | 5.05     | 5.49       | 9.15    | 7.99      |
| done    | 4.82     | 5.21       | 8.38    | 7.35      |
| idle    | 4.92     | 5.32       | 7.11    | 6.26      |
| unknown | 6.01     | 6.48       | 6.03    | 5.35      |
| info    | 4.80     | 5.19       | 8.25    | 7.26      |

## The rest of the gate

| check                                  | light | dark  |
| -------------------------------------- | ----- | ----- |
| foreground on background               | 15.45 | 15.54 |
| foreground on card                     | 16.85 | 14.35 |
| muted-foreground on background         | 6.07  | 7.83  |
| muted-foreground on card               | 6.62  | 7.23  |
| primary-foreground on primary          | 6.55  | 8.60  |
| destructive-foreground on destructive  | 6.24  | 7.05  |
| rule on background (floor 1.3)         | 1.44  | 1.98  |
| blocked apart from done (floor 0.15)   | 0.24  | 0.25  |

Lowest 4.5 check before the band: light, info chip on the page, 4.80. Dark, blocked chip on the
card, 5.08. With the band (spec 18) the light low is `muted-foreground` on the band, 4.78.

## Syntax and hosts

Syntax inks keep the default hues (no green, no red) at lower chroma. Lowest cell, measured on the
page, the card, and the added and deleted row tints (`/12` over page and card): light comment on a
deleted row 4.91, dark comment on an added row over the card 6.01. Host glyphs keep the ten default
hues; dark L 0.70 to 0.78 at about 70 percent of the default chroma, light L 0.45. Lowest host cell
on page, card or `muted/60`: light 5.98 (slot 5), dark 6.43 (slot 9).

## Known costs

- The mirror. Since spec 18 Nightwatch has its own terminal palette with a true black ground, so in
  dark the mirror and the page are one black (1.00). In light the mirror inverts that black to
  white on the warm page, 1.17, a faint seam the dark half pays for.
- `components/ui/badge.tsx` draws its destructive variant as `bg-destructive text-white`, a literal.
  In dark, white on this red is 2.85; the default theme has the same flaw (2.89). No screen uses
  that variant today. Not a token, so not fixed here.

## The whole sheet (schema version 2, spec 18)

An instrument panel at night: square, flat, heavy lines, a dim amber band across the top and the
bottom, and an amber terminal on true black. Every one of the twelve tokens is named in the file.

| token     | word or value       | spec 15 | why                                                                  |
| --------- | ------------------- | ------- | -------------------------------------------------------------------- |
| radius    | sharp               | sharp   | Square corners, an instrument and not a toy; the left accent bar stays. |
| shadow    | flat                | flat    | A shadow draws nothing on true black, so the edges do the work.       |
| density   | default             | default | The on-call phone shows as many rows as before.                       |
| weight    | bold                | bold    | Plex has a real bold; one step heavier reads at night with less glare. |
| border    | strong              | strong  | 2px lines carry the structure that shadows carry elsewhere.           |
| ground    | flat                | flat    | A pattern on true black would light pixels the OLED should keep off.  |
| chrome    | band                | page    | The header, tab bar and bottom bar stand on a dim amber band.         |
| rows      | rules               | rules   | Rows in one framed group with a rule between them, dense and calm.    |
| icons     | heavy               | default | A 2.5 stroke matches the bold text and the 2px lines.                 |
| labels    | caps                | caps    | Small capitals read like the legends on a panel.                      |
| display   | plex                | none    | Titles stay in Plex even when the Typeface card picks another face.   |
| ansi      | warm amber palette  | none    | The terminal speaks the theme's amber on the page's own true black.   |

- The band is `secondary`: dark `oklch(0.19 0.03 68)` (#1d1105), a brown near-black, 1.13 on the
  page; light `oklch(0.87 0.032 70)` (#e2d1be), a deeper tan, 1.27 on the page. It was 0.24 and
  0.915 before. `secondary` also fills the option buttons and the secondary button; their ink
  (`secondary-foreground`) reads 13.69 dark and 10.82 light on it.
- Band text: dark `foreground` 13.69, `muted-foreground` 6.90, `status-blocked` 5.78; light 12.17,
  4.78 and 6.20. `primary` as an icon on the band: 8.20 dark, 4.73 light.
- The palette, all eighteen keys, dark space. Ground `#000000`, ink `#e6d8c0` (14.95). Slots: 0
  `#2a2420`, 1 `#d9644a`, 2 `#9fae5a`, 3 `#f4cc7c`, 4 `#6f97c4`, 5 `#c7869e`, 6 `#7fae9b`, 7
  `#efe3cf`, 8 `#6b6058`, 9 `#ef8a5f`, 10 `#bcc77a`, 11 `#ffd98a`, 12 `#93b3d8`, 13 `#dba3b8`, 14
  `#a0cbb8`, 15 `#fff4e0`. Reds lean to orange, yellows to amber, blues and cyans stay dusty, so
  nothing on the screen is colder than the theme. Lowest slot on the ground: 8 at 3.44 (floor 3).
  The bright set (3, 7, 11, 15) has a relative luminance of 0.64 to 0.91; the brightest of the rest
  is 14 at 0.54 (line 0.6).

### Lowest pairs, the whole report (58 checks, 0 fail)

- Light: `muted-foreground` on the band, 4.78. Then the info chip on the page, 4.80.
- Dark: the blocked chip on a card, 5.08. Then the unknown chip on a card, 5.35.
