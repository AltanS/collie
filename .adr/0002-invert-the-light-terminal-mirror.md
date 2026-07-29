# 0002 — The light terminal mirror is inverted, not re-themed

- **Status:** Accepted
- **Date:** 2026-07-28 (revised 2026-07-29)
- **Shipped in:** _(set at the release commit)_
- **Trail:** every figure is measured. Colour-form counts come from live panes read through the
  production path (`pane.read` → `/api/pane/:id`); contrast is rasterized through a canvas to
  resolve `oklch()`/`light-dark()` and composited against the real ancestor stack.

## Context

The obvious light mirror is a light ANSI palette: define `--ansi-0…15` twice, emit `var(--ansi-N)`
from `lib/ansi.ts`, let CSS swap them. This work carried that design for most of its life, built
and tested, before anyone measured whether it would matter.

**Only one of the three colour forms is themeable, and it is the rare one:**

| form | meaning | redirectable by a palette? |
| --- | --- | --- |
| `38;2;r;g;b` | an absolute sRGB value | **no** |
| `38;5;n`, n ≥ 16 | the 6×6×6 cube / greyscale ramp | **no** |
| `30–37`, `90–97`, `38;5;n` n < 16 | one of the 16 palette slots | **yes** |

Both spellings in that third row are the same slot — `31m` and `38;5;1` — and must be counted
together. An earlier revision of this ADR tabulated all of `38;5` as "256-colour", hiding palette
slots inside the unthemeable cube and making the measurement blind to the one harness that uses
them.

**What agents emit**, per harness, TUI output only (shell prompt and MOTD excluded):

| harness | truecolor | 256-cube | **themeable** |
| --- | --- | --- | --- |
| opencode | **100%** (508 seqs) | 0% | **0%** |
| pi | 89% | 5% | 5% |
| claude | 79% | 20% | 1% |
| codex | 7% | 34% | **59%** |

For three of four, truecolor dominates — and truecolor names an absolute value with no slot to
redirect. Codex is the exception; see the Decision.

**Absolute values authored for black are unreadable on white.** Of 13 distinct colours in a real
pane, eight fall below 3:1 on white — including a `●` at **1.0:1** and Monokai's foreground
`#f8f8f2` at **1.07:1**. This is faithful — the same agent looks equally bad in a real light
terminal — but the mirror is the app's primary reading surface, so fidelity is not the goal.

Two other exits, both rejected for losing the syntax highlighting that makes output scannable:
keeping the mirror permanently dark (what an IDE does, but it leaves a dark slab in a light app),
and clamping absolute colours to a luminance floor (an arbitrary mapping that misrepresents what
the program emitted).

## Decision

**Render the mirror in dark space under every theme, and invert it in light.** The `<pre>` carries
`filter: invert(1) hue-rotate(180deg)`, reset to `none` under the `dark:` variant. The `hue-rotate`
is what makes this more than a negative: it approximately restores hue after inversion flips
lightness, so green stays green and syntax highlighting survives.

Three rules follow, all load-bearing:

1. **Everything inside the `<pre>` is authored for a dark ground** — palette, find-match highlight,
   muted rule glyphs. A `dark:` variant inside the mirror is a bug: it tracks the root theme, which
   is backwards in inverted space.

2. **Colours inside the `<pre>` are written as literals — a convention, not a constraint.**
   `color-scheme: dark` on the element *does* flip an inherited `light-dark()` token; resolution is
   element-scoped, per spec (verified in Chromium: with the root pinned light, `--muted-foreground`
   resolves to its light half outside the `<pre>` and its dark half inside). The literals here are
   byte-exact matches for those dark halves, so either would render identically. Literals win
   because they sit beside truecolor nothing can re-theme, and they say at the point of use that
   the value is deliberately theme-independent. What matters is that the mirror does not mix the
   two.

3. **The filter is scoped to the `<pre>` alone.** The interactive blocks (prompt-select, wizard,
   preview, multi-select) are siblings, not children, so they keep normal app theming.

`--ansi-0…15` therefore has **one** set of values, the dark one. `lib/ansi.ts` still emits
`var(--ansi-N)`: the variables remain the seam where indexed colour is defined once, and both
spellings route through them.

### Why codex does not reopen this

