# 0047 — Muse panes render natively: no light-theme inversion

- **Status:** Accepted (2026-09-14)
- **Date:** 2026-09-14
- **Shipped in:** 1.9.1
- **Amends:** [0002](0002-invert-the-light-terminal-mirror.md) — narrows "every mirror inverts in
  light" with the per-agent exception 0002 reserves ("one bit is all the mirror needs").
- **Trail:** every figure is WCAG relative luminance against the `#f5f5f5` light ground,
  computed from live PTY captures of `muse` 1.2.1 (issue #220). Palette values below are
  observed, all three background answers — including the no-answer fallback an older Herdr
  leaves, since 0.9.0 answers OSC 10/11 from its theme (Context, below).

## Context

ADR 0002 inverts the light mirror on the premise that agents emit dark-theme colours, and
records the failure mode honestly: an agent on a light theme is unreadable in both Collie
themes, and the fix "if wanted, is a per-pane 'don't invert this one'". Muse is that pane —
with a milder premise than 0002's worst case, which is exactly why it went unnoticed.

Muse adapts its palette to the background it probes, but every answer is mid-tone:

| background answer | body | secondary | hints |
| --- | --- | --- | --- |
| light (live: Herdr 0.9.0, light theme) | `56,58,66` | `121,122,128` | `175,176,180` |
| dark | `117,120,129` | `100,103,110` | `82,84,90` |
| none (older Herdr) | `111,114,122` | `94,97,104` | `75,77,82` |

The live row is confirmed by pane.read, not inferred: Herdr 0.9.0 wires write_pty, so it
answers OSC 10/11 from its theme — HERDR_API.md's "answers neither" probe (2026-07-29)
predates the wiring and is stale at 0.9.0. A dark Herdr theme yields the dark row; only
older Herdr yields the no-answer fallback. Accents in all three sit beside the greys
(pink, orange); backgrounds are transparent throughout.

Inversion maps the live ramp to ~1.6 / ~3.4 / ~7.4 : 1 on white — note the order: the
hints land readable while the body vanishes, an inverted hierarchy. The same bytes
rendered raw — as any light terminal shows them — resolve to ~10.4 / ~3.9 / ~2.0 : 1,
the authored weights (body first, hints a whisper, exactly as the desktop TUI shows).
So unlike the bright truecolor 0002 measured (white at 1.07:1 raw), Muse's tones are
readable raw and broken inverted: the inversion is not preserving this agent's
contrast, it is spending it. Saturated accents survive either way (hue-rotate), which
is why only the grey body text looks wrong. The dark rows behave the same direction:
3.0→4.4, 2.4→5.7, 1.9→7.8.

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
  spelling per the mirror convention) and drops `MIRROR_INVERT`, gated by the shared
  native-mirror predicate (`rendersNativeMirror`, one exact-strings set). The `dark:`
  halves on that element are correct — it follows the root theme like any uninverted
  surface — where 0002's NEVER rule still governs every inverted mirror.
- The one tone raw rendering would lose — bright foregrounds, near-white at luminance
  0.85+ against an observed non-white ceiling of 0.44 — is marked by a display pass
  (`harness/muse/display.ts`, threshold 0.6, gamma-correct) and resolved dark through a
  custom property only the light theme defines. Dark keeps the emitted colour untouched.
  Bare spans inherit the dark default; explicit fg+bg pairs render as authored.
  Palette-indexed spellings (`37m`, `97m`, `38;5;15`) join the same rule through the
  pinned slot set {3, 7, 11, 15} — the slots above 0.6 as the stylesheet stands, with a
  test re-resolving every slot from index.css so a retune fails loudly.
- Muted chrome resolves through the same mechanism with its own property: `styleFor`
  keeps the dark-space grey as the var() fallback, and the light theme defines
  `--terminal-muted-fg` to `--muted-foreground`'s light half (`#5d5d5d`, oklch(0.48)).
  Inverted mirrors never define the property, so their muted spans resolve exactly as
  today.
- The find highlight's current match drops its cancelling re-inversion on these panes:
  with no outer filter there is nothing to cancel, and re-applying it would blue-shift
  the yellow in light.

## Consequences

Same bytes, Muse pane, light theme, before → after:

| span (live light palette) | inverted (now) | native (new) |
| --- | --- | --- |
| body `56,58,66` | 1.6 | 10.4 |
| secondary `121,122,128` | 3.4 | 3.9 |
| hints `175,176,180` | 7.4 | 2.0 — authored subtlety, MBP-identical |
| near-white (marked → `#0a0a0a`) | ~15 | 18.2 |
| muted `#a1a1a1` (rule → `#5d5d5d`) | 5.95 | 6.0 |

What it costs:

- **The `dark:` halves on a mirror element look like the 0002 violation they are not.**
  The NEVER rule exists because `dark:` is backwards in inverted space; this surface is
  never inverted. The comment on `MUSE_MIRROR` says so, and the className tests pin both
  halves.
- **Light-palette bytes stay dim in Collie's dark theme** — the pre-existing 0002
  limitation class (agent-on-light is dim on dark). Verified terminal-faithful in a
  headless render: dark shows exactly what a dark terminal shows for these bytes, pixel
  for pixel with the old path. Fixing that class (a light ground in dark mode) is out
  of scope.
- **The 0.6 threshold is pinned to observed values — and each pin names its failure.**
  If Muse retunes a ramp past the line, the display tests fail naming the colour; if a
  stylesheet retune moves a slot across it, the slot test fails naming the slot; if the
  light-gated rules are deleted, the stylesheet tests fail naming the selector. Nothing
  in this mechanism can wash out silently.
- **An OS reporting no colour-scheme preference falls back to raw brights.** The
  light-gated rules need `prefers-color-scheme: light` (or a pinned light root); on
  `no-preference` the ground still follows the app's own light default while bright
  spans keep their emitted colour. Every current phone and desktop OS reports light or
  dark, so this is a documented corner, not a supported configuration.

What would justify revisiting:

- **A second agent wanting the bit** — add one exact string to `NATIVE_MIRROR_AGENTS`,
  with that agent's own measurements justifying it.
- **A real Muse adapter** — if one registers, its statusline strip (which stays
  inverted) and this display pass need one decision between them; the pass applies to
  raw blocks already, so the strip is the only open half.
