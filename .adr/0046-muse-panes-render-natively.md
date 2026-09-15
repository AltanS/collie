# 0046 — Muse panes render natively: no light-theme inversion

- **Status:** Proposed
- **Date:** 2026-09-14
- **Shipped in:** _(set at the release commit)_
- **Trail:** every figure is WCAG relative luminance against the `#f5f5f5` light ground,
  computed from live PTY captures of `muse` 1.2.1 (issue #220). Palette values below are
  observed, all three background answers plus the no-answer fallback Herdr panes carry
  (Herdr answers neither OSC 10 nor OSC 11 — HERDR_API.md, live-probed 2026-07-29).

## Context

ADR 0002 inverts the light mirror on the premise that agents emit dark-theme colours, and
records the failure mode honestly: an agent on a light theme is unreadable in both Collie
themes, and the fix "if wanted, is a per-pane 'don't invert this one'". Muse is that pane —
with a milder premise than 0002's worst case, which is exactly why it went unnoticed.

Muse adapts its palette to the background it probes, but every answer is mid-tone:

| background answer | body | secondary | hints |
| --- | --- | --- | --- |
| none (Herdr) | `111,114,122` | `94,97,104` | `75,77,82` |
| dark | `117,120,129` | `100,103,110` | `82,84,90` |
| light | `56,58,66` | `121,122,128` | `175,176,180` |

No-answer ≈ dark, as HERDR_API.md predicts for a harness that falls back. Accents in all
three sit beside the greys (pink `189,72,186`, orange `193,132,1`); backgrounds are
transparent throughout.

Inversion maps the Herdr-fallback ramp to ~3.0 / ~2.4 / ~1.9 : 1 on white. The same bytes
rendered raw — as any light terminal shows them — resolve to ~4.4 / ~5.7 / ~7.8 : 1. So
unlike the bright truecolor 0002 measured (white at 1.07:1 raw), Muse's tones are readable
raw and broken inverted: the inversion is not preserving this agent's contrast, it is
spending it. Saturated accents survive either way (hue-rotate), which is why only the
grey body text looks wrong.

Three exits are already closed, two by 0002 itself: clamping absolute colours to a
luminance floor ("an arbitrary mapping that misrepresents what the program emitted"),
per-harness colour maps ("breaks silently when a harness retunes a colour"), and a full
harness adapter — registering one would also flip Muse's reply path off one-shot sends, a
behavioural change a display fix must not smuggle in. What 0002 prescribes instead is one
bit of per-harness knowledge — "authored for dark/light" — and "one bit is all the mirror
needs". This is that bit, with the polarity the measurements dictate: Muse panes do not
invert.

## Decision

**Muse panes render natively in light: page ground, no inversion filter.** Dark is
untouched (dark-space halves, no filter — identical pixels to today).

- The `<pre>` takes the page ground and a dark default in light
  (`bg-[#f5f5f5] text-[#0a0a0a]`, the `--background`/`--foreground` light halves, one
  spelling per the mirror convention) and drops `MIRROR_INVERT`, gated on the exact
  agent string. The `dark:` halves on that element are correct — it follows the root
  theme like any uninverted surface — where 0002's NEVER rule still governs every
  inverted mirror.
- The one tone raw rendering would lose — bright foregrounds, near-white at luminance
  0.85+ against an observed non-white ceiling of 0.44 — is marked by a display pass
  (`harness/muse/display.ts`, threshold 0.6, gamma-correct) and resolved dark through a
  custom property only the light theme defines. Dark keeps the emitted colour untouched.
  Bare spans inherit the dark default; explicit fg+bg pairs render as authored.
- The find highlight's current match drops its cancelling re-inversion on these panes:
  with no outer filter there is nothing to cancel, and re-applying it would blue-shift
  the yellow in light.

## Consequences

Same bytes, Muse pane, light theme, before → after:

| span | inverted (now) | native (new) |
| --- | --- | --- |
| body `111,114,122` | 3.0 | 4.4 |
| secondary `94,97,104` | 2.4 | 5.7 |
| hints `75,77,82` | 1.9 | 7.8 |
| near-white (marked → `#0a0a0a`) | ~15 | 18.2 |

What it costs:

- **The `dark:` halves on a mirror element look like the 0002 violation they are not.**
  The NEVER rule exists because `dark:` is backwards in inverted space; this surface is
  never inverted. The comment on `MUSE_MIRROR` says so, and the className tests pin both
  halves.
- **Indexed brights are uncovered.** The mark reads `rgb()` literals only; a bright
  `var(--ansi-7/15)` would render raw white on white. Muse emits no indexed foregrounds
  in the observed corpus (cube/ramp `38;5` arrive as `rgb()`), so this is a documented
  edge, not a live one.
- **Light-palette bytes stay dark-on-dark in Collie's dark theme** — the pre-existing
  0002 limitation class (agent-on-light unreadable in dark). Out of scope: the Herdr
  path carries the dark fallback, and nobody has measured the light palette in a pane.
- **The 0.6 threshold is pinned to observed values.** If Muse retunes past it, the
  display tests (which pin the captured ramps) fail loudly rather than washing out
  silently.

What would justify revisiting:

- **A second agent wanting the bit** — generalise `rendersNativeMirror` into the list
  it already is, one exact string per row, with that agent's own measurements.
- **A real Muse adapter** — if one registers, its statusline strip (which stays
  inverted) and this display pass need one decision between them; the pass applies to
  raw blocks already, so the strip is the only open half.
