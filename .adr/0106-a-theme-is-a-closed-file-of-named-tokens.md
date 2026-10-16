# 0106: a theme is a closed file of named tokens

- **Status:** Accepted
- **Date:** 2026-10-15
- **Shipped in:** 1.22.0
- **Amends in scope:** [ADR 0033](./0033-the-app-face-is-a-device-preference.md), the line that the design store
  grows siblings: it grows one, `theme`, and a radius or a density never joins it
- **Trail:** M57 (Themes) README, the shared contract · `web/src/themes/` (the shipped files) ·
  `web/src/themes.css` (generated) · `web/public/theme-init.js` · `web/src/lib/design.ts` ·
  [ADR 0002](./0002-invert-the-light-terminal-mirror.md) ·
  [ADR 0033](./0033-the-app-face-is-a-device-preference.md) ·
  [ADR 0047](./0047-muse-panes-render-natively.md)

## Context

People who come to 1.22.0 for durable agents come from terminals and editors, and they bring theme habits. Ten
persona interviews asked for the same shape. All ten want the status colours. Nine want the surfaces, light and
dark. Eight want to export a theme, edit the file and send it on. Seven want a preview and a contrast readout
before they apply one. Nine said layout and tap sizes must never move, six said the same of the corner radius, and
seven said a status must keep its meaning.

The same people named what would make them distrust the feature: an importer that keeps an unknown key or takes a
`url()`, a default look that changes after an update, and a white flash on load.

The code already has the seed. `index.css` writes every colour token once, as `light-dark(<light>, <dark>)`, and
`color-scheme` picks the half. `design.ts` stores the device look as an object so that it can grow a sibling.
`theme-init.js` fixes the root before the first paint. Altan, 2026-10-15: the current theme must not change
visually or behaviourally, and the schema must carry a version so that it can grow.

## Decision

**A theme is one JSON file with a version, an id, a light half, a dark half and one font key. The list of keys is
closed. Anything outside it is refused with a message, never dropped.**

1. **The schema, version 1.** `version` is the integer 1. `id` is lower case, 1 to 32 characters. `name` is 1 to 40
   characters, `author` is optional. `light` and `dark` each map token names to colours; one half may be missing,
   and the default theme fills it token by token. `fonts.ui` is optional and names one bundled UI face. `$schema`
   is allowed and ignored.
2. **43 tokens per half, and only these.** 21 surfaces and inks, 6 status colours, 6 syntax inks, 10 host colours.
   These are the colour tokens `index.css` has today, less the two `popover` aliases of `card`. The full list is in
   DESIGN.md §13 and in `theme-init.js`. The M57 README first counted 48; the list it names holds 43, and 43 is
   the number.
3. **A value is a colour and nothing else.** `#rrggbb`, `#rrggbbaa`, or `oklch(L C H)` with an optional alpha, in
   plain numbers. No other function, no `var()`, no `url()`, no `;`, no `}`. A value is never pasted into a style
   sheet as text.
4. **What is refused, with a message that names the cause.** Any other version. An unknown key, at any depth. A
   value outside the grammar. A file over 64 KiB. A ninth imported theme on one device. An imported file that uses
   one of the four shipped ids. Nothing is applied when a file is refused.
5. **How a shipped theme applies.** Shipped themes are files in `web/src/themes/`. A build script writes
   `themes.css` from them, one block per theme: `:root[data-theme="<id>"]` with one `light-dark()` line per token.
   Choosing the theme sets the `data-theme` attribute. A test fails when the CSS is stale against the JSON.
6. **How an imported theme applies.** The validated object is stored in `localStorage` under `collie:themes:v1`.
   It applies as inline custom properties on `<html>`, one `style.setProperty("--<token>", "light-dark(l, d)")`
   per token, built from the validated object only. The browser parses each value as one property value, so a
   value cannot open a rule.
7. **The default applies nothing.** The current look is the theme `collie`. Its file equals the values in
   `index.css` byte for byte, and a test holds the two together. Choosing it sets no attribute and no inline
   property. So the default cannot drift from today, and one tap back to it always works, because it removes
   what a theme added and adds nothing.
8. **The active theme is one field.** `theme` in the existing store `collie:design:v1`. Absent means `collie`.
   `theme-init.js` reads it before the first paint, so a pinned theme paints in its own colours on the first frame.
   It spells the shipped ids, the token list and the colour grammar itself, and a coupling test fails when they
   drift from the TypeScript side.
9. **A theme and an appearance are two settings.** System, Light and Dark stay as they are and pick the half. The
   `theme-color` meta follows the active theme's two backgrounds.
10. **The mirror and the ANSI 16 stay out of version 1.** The mirror keeps its own dark space (ADR 0002), and the
    light half inverts it. A theme that set the 16 terminal colours would be inverted with it, so a light theme
    would show a palette its author never chose. Five of ten people want the 16 colours. They come after a "native
    mirror, no inversion" mode exists under a theme, which is ADR 0002 and ADR 0047 work.
11. **Never themeable.** Layout, spacing, tap sizes, corner radius, motion, the meaning of a status (its icon and
    its word), raw CSS, remote fonts, and the agent's own truecolour output in the mirror. These are not "later";
    a schema version does not add them.
12. **The schema grows by version.** A new token or field is a new version number. Version 1 files keep loading.
    A lower version than the reader supports is never accepted silently; it is migrated or refused with a message.

## The exit test

