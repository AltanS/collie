# DESIGN.md — the app's visual language

The rules the web UI is built to, and the reason behind each one. A rule without a reason
gets ignored the first time it is inconvenient, so every rule here carries its argument and,
where one exists, its measurement.

Scope: `web/src/` only — the bridge has no UI. [`ARCHITECTURE.md`](./ARCHITECTURE.md) says
what the pieces are; [`CLAUDE.md`](./CLAUDE.md) says how to work in the repo. Neither is
restated here. The values live in [`web/src/index.css`](./web/src/index.css) and its
comments are the ground truth for every number; this file holds the rules that span more
than one file, which a comment cannot.

---

## 1. Check `ui/` before you build anything. This is the first rule.

**Before writing a visual component, open [`web/src/components/ui/`](./web/src/components/ui/)
and look for the primitive.** If one exists, use it. If two or more places need the same
visual idea, it becomes a primitive there — it does not get copy-pasted a third time.

Why this is rule one: a primitive is where a fix lands once and reaches every call site.
`ui/button.tsx` proves it — one edit, moving `border border-transparent` into the base
string, repaired six call sites that had been silently changing their own box on every press
(`nav-tray.tsx` ×5, `quick-actions.tsx`) and closed the same bug for every button written
afterwards. A copy-paste gives you six places to remember instead.

### What exists today

