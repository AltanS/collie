# Daylight mark: a hare in the sun

## Why a hare

Daylight is the theme for direct sun and for low vision. Its animal has to be one you meet in full
day, in the open, with a reason to watch. The brown hare is that animal. It lives on open fields with
no cover, it does not hide in a burrow, and it stays alive by seeing first: its eyes sit high and to
the side of the head and see almost all the way round. It sits up, ears high, and watches. That is
what the mark does in the header: it keeps watch while you work.

The hare also wins on shape. The brief asks for a mark that reads at 24 px in sun, and the hare has
the strongest silhouette of the candidates: two long upright ears, a round haunch and a straight
foreleg, all solid. A kestrel needs fine wing tips and a lizard is a thin line on a stone; both turn
to noise at 24 px. The hare is one filled shape with two knockout lines, and its ears carry every
state on their own: up while it rests, up and twitching while it works, flat when it is gone.

## States

| state   | pose                                         | colour                                   | motion                        |
| ------- | -------------------------------------------- | ---------------------------------------- | ----------------------------- |
| idle    | sits upright, ears up, eye open              | ink; pale sun at 55 percent, no rays; short shadow | the near ear flicks once every 20 s |
| loading | the same seat, a ready bounce                | ink; full sun with eight rays; shadow    | seven loops, see below        |
| lost    | hunched, head turned away, ears laid back, no eye | `--muted-foreground`; no sun, no shadow | none                          |

`cm-live` is on the root `<svg>` while loading, as on the dog, because the hosts and their tests ask
the root (`test/collie-mark.ts`).

## Keyframes

All names start with `cm-dl-`, so the header's rate ramp (`collie-home.tsx`, `collect()`) picks them
up, and no rule can touch the dog or another mark on the same page.

| keyframe        | class           | duration | timing      | what it moves                                                        |
| --------------- | --------------- | -------- | ----------- | -------------------------------------------------------------------- |
| `cm-dl-flick`   | `.cm-dl-flick`  | 20 s     | ease-in-out | idle only. The near ear, still for 95 percent, then -18, 6, -8 degrees and back in 0.8 s |
| `cm-dl-day`     | `.cm-dl-day`    | 1.8 s    | linear      | the sun, about (32, 64): 20 to 60 degrees, a jump to -60 out of frame, back to 20. 120 degrees per round at one speed |
| `cm-dl-swing`   | `.cm-dl-swing`  | 1.8 s    | linear      | the cast shadow: shear -24 to -72 degrees and from 72 back to -24 (the sun's angle times -1.2), fading out and in round the jump |
| `cm-dl-pulse`   | `.cm-dl-pulse`  | 0.6 s    | ease-in-out | the rays, scale 1 to 1.22 and back, three times a round               |
| `cm-dl-bounce`  | `.cm-dl-bounce` | 0.9 s    | ease-in-out | the whole hare about its feet: squash (1.06, 0.9), stretch (0.97, 1.05), twice a round |
| `cm-dl-twitch`  | `.cm-dl-twitch` | 1.8 s    | ease-in-out | the near ear, -11 and 4 degrees early in the round                    |
| `cm-dl-perk`    | `.cm-dl-perk`   | 1.8 s    | ease-in-out | the far ear, -13 and 5 degrees in the second half, so the ears never move together |
| `cm-dl-look`    | `.cm-dl-look`   | 1.8 s    | ease-in-out | the pupil: forward, back toward the sun, up, forward                  |

Loading runs seven loops on seven elements. Each one starts and ends where it began, and every
duration is the 1.8 s round or a whole fraction of it, so one round of the ramp ends where it
started. At the first frame of loading the sun stands where idle has it, so the change from idle
does not jump.

The shadow is the silhouette itself (a `<use>` of the body and both ears at rest), flipped and
flattened to 0.14 onto the ground at y 56 and sheared away from the sun, like a sundial running fast.
The sun sits behind the hare and passes behind the ears; a 5 unit halo in `--cm-paper` round the body
and a 2.5 unit edge on each ear keep the ears clear of the disc.

## Accents

| variable  | default              | draws                                                      |
| --------- | -------------------- | ---------------------------------------------------------- |
| `--cm-a1` | `var(--primary)`     | the cast shadow, at 45 percent                              |
| `--cm-a2` | `var(--syntax-entity)` | the sun disc and its rays                                |

Ink is `currentColor`; the knockout (eye, thigh line, ear edges, halo) is `--cm-paper`, the `paper`
prop. `--syntax-entity` is Daylight's gold (L 0.46 light, 0.84 dark), the one token in the theme that
reads as sun and carries no status meaning. A status colour was ruled out: the orange of blocked
beside the lost badge would say "needs you". Daylight's `--primary` is near black in light and near
white in dark, so at 45 percent the shadow is a clear grey in both. An imported theme that names
`mark: "daylight"` recolours both through its own tokens.

## Reduced motion

`@media (prefers-reduced-motion: reduce)` sets `animation: none !important` on all eight classes
above. The pose and the colour stay, so loading still differs from idle without motion: a full sun
with rays and a shadow against a pale bare sun. Lost has no loop to stop. The header's ramp collects
nothing under reduced motion, as for the dog.

## Weights and ids

`header` frames the 64 unit drawing as `0 -3 64 64` (three units of sky above the ear tips, room for
the rays at rest); `full` frames the same drawing with ten more units on each side, `-10 -13 84 84`.
There is one drawing; nothing is dropped or thickened per weight, because nothing in it is thinner
than 2.5 units. Per-instance ids come from `useId` for the two `<use>` targets (the body, and the
silhouette the shadow reuses).

## Bytes and rules

- `daylight.tsx`: 10,940 bytes of source. The dog is 70,516.
- CSS keyframes inside the svg's own `<style>` only. No SMIL, no `<image>`, no raster, no network,
  no animation library. No text in the drawing.
- At 24 px the eye is about 2 px across, the ears about 2 px wide, and every knockout line about
  1 px. Checked in the playground gallery at 24, 40 and 64, light and dark, all three states, with
  reduced motion on and off.