The current theme must not change by one pixel. Eight screenshots of `release-1.22` (the pane page, home, Settings
and New, at phone and tablet size, in light and dark) are taken before the first code lands. Every branch of the
milestone reruns them, and the diff must be zero on every image. `bridge/solo-baseline.test.ts` stays green. A
non-zero diff stops the branch, whatever it improves.

## Consequences

- Every colour a component draws must come from a token, or a theme cannot reach it. DESIGN.md §13 states the rule,
  and §10 lists the literal colours that break it today. They stay until a fix can keep the pixel diff at zero.
- Three files spell the token list: the shipped JSON, `theme-init.js` and the TypeScript validator. The coupling
  test is the price of a pre-paint script that imports nothing.
- An imported theme is per device. It does not sync across devices or a crew in version 1.
- A tampered store can show one wrong-colour frame before the app checks the theme again and resets to `collie`.
  `theme-init.js` checks every key and the shape of every colour, but not the ranges of L, C and H. We accept this.
- An operator default through `theme.toml`, `fonts.mono` in the file, an editor on the phone, and import from a URL
  are left for later. Each is a new field or a new path, not a change to version 1.
- Revisit when the native mirror mode lands. That is the moment to add the ANSI 16 in version 2.

## Amendment, 2026-10-16: schema version 2, and the mark is gone

**Version 2 gives a theme a shape, a look and a terminal palette, each a closed word or a gate-checked
colour. The header mark was never a part of the theme.** The text above stays as written for version 1.
Where it says "version 1" or "never themeable", this amendment is the current rule.

1. **The mark field was removed before release.** A first design (M57 spec 09) let a theme name its header
   mark. Altan called it on quality, and M57 spec 13 took it out. No `mark` key exists in the schema. The
   Collie dog in the header, the home-screen icon and the splash look the same under every theme.
2. **The parser reads versions 1 and 2, and writes the lowest that holds the content.** A theme with a
   `surface` block, a `fonts.display` face or an `ansi` block is version 2. A theme without them is version 1,
   so a colour-only export still opens in a reader that knows version 1 alone. A file that says 1 and holds a
   version 2 block is refused: the file is older than the block. A version 2 file needs Collie 1.22.0 or newer.
   This follows decision 12 and amends decision 1: the schema has two versions now.
3. **The `surface` block holds ten keys, each a closed list of words.** `radius` (sharp, soft, round),
   `shadow` (default, flat, lifted), `density` (default, roomy), `weight` (default, bold), `border` (default,
   strong), `ground` (flat, gradient, grain), `chrome` (page, band), `rows` (rules, cards), `icons` (default,
   thin, heavy) and `labels` (caps, sentence). A key left out is its default word, and every default word is
   today's value, held by a test per token. A word that is not on its list, or a number, is refused with the
   token named. This amends decision 4, which now refuses a word outside its list and a palette that fails a gate. It
   amends decision 11 for the corner radius and for spacing (`density`): each is a closed word now. A free
   value is still not.
4. **Two more version 2 doors beside `surface`.** `fonts.display` names one of the six shipped faces for
   titles and the header name, and the browser fetches it only when a theme names it. `ansi` holds all 18
   colours of the terminal mirror (slots 0 to 15, `ink`, `ground`) or none, opaque, written in dark space.
   Its gates refuse a file instead of warning: ink on ground at 4.5, slots 1 to 15 on ground at 3, slot 0
   exempt, ground darker than ink, slots 3, 7, 11 and 15 above relative luminance 0.6 and the other twelve
   at or below it. This amends decision 10. It did not wait for a native mirror mode. The palette is
   authored in dark space, the light mirror inverts it whole, and a theme computes its `ground` back from
   its light page. The agent's own truecolour output stays outside every theme.
5. **One table, four readers.** `web/src/lib/theme/surface.ts` holds the word-to-declaration table.
   `schema.ts` checks words against it, `themes-css.ts` writes the shipped themes from it, `store.ts` sets an
   imported theme's words inline, and `public/theme-init.js` does the same before first paint. The script
   imports nothing, so `scripts/build-themes.ts` writes one generated line into it, and a test fails when the
   line differs from the table. `bun scripts/build-themes.ts --check` is the gate.
6. **A marked row never pairs a left bar with rounded corners.** A selected or blocked row writes
   `shadow-[var(--edge-accent)_<colour>]` and never the offsets. The `radius` word sets `--edge-accent`: a 2px
   bar on the left under `sharp`, a 2px ring on all four sides under `soft` and `round`. It also sets
   `--edge-shadow`, the soft second layer of the ring. DESIGN.md §13 holds the rule.
7. **The contrast gate grows with the look.** A gradient or a grain is measured at its far end, a band is
   measured on `secondary`, and the status bar follows `secondary` under `band` (amends decision 9, where it
   followed the page backgrounds). The shipped themes keep every check green. If a colour fails a gate, the colour
   or the word changes, never the gate.
8. **The exit test holds.** Collie renders the same pixels as before version 2 (22 of 22 captures at zero
   difference against the parent build), and the perf recap stays flat.

**Known limits.**

- **The type scale is not a token.** The app sets about 130 sizes as arbitrary `text-[Npx]` classes, and a scale word
  would leave them behind. The conversion of those sizes to steps is the work of 1.23.0, and a type scale
  waits for it.
- **Under a gradient the three bars keep the flat page colour.** The header, the tab bar and the bottom bar
  can read as a plain box on a tablet. A theme word cannot fix it. The bars could take the gradient's foot
  colour, which is also 1.23.0 work.
- **Shipped ids stay reserved.** An import with the id of Collie, Nightwatch, Daylight or Harbour is refused,
  so an edited export needs its own `id`.