Codex is the one harness drawing its chrome from themeable slots, and the one that asks the
terminal what background it is on (`OSC 10`/`OSC 11`). That looks like an argument for re-theming.
It is not: **herdr answers neither query, so codex falls back to dark** — and Collie could not
answer anyway, since it reads a rendered buffer downstream of the PTY. Measurements and
consequences in [`HERDR_API.md`](../HERDR_API.md).

## Consequences

Same pane, light against dark, sampling rendered pixels:

| | background | min | median | max |
| --- | --- | --- | --- | --- |
| dark (unchanged) | `#0a0a0a` | 1.34 | 7.46 | 21.0 |
| light (inverted) | `#f5f5f5` | 1.43 | 6.73 | 18.69 |

Light tracks dark almost exactly — it inherits whatever readability the agent designed for instead
of fighting it. (Sub-2 values are antialiasing edges, present in both.)

What it costs:

- **Colours are approximations.** `hue-rotate` is a linear matrix, not a true hue rotation, so
  saturated colours shift. The mirror shows a palette *interpreted*, not reproduced.
- **Diffs and inverse-video become dark slabs in light.** Legibility survives; only visual weight
  inverts. Greying them is worse.
- **Unmeasured scroll cost.** A CSS filter over a `<pre>` running to thousands of lines has not been
  profiled on a phone.
- **A trap for contributors.** Every instinct — use the token, add a `dark:` variant — is wrong
  inside the `<pre>`, and wrong in a way that type-checks and often passes a computed-style test.
  `components/ansi-output.test.tsx` guards rules 1 and 2.

  The sharpest edge is **cancelling the filter**, which the find highlight does so its yellow isn't
  reinterpreted as brown. Re-applying `invert + hue-rotate` cancels it — but only for colours the
  element sets *itself*. The current match survives because `text-black` pins its text (black →
  invert → white → invert → black). The same cancellation on a non-current match, which sets no
  text colour, sent its *inherited* text light → dark → light: invisible on its own highlight. It
  looked symmetrical and was not. **Cancel the filter only on an element that fully specifies both
  its foreground and its background.**

### Known limitation: an agent on a light theme

The agent's own theme travels **as content, not metadata**. Claude Code under `theme: light` emits
the same 75 sequences and 16 distinct colours as under `theme: dark`, values inverted (foreground
`#333333` rather than `#f8f8f2`). Nothing in the chain carries a theme *field*, so Collie cannot
detect which is in use — and such a pane is unreadable in **both** Collie themes (1.57:1 dark,
1.47:1 light).

**Pre-existing**: the shipped dark-only mirror fails it identically. Recorded because the fix, if
wanted, is a per-pane "don't invert this one" — so any storage added for mirror preferences should
be keyed to let that layer on later.

### Alternatives closed off

- **A light ANSI palette.** Reaches 0–5% of what three of four harnesses emit. The set was actually
  built — VS Code's light terminal palette, verified against upstream (including catching that
  `ansiGreen` moved from `#00BC00` to `#107C10`) — and is in the git history if the premise changes.
- **Set the agent to a light theme and don't invert.** Strictly *more* faithful: colours authored
  for white rather than negated onto it. Rejected only because Collie cannot detect the agent's
  theme, so it cannot know when to suppress the filter. Revisit alongside a per-pane override or a
  reliable detection heuristic.
- **Per-harness colour maps** (translate claude's dark palette to its light one). Needs a table per
  harness, per theme, per release; breaks silently when a harness retunes a colour; and cannot cover
  output from the tools and programs an agent runs, which is in no table. If per-harness knowledge
  is ever wired in, the payload should be **one bit** — "authored for dark/light" — not a colour
  map. One bit is all the mirror needs.

**What would justify revisiting:**

- **A measured codex real-output profile showing majority palette.** The 59% above is chrome only,
  n=29, captured while its auth was stale, so it never rendered a diff or a highlighted code block.
  If real output is also palette-dominated, the answer is per-harness rendering — re-theme codex,
  keep inverting the rest — not a global change.
- **Herdr answering `OSC 11`, or a palette protocol letting the client supply the ground.** Either
  restores the premise that a re-themed palette can work.
- **A measured scroll regression on a mid-range phone** — which reopens it in favour of keeping the
  mirror dark, not of re-theming it.
