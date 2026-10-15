# The Nightwatch mark: a horned owl

`nightwatch.tsx`, the header mark of the theme Nightwatch (M57 spec 10). The palette it sits on is
in `web/src/themes/nightwatch.notes.md`.

## The story

Nightwatch is the theme for the on-call phone in bed: a true black page, one dim amber, quiet
status colours. The animal that keeps a night watch is the owl. It sits still for hours, it sees in
the dark, and when something moves it turns its head and looks, without a sound. That is the job of
the header mark in this theme: to sit still while all is well, to look about while the app is
working, and to sleep when the link is gone. A fox, a bat and a cat were the other candidates. The
bat hangs upside down and reads as a glyph, not a face, at 24 px. The cat and the fox say "night"
less clearly than the owl, and neither has the one feature that carries this mark: two round eyes
that shine.

It is a horned owl (ear tufts), for two reasons. The tufts make the silhouette read as an owl at
24 px, where a round head alone reads as a ball. And the tufts can lift and lie flat, which gives
the loading and the lost states a second sign beside the eyes. The owl is drawn to glow quietly on
true black: a line of ink round a dim mass (the ink mixed at 14 percent into the paper), so most of
the figure sits close to the page. The light comes from the eyes in the theme's primary and from a
thin ring behind the head that breathes while the app works. The dog is a solid silhouette; the owl
is mostly dark, which is the point of the theme.

## The three states

| state   | what it shows | motion |
| ------- | ------------- | ------ |
| idle    | sitting on a branch, eyes open in a pale amber, a very faint ring behind the head | head drift of two degrees in all over 48 s; a blink at 24.4 s and 51.9 s of a 61 s loop (gaps 27.5 s and 33.6 s) |
| loading | eyes and ring in the full primary, tufts raised, a soft glow behind the head | ten elements on one 1.8 s clock (below) |
| lost    | head sunk 5 units and dipped 3 degrees, tufts lying flat, eyes shut (two lids), no ring and no glow, ink in `--muted-foreground` | none |

Nothing reacts to typing. Idle is two loops at 48 s and 61 s, and the drift is one degree either
side of rest.

## Keyframes

Every name starts with `cm-`, so the header's rate ramp (`collie-home.tsx`) collects and throws the
loading motion. Every loading loop is 1.8 s and starts and ends on the rest pose, so a round of the
ramp (mean rate 1 over 1.8 s) lands where it began and nothing snaps when the round ends.

| keyframe       | duration | on                    | what it moves |
| -------------- | -------- | --------------------- | ------------- |
| `cm-nw-halo`   | 1.8 s    | `.nw-halo` (ring)     | opacity .28 to .85, scale .94 to 1.02, about the head |
| `cm-nw-glow`   | 1.8 s    | `.nw-glow` (gradient) | opacity .2 to .85, peak at 60 percent, after the ring |
| `cm-nw-squash` | 1.8 s    | `.nw-body`            | squash 1.035 by .955 at 38 percent, stretch .985 by 1.025 at 62, from the feet |
| `cm-nw-bob`    | 1.8 s    | `.nw-lift` (the head's carrier) | down 2.4 units with the squash, up 1.8 with the stretch |
| `cm-nw-turn`   | 1.8 s    | `.nw-head`            | rotate -6 degrees at 28 percent, +6 at 68, about the neck |
| `cm-nw-face`   | 1.8 s    | `.nw-face`            | slide 3.5 units left at 24 percent, right at 64 (the turn, seen from the front) |
| `cm-nw-look`   | 1.8 s    | `.nw-pupil` (both)    | the pupils lead: 2.4 units left at 14 percent, right at 54 |
| `cm-nw-tuft-l` | 1.8 s    | `.nw-tuft-l`          | lifts 12 degrees and 8 percent longer at 20 and 60 percent |
| `cm-nw-tuft-r` | 1.8 s    | `.nw-tuft-r`          | the same, mirrored, 6 percent later |
| `cm-nw-drift`  | 48 s     | `.nw-head` at rest    | +1 degree at 25 percent, -1 at 75 |
| `cm-nw-blink`  | 61 s     | `.nw-eye-l`, `.nw-eye-r` at rest | each eye to 12 percent height for about 0.3 s, twice a loop |

The stagger is the design: the eyes look first, the face follows, the head follows the face, the
tufts lift twice a turn, the body squashes and the head rides it. Nine classes, ten elements.

## Colour

- `--cm-a1` defaults to `var(--primary)`: the irises, the ring and the glow.
- `--cm-a2` defaults to `var(--ring)`: the rim round each iris. In Nightwatch `ring` is a step
  darker than `primary`, which gives the eye depth at 64 px.
- At rest both are mixed 70 percent with `--muted-foreground` (lower chroma); while loading they are
  the tokens themselves. That rise is the "working" sign a reduced-motion reader still gets.
- Ink is `currentColor`. Lost sets `color: var(--muted-foreground)` on the root, so every stroke and
  the mass follow it. The knockout (sockets, pupils) is `var(--cm-paper)`, set from `paper`.
- An imported theme that names `mark: "nightwatch"` recolours the owl through its own `primary`,
  `ring` and `muted-foreground`.

## Reduced motion

`@media (prefers-reduced-motion: reduce)` sets `animation: none !important` on all eleven animated
classes. Loading then shows a still pose that still differs from idle: the full primary in the eyes,
the ring at .6, the glow at .6, and the tufts raised 8 degrees. Lost has no animation either way.

## Size and markup

- 12,677 bytes of source (the dog is 70,516). No SMIL, no image, no network, no library.
- One `<svg>`: `<style>`, an optional `<title>`, one `<radialGradient>` whose id comes from
  `useId`, and the drawing. `header` weight crops to the drawing (`1 -2 98 98`, room for a lifted
  tuft); `full` gives it air (`-14 -16 128 128`).
- `cm-live` on the root while loading, so `markIsLive` and the hosts read the state as they do for
  the dog. The idle and lost classes sit on the inner group, so `className` stays the caller's.

## Checked in a browser (2026-10-16, playground on 127.0.0.1, Chromium)

- `getAnimations({ subtree: true })` on the loading owl returns ten `cm-nw-*` animations;
  `updatePlaybackRate(2.27)` takes on the next frame, and back to 1. Idle returns three (drift 48 s,
  blink 61 s twice); lost returns none.
- Under emulated `prefers-reduced-motion: reduce` the loading owl runs no animation.
- Shots: `experiments/theming/shots/10-nightwatch-*.png` in the workspace (40 px in each state and
  half, 24 and 64 in the two `all` shots, a blink frame, a reduced-motion pass, loading frames at
  110 px and at 24 px).