| Primitive | What it is FOR |
| --- | --- |
| `ui/button.tsx` | Every clickable control with a label. Six variants, one box. Exports `buttonVariants` so a real `<a>` can wear the clothes. |
| `ui/badge.tsx` | A small static label pill. Not a status chip — it carries no dot and no tap floor. |
| `ui/card.tsx` | A filled panel on `--card` with its own edge. The Settings surface. |
| `ui/chip.tsx` | The pill in a strip: label, optional leading status dot, 44px hit box. Space and tab strips. |
| `ui/collapse.tsx` | The only sanctioned way an in-flow surface appears or disappears: an eased 240ms height+opacity slide that holds its last child through the exit. Styles nothing. |
| `ui/collapse.tsx` → `CollapseSwap` | Two surfaces taking turns in ONE band, as one motion: a single-cell grid, one height animation (the tall one's), and the short stand-in pinned in the cell fading over it. The fix for two sibling collapses on opposite gates, where the leaving surface is pushed the height of the band by the arriving one. The stand-in must be the shorter of the two. |
| `ui/list-group.tsx` | A run of flat rows drawn as ONE bordered region. Gives a `divide-y` list a first and last edge. |
| `ui/labelled-strip.tsx` | The structure of a named, horizontally scrolling pill row: non-scrolling label, `aria-labelledby`, edge-to-edge scroller. Also exports `STRIP_TAP_TARGET`. |
| `ui/one-of.tsx` | One box, several alternatives, exactly one shown — all of them stacked in a single grid cell, so the box is sized by the widest and a swap is paint, not layout. The §2 technique for a run of text whose WORD changes with the state. |
| `ui/notice.tsx` | The app's ONE notice look: five tones × two placements (`strip`, `box`), each on its own height floor, and the single table the tint recipe may appear in. Owns shape, tone and live-region semantics; owns no words and no visibility. |
| `ui/section-label.tsx` | The small uppercase word that names a section. Type only — it renders a `<span>` and owns no structure. |
| `ui/sheet.tsx` | `BottomSheet`. The app's only floating layer; there is no popover, no dialog, no tooltip. |
| `ui/strip-host.tsx` | The top band above the header. Renders ONE `StripSlot` at a time, the highest priority, and keeps the two permanent `sr-only` live regions. Domain-blind: a bigger number wins, and it does not know what a connection is. |
| `ui/switch.tsx` | A boolean toggle, `role="switch"`. No Radix. |
| `ui/toast-viewport.tsx` | Where a transient event floats: `dock="bottom"` fixed to the viewport, `dock="top"` absolute inside a route's content region. Owns position and nothing else. |
| `ui/chat/chat-input.tsx` | The composer's text box shell. |
| `ui/chat/chat-message-list.tsx` | The transcript's scrolling list. |

If the thing you need is not in that table, say so in the diff and put it in that folder.

### The alert family: the primitive landed, the conversion did not finish

There was **no alert primitive**, and the app grew six hand-rolled ones instead — three heights,
three gutters, two radii, and two different ideas about whether a notice has an edge at all.
`read-only-banner` and `host-stale-banner` were the *same class string* with a different status
token. Each was built without checking whether the previous one existed, and together they are why
the top of the app moved when its state changed.

The primitive now exists: `ui/notice.tsx`, plus `ui/collapse.tsx`, `ui/strip-host.tsx` and
`ui/toast-viewport.tsx` around it. §11 is the system they make. **One component is converted** —
`read-only-banner.tsx`, the pilot. Six are not, and §10 gap 1 lists each with what it still
hand-rolls; until they land, this app runs two alert systems at once.

**So: no seventh one.** A new notice is a `Notice`. If it appears or disappears, it does so through
`Collapse`. If it competes for the band above the header, it registers a `StripSlot`. The two
placements (§4) are now the `variant` prop and there is no third: `strip` is viewport chrome above
the header, full-bleed with a `border-b`; `box` is content in the column, inset on the page gutter
with a full border and the house radius.

---

## 2. No state may move content

The operator's constraint, verbatim:

> "when adding borders the elements need to stay on the point on the x axis to not disturb
> the reading flow"

**A state change may repaint. It may not re-lay-out.** A row's text left edge and right
edge must be pixel-identical whether it is resting, selected, alerting or focused, and its
height must not change either. A column of names that zig-zags as one row gains a border is
the failure this rule exists to stop.

### The technique

**Reserve the border in the base string, transparent, and let the variant recolour it.**
Never add `border` in a state.

```
base:     "… border border-transparent …"
outline:  "border-border bg-background …"   ← colour only
default:  "bg-primary …"                    ← inherits the transparent edge
```

Canonical example: [`ui/button.tsx`](./web/src/components/ui/button.tsx). `ui/badge.tsx`
had always done it this way; `ui/chip.tsx`, `ui/switch.tsx` and the tab and pane pills now
do too.

A ring and an outline also avoid reflow; the border wins on three counts. An outside mark
composites over the *parent's* background, so a `/40` state mark on a `/15` chip changes
colour with whatever it sits on. An outside mark is clipped by any ancestor scroller
(`ui/sheet.tsx`, the strips' `overflow-x-auto`) and overpainted by a later sibling's opaque
background in a `divide-y` list. And `outline` follows `border-radius` only from Safari
16.4 — this is an iOS PWA. A border is inside the box, so none of that can happen.

### Focus is a separate channel, and it sits outside

`focus-visible:outline-2 outline-offset-2 outline-ring`. The 2px offset leaves a gap of
surface between the 1px state border and the focus mark, so the two read as two marks
rather than one 4px smear. Outline is the right tool here for the same reasons it is the
wrong tool for state: it never reflows, it paints above everything, and it is transient.
Outside `ring-*` for state is retired.

### A run of text whose WORD changes needs a reserved slot, not a reserved number

The transparent-border technique reserves an *edge*. It has nothing to say about a caption whose
text changes with the state — and that is the same fault: at 390px "needs you" is 54.6px and
"done" is 27.9px, so a strip holding the word plus a host name moved the host name 33px sideways
every time the pane changed state. A hard-coded width is not the fix either: the same slot is
"braucht dich" (72.2px) in German and "desconocido" (70.0px) in Spanish, so any constant clips one
locale or wastes another's space.

**Reserve the SLOT, sized by the widest word in the active locale.** `ui/one-of.tsx` renders every
alternative in one grid cell and shows one; the layout engine measures the real glyphs of the real
dictionary, so a new translation is correct on arrival. Call sites:
`status-badge.tsx`'s `StatusWordSlot` (the composer's status band) and `ui/strip-host.tsx` (the
band above the header, where the same idiom was first written). A state with nothing to say —
a gone pane, showing no word at all — keeps the slot rather than collapsing it, because
"shows nothing" is a state too.

### The rule generalises past borders

Anything that changes a box is a state that moves content. Also forbidden in a state:
**font weight, size or tracking** (bold glyphs are wider, so a chip that gains `font-medium`
when it becomes current pushes every chip after it); **`border-radius`**; **padding or a
differing fixed size**; and **a conditional element** — a label a strip draws in one state
and not another is a row with two heights. That last one is why `LabelledStrip`'s `label` is
required and never conditional, and why a route unpaints *every* strip's label at once
through `CompactStripLabels` rather than per-strip.

This principle is also why the alert work in §1 is happening: six notices with six heights
appearing and disappearing at the top of the viewport is the same fault, one order of
magnitude larger. §11 states the one exception the app allows, and names the single component
that is allowed to be it.

---

## 3. Shape

`--radius: 2px`, and it does not ramp.

The radius descends from the mark, which holds a disc and a traced line and no
soft-cornered box anywhere. 2px is the smallest radius that still reads as intentional
rather than as a rasterizer artefact.

**All four derived steps are hard-pinned to 2px** in `@theme inline` (`index.css:249-252`).
Not tidiness: the stock shadcn ramp is `calc(var(--radius) - 2px)` / `- 4px`, which at a 2px
base compute `0` and `-2px`, and a negative radius is invalid. Pinning them also means
`rounded-md` and `rounded-xl` are the same corner, so no component can drift rounder than
its neighbour by picking a bigger step.

**Where in doubt, go sharper.** That is the standing instruction, and it was given after a
round came back softer than the direction that was chosen.

**Full-round is RESERVED** for shapes whose width equals their height, where it draws a
circle: status dots, the avatar, the switch thumb, a bead, the square 32px "+" buttons in
the strips. Anything wider than it is tall becomes a *stadium*, and there is no stadium in
the mark. The chip, the pane pill and the switch track all take 2px, each with a comment at
the line saying why, so nobody "fixes" one back.

---

## 4. Surface and separation

**Chrome is the PAGE colour, separated by a rule. Never a fill.**

The header used to be a `bg-muted` band. It existed only because the line it competed with
was not really a line: `border-border/60` measures **1.09:1** against the page in light and
1.16:1 in dark — a rumour, not a cut. Draw the line properly and the band is unnecessary;
dropping it also closes a seam on the pane screen and removes the worst ground a status chip
ever landed on. **Do not put `--muted` back behind chrome.**

### Two line tokens, and which is which

| token | light | dark | job |
| --- | --- | --- | --- |
| `--border` | 1.16:1 | 1.26:1 | one component's own edge — a card, a control, a hairline inside a region |
| `--rule` | **1.34:1** | **2.06:1** | the cut between two REGIONS — the header's bottom edge, a strip separator, a group frame |

`--rule` is deliberately the stronger of the two, which decides the split inside
`ui/list-group.tsx` — and it is not the obvious one: the **frame** takes `border-rule`, the
**hairlines inside** take `divide-border`. Built the other way the group gets a frame
fainter than its own dividers, which reads as five lines with a ghost around them.

### A boundary is drawn once, from above

Where two chrome strips stack, **the upper one closes its own bottom edge with `border-b`
and the lower one draws no `border-t`.** Two components both drawing the same seam produce
a 2px line where the language says 1px. See `space-strip.tsx:57-60` and the matching
`tab-strip.tsx` comment; each one names the other, so a future edit to either finds the
pairing.

### Centre content in the box the EYE reads, not the box CSS gives you

`items-center` centres in the **content** box. The box a person sees is whatever is bounded by
visible edges — so if a strip has a rule below it and nothing but open ground above, its content
reads as sitting low no matter what the numbers say, because the box the eye draws starts at the
last line it can see. The composer's status band was reported uncentred **twice** while measuring
correct both times; the fix was `border-y` — bound the strip on both edges so the box it is centred
in is the box that is visible — and moving the padding above it to below it. Then delete any
half-pixel compensation that was paying for the missing edge: on a symmetric box it tips the other
way. `composer.tsx` holds the measurement, `composer.test.tsx` pins the mechanism.

### Host colour is an identity, never a state

On a pack, `--host-0` … `--host-9` (`index.css`) tint the machine a row belongs to, so the
dashboard reads as several machines before the eye reads a name. Ten hues, chosen to avoid every
`--status-*` hue: a tint may never be mistaken for a status. `lib/hosts.ts` `hostSlot` assigns them
— `hash(id) % 10`, next free slot on a collision, over the sorted roster — so a machine keeps its
colour across reloads and across a peer joining. **A solo collie gets no host colour at all**;
`hostSlot` returns `null` and every surface renders exactly as it did before packs existed. The
NAME is always drawn beside the tint (WCAG 1.4.1), and health still speaks in the status palette.
**The tint lands on the GLYPH ONLY**, never as a wash across a tag or a pill: `ui/address-tag.tsx`
and `host-chip.tsx`'s name text and border stay the literal untinted classes on every surface, and
only the leading Server icon carries `text-host-N`. A whole-tag wash was tried and read as too much.

### A raised panel is `--card`, not `--background`

A sheet, a drawer or any panel that floats **over** the page takes `bg-card` and edges itself with
`border-rule`. `--background` is the page's own colour, so a panel painted in it is separated from
what it covers by nothing but a hairline. In dark that is the app's worst case — the page is
oklch(0.145), the scrim behind the panel only darkens it further, and `--border` at 1.26:1 was
carrying the whole thing. `--card` is oklch(0.205) dark and pure white in light, so the panel reads
as raised in both. Pinned in `ui/sheet.test.tsx`.

This is not a licence to fill chrome. A panel over the page is a **different surface**; a strip
that IS the page's own chrome still takes the page colour and a rule (the top of this section).

### A control needs a ground, or it is not a control

The pane's swipe handle used to hang under the terminal mirror, on `--background` — which in dark
**is** the mirror's own fill (`mirror-space.ts`), so a 6px grip was the only thing on screen saying
a control was there. Chrome the thumb operates belongs on chrome's surface. `agent-chat.tsx` now
wraps the handle and the composer in one block that carries the fill and the single rule closing it
against the terminal, so the handle is a handle **on** something.

That block's fill and rule are unconditional while the handle inside it is not — which is the §2
form of the same rule: the seam against the mirror is one hairline whether or not there is a pane
to switch to.

The fill is **`--chrome`**, a token that exists for exactly this one case and is spelled out in
`index.css`. It is **not** `--muted` — §4's opening rule still stands — and it is not `--card`
either: card is pure white in light, which lands 1.04:1 against the inverted mirror. `--chrome` is
rgb(235) light and rgb(23) dark, so it is the same raised surface the sheets use in dark and a step
below the page in light. If you need a third chrome fill, you are probably solving the wrong
problem; ask first whether the surface can stand on the page.

### One left edge per route

Every top-level block on a route — section label, group frame, notice, footer — begins and
ends on the same x. The page gutter is **16px** (`px-4`). Nothing in the content column is
full-bleed; only viewport chrome above the header is — the two-placement rule in §1.

---

## 5. Type

**The app's face is a per-device preference with a shipped default.** Aldrich (8 KB subset)
is that default; Space Grotesk (27 KB) and the system face are the other shipped choices, and
an operator may add their own through `theme.toml`. It is set on the Typeface card in
Settings, stored in `collie:design:v1`, and applied **before first paint** as a root class by
`web/public/theme-init.js` — `:root.font-*` in `index.css` owns every stack, and JavaScript
only ever swaps a class name. The default wears no class at all, so a device that never opens
the card runs no JavaScript before its first paint.

This **reverses** the old rule, which said the face was the maker's choice and forbade a
picker. [ADR 0033](./.adr/0033-the-app-face-is-a-device-preference.md) records why it fell.
The **TERMINAL font is a separate setting** — the Terminal font card directly below,
reaching `--font-mono` consumers only. The two are two settings because they are two
questions, and the cards sit adjacent so that reading one after the other makes the split
obvious.

**What survived the reversal is the rule that was always doing the work**, and it is below.

### Chrome wears the app face; content does not

**The chosen face — whichever it is — dresses headers, section labels, buttons, settings rows,
banners, counts and the wordmark.** It must **never** touch what an agent or a machine
authored: the pane mirror, the transcript, agent prose and markdown, code, command text, file
paths, ANSI. Two mechanisms hold that line and both must stay — `font-mono` for verbatim
terminal surfaces, `font-content` for agent-authored text that is not monospaced. Neither
resolves through `--font-sans`, so **the setting cannot reach either of them, and must not be
taught to.** An operator's own face is subject to the same line: bringing a font widens what
chrome may wear, never what it may dress. **If you cannot tell whether a surface is chrome or
content, it is content.** Full argument at the `@font-face` block in `index.css`.

### Mono vs sans, inside chrome

Within chrome the split is by **who authored the string**, not by how technical it looks.
**Mono** is a machine-authored identifier the reader compares character by character, where a
`0`/`O` or `1`/`l` confusion is a wrong answer: build hashes, shell commands, file paths,
host:port addresses, pane ids, pairing codes, keypad digits, an agent's own reason string.
**Sans** is the app talking about itself: "Connected", "Read-only", "Yes", every label, every
count, every row title.

`connection-info.tsx` is the worked example: two of five rows are mono (the address, the
server build), three are sans. The card used to set `font-mono` on all five, which put four
words of chrome in the terminal stack for the look of a diagnostics table.

**The derived edge case, which now holds in four places:** a **bare semver is chrome and
therefore sans**; a **semver carrying a git hash is a machine build id and therefore mono**.

| | |
| --- | --- |
| sans | `alpha-bar.tsx:62` (prerelease version) · `routes/pack.tsx:227-233` (a pack member's version) |
| mono | `build-stamp.tsx:60` (the footer stamp) · `connection-info.tsx:55-57` (the Server build row) |

### Counters

Any number that **steps** takes `tabular-nums`, or the row twitches as digits change width.
`tnum` is kept in EVERY shipped UI face's subset for this (`scripts/build-ui-font.sh`); there
are 17 call sites today.

---

## 6. Tap targets and row height

**44px is the floor for anything tappable.** The mark in the header is a button, so it owes
the same floor as the gear beside it — both are `size-11`.

**Buy the floor as HIT area where drawn height is expensive.** `STRIP_TAP_TARGET`
(`ui/labelled-strip.tsx`) extends a pill's hit box with a transparent `::before` while the
pill still measures 34px. Three strips stack above the fold on a phone, so ten drawn pixels
each is thirty pixels of list the operator stops seeing — and a target does not have to be
visible to be hit. Two measured numbers hold it together, both documented at the constant;
change the scroller's padding or the pill's border and you must re-measure.

**A row states its own floor with `min-h`, never `h`.** `app-header.tsx:212` is
`min-h-15` — 60px. It is a floor, not a sum: the row's own padding is `py-1`, and the
floor stands above whatever the content needs so the row cannot shrink when a route
passes less. The pane's stacked identity block and the dashboard's single 44px gear
both land at 60px, which is the point — the header does not resize as you navigate.

Why state it at all: this row used to have no height of its own, so it took the height of
its tallest *child* — and the children are props. On the dashboard the tallest was the 44px
gear (60px row); inside a pane there is no gear, so the 40px mark won (56px row), and every
dashboard→pane navigation jumped the header 4px. A row whose height is decided by its props
cannot be stable.

Why `min-h` and not `h`: with a fixed height, a child taller than the floor is clipped or
overlaps on one screen, silently. With `min-h` it grows the row **on every route at once** —
a visible design decision somebody has to look at.

**The one exception is a strip that is a RESERVATION rather than a row**, and it is named
here so it stays one: the composer's status band
(`composer.tsx`, `data-slot="composer-status"`) is `h-[13px]`. It is not a row whose height
follows its content — it is 13px of reserved chrome with a 1px rule at the bottom, and its
occupants are two runs that both *state* their box (`text-[10px]/3`, a 12px line box) rather
than measuring one from their glyphs. A floor would not do the job it exists for: the band
also spends `pt-px` to centre that 12px content on the band's own middle instead of on its
content box's, and under `min-h` that pixel would simply make the band 14px. The trade §6
warns about is paid honestly — nothing here can grow, because nothing here is sized by text —
and it is written down at the line. Add a second one only with the same two properties:
every occupant states its own box, and the strip's height is a number the layout was designed
around rather than a consequence of what it holds.

---

## 7. Tailwind v4 traps

Each of these has already cost real time in this repo. Check them by hand; none of them
fails loudly.

1. **A border colour with no border width paints nothing.** Preflight sets
   `*,::before,::after,::backdrop { border: 0 solid }`
   (`node_modules/tailwindcss/preflight.css:15`), so every element starts at 0 width.
   `border-status-blocked/40` alone is dead intent — and "fixing" it by adding `border` in
   the same state re-creates the §2 bug. Reserve the width in the base, transparent.

2. **`outline-none` silently cancels a later `focus-visible:outline-2`.** In v4,
   `outline-none` emits `--tw-outline-style: none`, and every `outline-<width>` utility
   emits `outline-style: var(--tw-outline-style)`. They resolve *through* the same custom
   property on the same element, so the focus ring computes to no style and paints nothing.
   There is no warning. If you add a focus outline, delete the `outline-none` in the same
   edit.

3. **A token declared inside `@theme inline` is NOT runtime-swappable.** `inline` is the
   instruction to *substitute* the value rather than emit `var()`, so `.font-mono` compiles
   to the literal font stack — verified in the built CSS. Re-pointing `--font-mono` on an
   element at runtime therefore changes nothing. That is why the user's terminal font is
   applied as an inline `font-family` style on the mirror surface plus one arbitrary variant
   that makes its `font-mono` descendants inherit, rather than by re-pointing the token. The
   full note is in `hooks/use-display-prefs.ts`.

---

## 8. Not negotiable

- **The terminal mirror is not re-themeable.** It renders in a fixed dark ANSI palette under
  every theme and the light theme inverts it wholesale, because truecolor names an absolute
  colour no palette can re-theme and three of the four harnesses emit overwhelmingly
  truecolor. The boundary is `MIRROR_SPACE` / `MIRROR_INVERT` at
  [`components/mirror-space.ts:33-34`](./web/src/components/mirror-space.ts); read that
  file's header before touching any surface that renders segments, and see
  [ADR 0002](./.adr/0002-invert-the-light-terminal-mirror.md). **Never put a `dark:` variant
  inside one** — it tracks the root theme, which is backwards in an element that is dark
  under every theme.
- **Light `--background` is `oklch(0.97)` on purpose.** It rasterises to rgb(245,245,245),
  which is exactly the inverted mirror's background, so the mirror shows no seam against the
  page. It is not "off-white for taste"; moving it re-opens that seam.
- **`components/collie-mark.tsx` is GENERATED** from the sibling `collie-brand` repo. Never
  hand-edit it. Change the brand repo and regenerate.

---

## 9. How a design rule is enforced

A rule that spans two files drifts, because an edit to one file looks complete on its own.
When that happens, write a **coupling test**: read the value off one rendered element, read
the coupled value off the other, and assert they name the same token.

The pattern is in
[`components/app-header.test.tsx`](./web/src/components/app-header.test.tsx), "knocks the
mark out in the SAME paper the header is filled with". The mark makes "in front" by cutting
the head away behind a near-side bead and filling the cut with the page colour — a claim
about what it sits on, not a colour it picks. So the test parses the `bg-*` utility off the
`<header>` element, reads the custom property off the mark, and requires they name the same
token. Change the header's fill and forget the mark's `paper` prop, and every near-side bead
gets a halo in the old ground — subtle enough to survive a screenshot review.

**It was verified to fail in both directions**, which is what makes it a test rather than a
comment. The same file couples the mark's tap box to the gear's (`size-11`, one number read
off both) and asserts the header row is `min-h-15` and carries no `h-<n>`.

Reach for this whenever a rule lives in two places. Cheaper than an ADR, and it does not rot.

### A test queries its own render's container, never `screen`

`ui/strip-host.tsx:108-109` mounts two permanent, empty `sr-only` live regions — one
`role="status"`, one `role="alert"` — so a live region exists before its content changes. The
cost is that `screen.getByRole("status")` is **ambiguous in any tree that holds a host**: it
matches the empty region as readily as the notice you meant, and the failure reads as a missing
element rather than a duplicate one. So destructure `container` from your own `render()` and
scope by `data-slot`. Two workers lost time to this before it was written down.

---

## 10. Honest gaps — rules the codebase does not yet follow

Stated so nobody reads this document as a description of a clean tree.

1. **The alert family is half-converted.** `ui/notice.tsx`, `ui/collapse.tsx`,
   `ui/strip-host.tsx` and `ui/toast-viewport.tsx` exist (§1, §11), and `read-only-banner.tsx` is
   the one component built from them. Six surfaces still hand-roll their own box, so the app runs
   two alert systems at once. Each line below was re-read against the source, not inherited:

   | Still hand-rolled | What it owns that the primitive owns |
   | --- | --- |
   | `connection-banner.tsx:92` (auth), `:240` (connection) | full-bleed `border-b px-4 py-1 text-xs`, its own safe-area inset, its own tint table (`:311-313`), its own collapse machinery — and `role="alert"` beside `aria-live="polite"` at `:89-90` and `:236-237`, the contradiction §11 exists to make inexpressible |
   | `update-available-banner.tsx:28` | full-bleed `border-b`, `px-4 py-1.5`, the tint recipe written inline, its own safe-area inset, no height floor |
   | `host-stale-banner.tsx:92` | inset `rounded-sm border … px-4 py-2 text-xs` — the pre-conversion read-only string, verbatim. Mounts and unmounts with no `Collapse`, so it pops. |
   | `no-echo-notice.tsx:43` | `rounded-md bg-muted/40 px-2.5 py-1.5` and **no border at all**; `terminal-draft-preview.tsx:32` is the same string a second time (gap 3 below) |
   | `routes/settings.tsx:158,163` | two `<p>` rows on `border-t border-border px-4 py-2.5`, popping into the card unanimated |
   | `alpha-bar.tsx:50-51` | full-bleed `border-b border-status-info/40 bg-status-info/15 px-3 py-0.5 text-[11px]`. Deliberately last, and possibly never: it is a static build fact that never appears or disappears, so it cannot shift anything, and it is the family's visual precedent rather than a violation of it. |

   **Closed:** `status-area.tsx` used to carry its own fixed wrapper per route. All three now mount
   `ui/toast-viewport.tsx` — `routes/home.tsx` and `routes/space.tsx` at `dock="bottom"`, the pane
   screen at `dock="top"`. Three copies of the same four utility classes, each drifting a gutter and
   a z-rung from the others, are one call now. Still unconverted, by design order rather than
   oversight: nothing mounts a `StripHost` yet — the band is indivisible and lands in one change.
2. **`space-overview.tsx:136`** — an `outline-none` on the filter `<input>` with no
   replacement focus mark on it or its `<label>`. Trap 2 in its plain form: keyboard focus
   on that field is invisible.
3. **`no-echo-notice.tsx:43` and `terminal-draft-preview.tsx:32`** — a `bg-muted/40` fill
   with no border, above the composer. A fill-delimited notice is a third idea about what a
   notice is, and §4 says chrome separates with a line.
4. **`composer.tsx` — the composer dock is `bg-muted`.** One chrome fill, not two. The status
   band above it carried a `bg-card` fill briefly and lost it once measured: the fill separated
   the band from the dock below by **1.19:1 in both themes** — barely off the 1.09:1 that got the
   header band deleted — and from the terminal mirror above by **1.09:1 light / 1.10:1 dark**, so
   in dark it read as a continuation of the terminal rather than as chrome. The `border-b
   border-rule` beside it measures 1.45:1 light and 2.19:1 dark. The rule was doing the
   separating, so the fill went and the band is unpainted. The dock's own fill is the older gap
   and the one that remains; `index.css`'s `--muted` comment argues against it directly.
5. **The `/60`-and-`/70` border alphas** — `wizard-block.tsx`, `preview-select-block.tsx`,
   `menu-block.tsx` and `status-area.tsx:45` still draw edges at `border-border/60` or `/70`,
   which §4 measured at 1.09:1 in light. These are inside the agent-dialog blocks, which are
   the least-visited part of the restyle.

---

## 11. Announcements — four categories, two layout models

Every surface that tells the operator something is not normal is one of four things. Ten of them
existed because nobody had named the categories: severity was mistaken for category, so each new
severity grew a new component. **Severity is a tone, not a category** — `ui/notice.tsx` carries
five of them and any category may wear any one.

| Category | Outlives the next interaction? | Scope | Where it lives |
| --- | --- | --- | --- |
| **System strip** | yes | the app / this session | the band above the header, full-bleed |
| **Scope notice** | yes | this route or view | an inset box in the content column |
| **Event** | no | wherever it fires | the floating layer — never holds space |
| **Contextual notice** | while its control is relevant | one control | that control's own chrome |

### Which surface do I use

Two questions, answered in order. Read only the row you land on.

| Outlives the operator's next interaction? | Scope | Use |
| --- | --- | --- |
| **no** | any | **Event.** `lib/status.ts` → `<ToastViewport dock>`. `dock="bottom"` on screens with no composer; `dock="top"` on the pane. Never in the flex column. |
| **yes** | the whole app or session | **System strip.** `<StripSlot priority={…}>` inside the one `StripHost`, wrapping `<Notice variant="strip">`. |
| **yes** | this route or view | **Scope notice.** `<Collapse open={…}><Notice variant="box">`, the caller supplying only the gutter. |
| **yes** | one control | **Contextual notice.** `<Notice variant="box">` anchored in the control's chrome, not the viewport — it pushes the *input*, which is correct: the operator is acting there. |

### The four acknowledgement channels

The table above answers *which surface*. This one answers a different question that kept getting
confused with it: when the operator acts, what tells them it worked. There are four channels and
they answer four different questions. **One channel per question.** A control that reaches for two
says the same thing twice; a control that reaches for none has told the operator nothing, which is
the failure three call sites were shipping.

| Channel | Question it answers | Owner |
| --- | --- | --- |
| **Haptic buzz** | "Did the glass register my tap?" | `hooks/use-action-echo.ts` and `hooks/use-hold-repeat.ts` only. On the press, never on the outcome. |
| **Per-control echo** (✓ / spinner / busy tone) | "Did the bridge accept MY action?" | every fire-and-forget user mutation, at the control it was tapped on |
| **Floating status** (`lib/status.ts` → Event) | "What happened, and why not?" | failures ALWAYS; success only when the outcome is not visible at the point of action |
| **Collie orbit round** | "Something happened — look up" | every status the app publishes, one round per burst |

The orbit round is the one with a rejected alternative worth recording. It was narrowed to
*unattended* events only — the world moving while the operator was not acting — on the argument that
a tap is already answered at the control, with the eye on the thumb rather than on the header. Good
theory, wrong eye: the send is the moment the operator looks UP, because the reply is what they are
waiting for. The flag that carried the distinction was deleted rather than left unread. The rule is
now the simple one — **if it was worth a notice, it is worth a round** — which also keeps the notice
and the mark from ever disagreeing about what happened. `components/collie-home.tsx` holds the full
argument at the line that would change.

Failure is the floating status for everything, always — the one exception being a control whose
refusal is a **contextual notice** in its own chrome, which moved the failure rather than deleting
it. `lib/mutate.ts` is the wrapper that keeps a thrown mutation from being swallowed where a call
site has no error surface of its own, and `lib/ack-manifest.ts` records which channel every
mutating export of `lib/api.ts` actually uses. That manifest is paired with a test, on the
pack-wire guard's philosophy (ADR 0025): it cannot verify an acknowledgement renders, but a
mutation added next month fails the test until its author writes one classified line — and that
line gets reviewed.

### Why not "always on top"

The ask was that notices float over content always. That is right for events and wrong for
standing conditions, and **both failure modes are lived experience in this repo**. The pane screen
once floated the status line over the mirror; it covered the terminal tail — the newest output, the
reason the screen is open. The fix was to move it off the tail, not out of the overlay: it floats at
the top of the pane's content region, over the tab and pane strips (`agent-chat.tsx:990-1004`), and
shrinks nothing. It was briefly an in-flow row instead, and that was worse in the other direction —
every "Sent" pushed the strips and the whole mirror down 30px and pulled them back 2.5s later, so
the page moved twice to say one word. The two failures belong to two categories. A 2.5s toast over the
tail is bad precisely because it fires while you are watching the tail; a minutes-long "you are
read-only" box, floated, is bad the other way — it either occludes for minutes or fades and leaves
the composer inexplicably dead, which is a lie by omission. Hence the ruling: **a notice that will
outlive the operator's next interaction holds space; anything shorter floats.** A standing condition
costs space because it costs capability, and those pixels buy a fact the operator must not lose.

### Where the priority table lives

`web/src/lib/strip-priority.ts` — `AUTH 40 > OUTAGE 30 > DEGRADED 20 > UPDATE 10`, in steps of ten
so a future level slots into a gap without renumbering anything. It is on the **feature** side
because `ui/strip-host.tsx` is domain-blind: it knows only that a bigger number wins, never what a
connection or an update *is*. The band shows one strip at a time: two cost ~66px of a 390×844
phone and double the number of times the page moves, and every pair has a strict answer anyway. The
losing fact is not lost — the update offer keeps its footer line and its settings control.

### Two hard rules

1. **No state may move content except through `Collapse`.** §2 forbids a state that re-lays-out;
   a notice arriving is that fault one order of magnitude larger. `ui/collapse.tsx` is the single
   sanctioned exception — `grid-template-rows: 0fr↔1fr` plus opacity over 240ms — because the
   height change is then continuous and eased, so neighbouring content (the mirror included)
   animates instead of teleporting. It holds its last child through the exit, so a box closes on
   the sentence that explained it. No bare conditional mount, no `hidden`, no unanimated pop.
2. **A dismissible standing condition needs a permanent second surface.** Dismissal must not be
   able to leave the operator misinformed. The update strip may be dismissed because the same fact
   also sits in the footer and in Settings. The connection and auth strips may not: the remedy
   button is the only honest exit. Scope notices may not: they explain dead controls, and a refusal
   with no visible reason is the shape of issue #103.

### One role, or one `aria-live`, never both

`ui/notice.tsx` takes `announce`: `"alert"` emits `role="alert"` and nothing else, `"status"` emits
`role="status"` and nothing else, `"none"` emits neither. There is deliberately no way to ask for
both. This is a **correction, not a preference** — `connection-banner.tsx:89-90` and `:236-237`
carry `role="alert"` beside `aria-live="polite"` today, which asks for assertive and polite at once
and lets the answer depend on which screen reader is reading. A role already carries its own
implicit liveness; a second declaration beside it asks one question twice. `strip-host.tsx:108-109`
keeps one empty polite region and one assertive region mounted permanently, because a live region
has to exist *before* its content changes to be announced reliably.

### The two floors

`min-h-[33px]` for a strip, `min-h-[42px]` for a box, stated once in `ui/notice.tsx` and not
lowerable by a caller. Both are derived, not picked: the 24px action slot plus the shape's own
padding plus its border, which `border-box` counts inside a min-height. `min-h` and never `h`, for
the reason §6 gives at `app-header.tsx:212`. They are **floors** — a two-line host-stale message
legitimately grows its box — and what they buy is that two one-line notices are the same height
whether or not one carries a button, so swapping one strip for another inside the open band
repaints it and never moves it.
