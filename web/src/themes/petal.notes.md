# Petal: the palette and why

Petal shows how soft Collie can look. It is pastel pink and lavender on a cream page in light, and a
deep plum night in dark. Altan asked for a theme that changes what a screen looks like at a glance,
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
| `background` | 0.975 0.014 70 | 0.2 0.04 330 | cream, plum night |
| `card` | 0.988 0.005 350 | 0.26 0.05 330 | a pink-white card, a raised plum |
| `chrome`, `secondary` | 0.95 0.028 340, 0.945 0.03 330 | 0.26 0.05 330, 0.3 0.055 315 | the blush band behind the header and bars |
| `primary` | 0.56 0.17 352 | 0.82 0.1 352 | rose, and pastel pink in dark |
| `control-on` | 0.88 0.06 305 | 0.38 0.09 305 | lavender |
| `foreground` | 0.3 0.07 340 | 0.95 0.018 340 | plum ink, pink-white ink |

- The page is cream (hue 70) and not pink. With the gradient ground the foot of the page mixes
  in 12% of the rose primary, so the page warms from cream to blush toward the bottom bar.
- Body text: light 13.1 on the page, 11.2 at the gradient foot; dark 15.7 and 13.0.
  Muted text: light 6.6 on the page, 5.7 at the foot; dark 9.6 and 8.0.
- Text on the primary: light 4.94, dark 9.67. The light rose is the darkest pink that still reads
  as pink; a lighter one fails white text.
- `tab-active` equals `primary` in both halves, so the open folder tab wears a rose top edge.
  It measures 4.74 light and 10.0 dark on the page (floor 3).
- `rule` 1.59 light and 2.11 dark on the page, 1.36 and 1.75 at the gradient foot (floor 1.3).

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
  chip must clear 4.5 there. The tightest cells are light blocked at the foot (4.63) and dark
  unknown at the foot (4.65).

## Syntax and host

- Syntax: keyword pink 350, string green 160, constant violet 295, property blue 210, entity gold
  80 to 85, comment equal to `muted-foreground`.
- Hosts, in slot order: rose 355, teal 190, violet 300, green 140, orchid 330, blue 240, gold 85,
  indigo 275, sea green 165, lime 115. Light at L 0.47 to 0.48, dark at L 0.76 to 0.84.

## The mirror

The palette is pastel on a near-black plum. The ground is `#140a10`. In light the mirror is turned
over (`invert(1) hue-rotate(180deg)`, ADR 0002), and `#140a10` turned over is `#faf0f6`, a faint
pink white beside the cream page, so the mirror reads as a card and not as a hole. In dark it is a
deeper well under the plum page. Every slot clears its gate by a wide margin: the lowest is slot 8
at 5.9, the ink is 16.5.

## Face

Atkinson Hyperlegible Next for the text (key `atkinson`) and Geist for titles (key `geist`). Each
shipped theme needs its own display face, and only `geist` and `system` were free. Neither is
rounded. The face that would finish this look is a rounded sans, such as Nunito (SIL OFL 1.1): a
Latin plus Latin Extended A subset at weights 400 to 700 is about 35 to 45 KB as one variable woff2.
It is not added: a new face needs the lead's yes.

## The whole sheet (schema version 3)

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

It sets `tab-active`, so the file is version 3. The Kawaii character (`character: "kawaii"`) is
added when the theme-marks branch lands; that key makes the file version 4.
