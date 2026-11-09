# 0137: A theme may name a glyph set, from a closed list, and every icon is named by its meaning

- **Status:** Accepted
- **Date:** 2026-11-08
- **Shipped in:** pending
- **Builds on:** [ADR 0136](./0136-a-theme-may-name-a-mark-and-every-mark-keeps-one-contract.md) (a theme
  names a goodie from a closed list, a lazy chunk outside the precache) and
  [ADR 0106](./0106-a-theme-is-a-closed-file-of-named-tokens.md) (a theme is a closed file).
- **Trail:** Altan, 2026-11-08: "we should update the theme to allow a custom icon set, for that we need a
  list of all icons and where they are used, with a proper key. another opportunity to clean up
  duplicates/stale icons." · the icon inventory of that day (164 lucide glyphs, 650 render sites, 266
  meanings) · the theme security review of that day, section D-b · `web/src/components/icons/` ·
  `web/vite-glyphs.ts` · `web/src/lib/glyph-sets.ts` · `web/src/lib/theme/schema.ts`

## Context

Collie drew every icon by importing a lucide component at the call site, 650 times. A theme could set the
stroke width (`surface.icons`) and nothing else. Theme authors want a different family, and the obvious
next request is "let my theme ship its own icons": an SVG per icon in the file, or a URL. That road puts
drawn markup from a stranger's file into the page, beside a strict CSP, and makes every theme a few
hundred kilobytes.

A swap also needs names. One lucide glyph meant up to eight things (an `X` closed a sheet, removed a row,
cleared a field and marked a failed step), and one meaning was drawn with up to three glyphs. A set keyed
by lucide name cannot draw Close and Remove apart, and cannot say what a key means.

## Decision

1. **Every icon is named by what it means.** `components/icons/keys.ts` is the one table: a key, its
   meaning in plain words, its area, and the lucide glyph of the default set. Every app icon renders
   through `<Icon name="<key>" />`, and an unknown key does not compile. `KEYS.md` is generated from it.
2. **A theme names a set with `glyphs`, one word from a closed list** (`lucide`, `phosphor`,
   `phosphor-fill`, `phosphor-duotone`, `iconoir`). It makes the file version 4, like `character`, and
   is refused the same way. There is no device switch: the worn theme decides, a tried theme first.
3. **A theme never carries a drawing.** The sets are built into Collie from the icon packages at build
   time. A theme picks a word; it cannot name one icon, add one, or point at a file.
4. **A set other than lucide is one lazy chunk under `glyphs/`**, outside the precache, with only the
   mapped glyphs of that weight. Until it arrives, and when it cannot (offline after an update), every
   icon draws its lucide glyph in the same box. A key a family has no glyph for draws its lucide glyph,
   and a test lists those fallbacks.
5. **The rendered contract is `svg.icon[data-icon=<key>]`, one direct `<svg>`.** The stroke rule and the
   tests hang on that, never on a `lucide-*` class. React builds every element from parsed data; no glyph
   reaches `innerHTML`.
6. **Brand and status marks are not icons.** The agent logos, the Collie mark and the characters, the
   status shapes, the walky talky radio, the unread mark and the multiplexer logo stay the same under every
   set.

## Consequences

- A new icon is a key with a meaning, a lucide component, and a word (or `null`) in each family map.
  `satisfies Record<IconKey, …>` names the file that misses it.
- A new set is a row in `glyph-sets.ts`, a case in the loader's `switch` and a source in the plugin, and
  for a new family a map of all keys. The schema follows from the list.
- The entry bundle carries one component and a key table of components, not the meanings.
- Revisit if authors need a glyph no family offers: add a key or a family, never a drawing in the file.
