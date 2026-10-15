# Harbour mark: notes

The header mark of the theme `harbour` (M57 spec 10). The code is `harbour.tsx`; this file holds
the reasons. The rules are the dog's (`components/collie-mark.tsx`) and `contract.ts`.

## The story

Harbour is the theme for people who come from terminal and editor culture: cool blue-grey water,
one teal accent, calm. The animal of a harbour is a sea otter. It lives where the boats are, it
floats on its back at rest, and it is the one harbour animal that plays with a tool: it keeps a
favourite stone and juggles it, cracks shells on its chest, spins what it holds. That gives the
three states their pictures without inventing anything: rest is floating, work is juggling the
stone, gone is a dive.

Seals and gulls were the other candidates. A seal floats too, but it does not handle things, so its
"working" would be a balancing ball, which is a circus trick and not a harbour. A gull only flies or
stands; at 24 px it is a "v". The otter is the playful one Altan asked for: its loading state is a
toy in its paws, not a machine turning.

## States

| state   | what it draws | motion | colour |
| ------- | ------------- | ------ | ------ |
| idle    | the otter on its back, the stone on its chest, two lines of water | a rise and fall of 0.7 units with a 0.8 degree rock, 7.2 s per swell; a hind paw twitches once every 28.8 s (about 1.4 s of it) | stone and water at a quieter mix of their tokens |
| loading | the same otter juggling the stone: a high throw and a low one per 1.8 s | ten parts on one 1.8 s clock (below); squash at each catch, stretch at each throw | stone at full `--primary`, water at full `--status-info` |
| lost    | the otter has dived: the tip of its tail above the water line, two rings, two bubbles | none | all ink is `var(--muted-foreground)`; no accent |

Under reduced motion every animation stops and the loading state shows a still pose that still
reads as working: the stone is up in the air, the paws are raised, the head looks up, the ripple
ring shows and the accents are at full colour. Idle shows the otter at rest; lost is still anyway.

The idle swell is 7.2 s, not the dog's 48 s drift, because the spec asks for "a small rise and fall
at 6 to 8 s". It moves 0.7 of 64 units: 0.35 px at 40 px and 0.26 px at 24 px, under one device
pixel on most phones. Nothing reacts to typing; nothing in the contract lets it.

## Keyframes

Every name starts with `cm-` so the header's rate ramp (`collie-home.tsx`) collects and throws the
round the same way it throws the dog's orbit. A round ramps from rate 0 through 2.27 back to 0 with
a mean of 1, so one round covers exactly one juggle cycle: the throw starts slow, peaks and settles.

| keyframe        | duration | element        | what it moves |
| --------------- | -------- | -------------- | ------------- |
| `cm-hb-float`   | 7.2 s    | `.hb-otter`    | idle: the whole otter down 0.7 units and back, rocked 0.8 degrees |
| `cm-hb-twitch`  | 28.8 s   | `.hb-foot`     | idle: the hind paw flexes three times at 61 to 66 per cent, still the rest of the cycle |
| `cm-hb-toss`    | 1.8 s    | `.hb-pebble`   | the stone up 18 units and down, then up 10 and down; scale 1.26 x 0.74 at the catch, 0.84 x 1.2 at the throw; each segment has its own easing (slow at the top, fast at the bottom) |
| `cm-hb-spin`    | 1.8 s    | `.hb-spin`     | the stone turns 360 degrees in the high throw and 180 in the low one (an ellipse, so 540 loops clean) |
| `cm-hb-flick`   | 1.8 s    | `.hb-paws`     | the paws dip before each throw, flick up, reach for the catch, give under it |
| `cm-hb-look`    | 1.8 s    | `.hb-head`     | the head tips back 9 degrees to follow the high throw, 5 for the low one |
| `cm-hb-dip`     | 1.8 s    | `.hb-otter`    | the whole otter sinks 0.9 units at the high catch and 0.6 at the low one |
| `cm-hb-squash`  | 1.8 s    | `.hb-body`     | the body squashes to 1.035 x 0.92 at the high catch, then a small stretch back |
| `cm-hb-kick`    | 1.8 s    | `.hb-foot`     | the hind paw kicks five times a cycle, harder at the catches |
| `cm-hb-slap`    | 1.8 s    | `.hb-tail`     | the tail lifts 16 degrees before the high catch and slaps down on it; smaller for the low one |
| `cm-hb-roll`    | 1.8 s    | `.hb-wave`     | both water lines roll two wavelengths (12 units) to the left |
| `cm-hb-ring`    | 1.8 s    | `.hb-ripple`   | a ring on the water widens from each catch and fades |

Loading moves ten separate elements (otter, body, head, paws, stone, stone spin, foot, tail, water,
ripple). Idle moves two. Lost moves none.

## Drawing

- Ink is `currentColor`: head, body, paws, foot, tail. The knockout is `var(--cm-paper)`: the ring
  around the stone, the eye, and a band under the front water line so the body reads as in the water.
- The muzzle is a mix of 30 per cent ink into the paper, so it reads as a lighter face in light and
  as a darker one in dark without a third colour.
- The body is clipped at the water line (a per-instance `clipPath`), so it can rise and dip into the
  water. The water lines fade out at both ends through a per-instance `mask`. Both ids come from
  `useId`, because ids in an inline SVG are document-scoped.
- `header` weight: the same drawing in a 48 unit frame (`7 6 48 48`) instead of the full 64, and the
  front water line at 2.1 units instead of 1.6. Below 32 px the faint second water line is not drawn.
- The drawing is JSX, not an `innerHTML` string. A header re-render keeps the same nodes, so a
  running animation is never restarted (the trap the dog's comments describe).
- In the header the lost badge sits in the bottom right corner of the box; the tail tip is drawn left
  of centre so the badge never covers it.

## Accents

| variable   | idle | loading | lost |
| ---------- | ---- | ------- | ---- |
| `--cm-a1` (the stone) | `color-mix(in oklab, var(--primary) 72%, var(--cm-paper))` | `var(--primary)` | not drawn |
| `--cm-a2` (the water) | `color-mix(in oklab, var(--status-info) 55%, var(--cm-paper))` | `var(--status-info)` | water uses the muted ink |

The default tokens are `--primary` (Harbour's teal, hue 190) and `--status-info` (Harbour's blue,
hue 225). Both are theme tokens, so the mark recolours with any imported theme that names
`harbour` as its mark. The names match the dog's (`--cm-a1`, `--cm-a2`, `--cm-paper`), so the test
helpers in `test/collie-mark.ts` read this mark the same way.

## Reduced motion

`@media (prefers-reduced-motion: reduce)` sets `animation: none !important` on `.hb-otter`,
`.hb-body`, `.hb-head`, `.hb-paws`, `.hb-pebble`, `.hb-spin`, `.hb-foot`, `.hb-tail`, `.hb-wave` and
`.hb-ripple`: every class that carries an animation. `marks/contract.test.tsx` checks it by running
each animated selector against each rendered state and asking whether every element it hits is also
hit by the reduced-motion rule.

## Size

`harbour.tsx`: 14,549 bytes of source (budget 40,960; the dog is 70,516). No SMIL, no image, no
network, no animation library.
