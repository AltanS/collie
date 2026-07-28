# 0002 — The light terminal mirror is inverted, not re-themed

- **Status:** Accepted
- **Date:** 2026-07-28
- **Shipped in:** 0.18.0
- **Trail:** measurements below were taken against live panes on 2026-07-28; the counts and contrast
  figures are reproducible with the method each one names

## Context

Adding light mode meant deciding what the pane mirror does. The obvious answer, and the one this
work carried for most of its life, was: give the mirror a light ANSI palette. Define
`--ansi-0…15` twice — VS Code's Dark+ set for dark, its light-theme set for light — have
`lib/ansi.ts` emit `var(--ansi-N)` instead of literal hex, and let CSS swap them. That was built and
tested before anyone measured whether it would matter.

It doesn't, much. Counting SGR forms in four live panes:

| pane | truecolor (`38;2`) | 256-colour (`38;5`) | basic (`30–37`) | bright (`90–97`) |
| --- | --- | --- | --- | --- |
| w2Z:p1 | 446 | 7 | 0 | 0 |
| wJ:p1 | 150 | 6 | 0 | 0 |
| w14:p1 | 461 | 6 | 0 | 0 |
| w18:pD | 109 | 6 | 0 | 0 |

**Zero basic and zero bright codes anywhere.** Claude Code emits truecolor almost exclusively, and
truecolor names an absolute sRGB value — there is no palette slot to redirect. The 16 themeable
slots the design was built around are very nearly unreachable in practice.

The consequence on a white ground was measured on a real pane: of 13 distinct rendered colours,
eight fell below 3:1, including a `●` at **1.0:1** (`#ffffff` on white) and Monokai's foreground
`#f8f8f2` at **1.07:1**. A light mirror built the obvious way is not a dimmer light mirror; it is an
unreadable one.

This is faithful, incidentally. Run the same agent in a real light terminal and it looks equally
bad, because the agent chose its colours assuming a dark background. Fidelity is not the goal — the
mirror is the app's primary reading surface.

Three ways out were considered. Keeping the mirror dark works and is what an IDE does with an
embedded terminal, but it puts a permanent dark slab in a light app. Clamping absolute colours to a
luminance floor misrepresents what the program actually emitted, and the mapping is arbitrary.
Neither preserves the syntax highlighting an agent's output depends on to be scannable.

## Decision

**Render the mirror in dark space under every theme, and invert it in light.** The `<pre>` carries
`filter: invert(1) hue-rotate(180deg)`, reset to `none` under the `dark:` variant. The `hue-rotate`
is what makes this more than a negative: it approximately restores hue after the inversion flips
lightness, so green stays green and syntax highlighting survives.

Three rules follow, and all three are load-bearing:

1. **Everything inside the `<pre>` is authored for a dark ground** — the ANSI palette, the
   find-match highlight, the muted rule glyphs. A `dark:` variant inside the mirror is a bug: it
   tracks the root theme, which is exactly backwards in inverted space.
2. **Colours inside the `<pre>` are literals, not theme tokens.** `color-scheme: dark` on the
   element does *not* flip an inherited `light-dark()` token — Chrome resolves those against the
   root's scheme — so `bg-background` yields white on a light page and the filter turns it black.
   Tokens cannot express "dark-space regardless of theme"; literals can.
3. **The filter is scoped to the `<pre>` alone.** The interactive blocks (prompt-select, wizard,
   preview, multi-select) are siblings, not children, so they keep normal app theming.

`--ansi-0…15` therefore has **one** set of values, the dark one. `lib/ansi.ts` still emits
`var(--ansi-N)` rather than literal hex: the variables remain the seam where indexed colour is
defined once, and both spellings of an indexed colour (`31m` and `38;5;1`) route through them.

## Consequences

Measured on the same pane, light against dark, sampling rendered pixels:

| | background | min | median | max |
| --- | --- | --- | --- | --- |
| dark (unchanged) | `#0a0a0a` | 1.34 | 7.46 | 21.0 |
| light (inverted) | `#f5f5f5` | 1.43 | 6.73 | 18.69 |

The light profile tracks the dark one almost exactly — light mode inherits whatever readability the
agent designed for, instead of fighting it. (The sub-2 values are antialiasing edges, present in
both.)

What it costs:

- **Colours are approximations.** `hue-rotate` is a linear matrix, not a true hue rotation, so
  saturated colours shift. The mirror shows an agent's palette *interpreted*, not reproduced.
- **A trap for future contributors.** Every instinct — use the token, add a `dark:` variant — is
  wrong inside the `<pre>`, and wrong in a way that type-checks and often still passes a
  computed-style test. `components/ansi-output.test.tsx` guards rules 1 and 2 explicitly.

  The sharpest edge is **cancelling the filter**, which the find highlight does so its yellow isn't
  reinterpreted as brown. Re-applying `invert + hue-rotate` cancels it — but only for colours the
  element sets *itself*. The current match gets away with it because `text-black` pins its text
  (black → invert → white → invert → black). Applying the same cancellation to a non-current match,
  which sets no text colour, sent its *inherited* text light → dark → light and rendered it
  invisible on its own highlight. It looked symmetrical and was not. Cancel the filter only on an
  element that fully specifies its own foreground and background.
- **The light ANSI palette was deleted.** VS Code's light terminal set was chosen, verified against
  upstream (including catching that `ansiGreen` had moved from `#00BC00` to `#107C10`), and then
  made unreachable by this decision. It is in the git history if the premise ever changes.
- **Unmeasured scroll cost.** A CSS filter over a long `<pre>` — panes run to thousands of lines —
  has not been profiled on a phone.

**What would justify revisiting this:** agents emitting indexed colour again, or a terminal palette
protocol that lets the client supply the ground. Either restores the premise that a re-themed
palette can work, and the honest answer then is a real light palette, not a filter. A measured
scroll regression on a mid-range phone would also reopen it — in favour of keeping the mirror dark,
not of re-theming it.
