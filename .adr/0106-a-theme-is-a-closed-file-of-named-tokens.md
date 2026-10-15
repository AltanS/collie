# 0106: a theme is a closed file of named tokens

- **Status:** Proposed
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
