# Petal: the palette and why

Petal shows how soft Collie can look. It is pastel pink and lavender on a cream page in light, and a
deep berry night in dark. Altan asked for a theme that changes what a screen looks like at a glance,
not a new coat of paint, so Petal uses every word of the sheet (see "The whole sheet" at the end).
Every value is oklch and in sRGB gamut without the clamp. The numbers are measured with
`contrastReport` from `lib/theme/schema.ts`; rerun it after any change, never estimate.

## Names

Working name was Sakura. Sakura is also the name of well-known anime characters, so the shipped
name is **Petal**. The other proposals were **Mochi** (a soft rice cake) and **Sakura**. Petal
was kept because it is one short plain word, it names the cherry-blossom pink, and it is no
brand or character.

## Rules this theme holds

- Every check of the contrast report passes in both halves, on the page, the card, the foot of
  the gradient and the band.
- `destructive` is the one red (hue 28). The primary pink sits at hue 352, the blocked coral at 38,
  and no host hue sits in the red band.
- The theme never pairs a left accent bar with its round corners. Under `radius: round` a marked
  row wears the ring on all four sides (`--edge-accent`), and the folder tab draws a top edge.

## Surfaces

| token | light | dark | note |
| --- | --- | --- | --- |
| `background` | 0.975 0.016 75 | 0.2 0.055 355 | cream, and a berry night |
| `card` | 0.96 0.022 352 | 0.27 0.07 355 | a blush card, a raised berry |
| `chrome`, `secondary` | 0.89 0.065 350 | 0.33 0.09 355 | the clearly pink band behind the header and bottom bar |
| `border` | 0.8 0.08 355 | 0.5 0.12 355 | the rose ring around every card |
| `primary` | 0.56 0.19 355 | 0.82 0.11 355 | rose: Send, the open tab, the chosen segment |
| `accent`, `control-on` | 0.91 0.05 305, 0.85 0.08 305 | 0.36 0.08 305, 0.42 0.11 305 | lavender, the second accent |
| `foreground` | 0.3 0.07 340 | 0.95 0.02 350 | plum ink, pink-white ink |

- The lead's first review (2026-11-08) read the first draft as "the standard layout in cream", so
  this pass pushes every surface the schema reaches: a pink band in place of a blush tint, blush
  cards with a rose ring, a rose primary at chroma 0.19, lavender for hover and switches, and a
  berry dark half (hue 355, chroma 0.055 to 0.09) in place of a brown-leaning plum.
- The page is cream (hue 75) and not pink. The gradient ground mixes 12% of the rose primary into
  the foot, so the page warms from cream to pink toward the bottom bar. A word cannot make that mix
  stronger; a more saturated primary is the only lever, and it is near the gamut edge already.
- Body text: light 13.1 on the page, 11.2 at the gradient foot, 9.9 on the band; dark 15.8, 13.1
  and 10.9. Muted text: light 6.6 on the page, 5.7 at the foot, 5.0 on the band (the tightest
  text cell); dark 10.3, 8.6 and 7.2.
- Text on the primary: light 4.98, dark 9.66. The light rose is the darkest pink that still reads
  as pink; a lighter one fails white text.
- `tab-active` equals `primary` in both halves, so the open folder tab wears a rose top edge.
  It measures 4.80 light and 10.0 dark on the page (floor 3).
- `rule` 1.67 light and 2.44 dark on the page, 1.43 and 2.03 at the gradient foot (floor 1.3).
- Syntax and host inks are at least 5.76 light and 7.11 dark on the page and the card.
- The gap between cards is the `rows: cards` word's fixed 8px, and `density: roomy` is the largest
  step. More air between cards is not reachable inside the schema.

## Status

| token | light | dark | role |
| --- | --- | --- | --- |
| blocked | 0.47 0.14 38 coral | 0.82 0.12 60 apricot | needs you, the warm end |
| working | 0.46 0.17 298 violet | 0.79 0.11 300 lavender | busy |
| done | 0.43 0.075 175 teal | 0.8 0.1 175 mint | finished, the cool end |
| idle | 0.45 0.035 320 mauve grey | 0.76 0.03 320 | quiet pair, idle above |
| unknown | 0.41 0.035 320 | 0.72 0.03 320 | 0.04 below idle |
| info | 0.44 0.085 235 sky | 0.8 0.09 230 | not a status |

- Blocked and done sit on the warm to cool axis, 0.21 apart in oklab light and 0.19 dark
  (floor 0.15). Coral and teal stay apart for red-green colour blindness too.
- The light inks sit lower than they look. The gradient foot is darker than the page, and every
  chip must clear 4.5 there. The tightest cells are light blocked at the foot (4.65) and dark
  unknown at the foot (4.72).

## Syntax and host

- Syntax: keyword pink 350, string green 160, constant violet 295, property blue 210, entity gold
  80 to 85, comment equal to `muted-foreground`.
- Hosts, in slot order: rose 355, teal 190, violet 300, green 140, orchid 330, blue 240, gold 85,
  indigo 275, sea green 165, lime 115. Light at L 0.47 to 0.48, dark at L 0.76 to 0.84.

## The mirror

The palette is pastel on a near-black berry. The ground is `#140a10`. In light the mirror is turned
over (`invert(1) hue-rotate(180deg)`, ADR 0002), and `#140a10` turned over is `#faf0f6`, a faint
pink white beside the cream page, so the mirror reads as a card and not as a hole. In dark it is a
deeper well under the berry page. Every slot clears its gate by a wide margin: the lowest is slot 8
at 5.9, the ink is 16.5.

## Face

Atkinson Hyperlegible Next for the text (key `atkinson`) and Nunito for titles (key `nunito`).
Nunito 3.602 is a rounded sans (SIL OFL 1.1), bundled for this theme with the lead's yes on
2026-11-08: one variable woff2, wght 400 to 700, Latin plus Latin Extended A, 30,716 bytes. It is
fetched only while a theme or the Typeface card names it; under the other four themes no request
for it is made.

Nunito is the display face and not the text face on purpose. It has no `tnum` feature, so its
figures stay proportional under `tabular-nums`, and every count in the app would change width as
it ticks (DESIGN.md §2, no state may move content). The titles carry the rounded hand; the text
and the counts stay on Atkinson.

## The whole sheet (schema version 4)

Soft and friendly: round corners, soft shadows, roomy spacing, rows as cards, a cream to blush
gradient under the page, a blush band behind the header and bars, a rose folder tab, the composer
as a chat box, and sentence-case labels.

| key | word | why |
| --- | --- | --- |
| `radius` | `round` | the softest corners the sheet has |
| `shadow` | `default` | soft, not lifted: a pastel page wants little weight |
| `density` | `roomy` | air around every row |
| `weight` | `default` | 500 and 600, lighter than Collie's bold |
| `border` | `default` | 1px lines |
| `ground` | `gradient` | cream at the top, blush at the foot |
| `chrome` | `band` | the blush band frames the page |
| `rows` | `cards` | each row its own small card |
| `icons` | `default` | round, friendly 2px lines |
| `labels` | `sentence` | no shouting capitals |
| `tabs` | `folder` | the open tab in rose |
| `composer` | `box` | the composer reads as a chat box |

It sets `character: "kawaii"`, so the header wears the Kawaii character and the file is version 4
(a Collie newer than 1.28.0). A device's own choice in Settings → Appearance → Mark still wins.
