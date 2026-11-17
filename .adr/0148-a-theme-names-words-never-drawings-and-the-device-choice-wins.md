# 0148: A theme names words, never drawings, and the device's own choice wins

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0033, ADR 0106, ADR 0136, ADR 0137, ADR 0138
- **Trail:** ten persona interviews for M57 (an importer that keeps an unknown key, a default that
  drifts); M57 specs 09 and 13 (a theme `mark` field, removed on quality); M59 spec 04 (import by link,
  declined for paste); the owner's brief of 2026-11-08 (marks for another crowd, a custom icon set, an
  SVG per icon) and the order of 2026-11-12 (a device picks the character); issue 748 (a "Reduce
  motion" setting); issue 220, PR 241 and PR 244 (Muse and the per-pane override); ADR 0018 (the
  replace rule that operator fonts do not take). Files: `web/src/lib/theme/`, `web/src/lib/mark*.ts`,
  `web/src/components/mark-contract.ts`, `web/src/components/icons/`, `bridge/operator-fonts.ts`,
  `docs/themes.md`, `DESIGN.md` sections 5 and 13

## Context

Seven records shaped the look one request at a time. Their amendments reversed their own rules
three times: the mark left the theme and came back, "only the theme names a character" became a
device setting, and "no animation at rest" became a drift while the page is visible.

## Decision

1. **A theme is one closed JSON file.** Every key, token and word is on a list. A file holds colours
   in one grammar and words from closed lists, nothing else. An unknown key, a bad value or a wrong
   version is refused with a sentence that names it, never dropped, and a refused file applies nothing.
   One soft edge: a decoration word of the right shape that this build lacks (`glyphs`, `character`,
   a ground word, a face) is kept as written and drawn as that part's default.
2. **The schema grows by version, and a file says the lowest version that holds it.** Versions 1 to 5
   read; a file that holds a block newer than its own version is refused. A colour-only theme stays
   version 1, so an older Collie still reads it.
3. **Never themeable:** a free layout, spacing or radius value, tap sizes, the type scale, motion
   (except rule 9), the meaning of a status, raw CSS, a remote font, the agent's own truecolour output,
   and the favicon, app icon and splash. Shape and density are closed words that default to today.
4. **The default applies nothing.** `collie` writes no attribute and no property, so its look cannot
   drift and one tap back always works. A shipped theme sets `data-theme`; an imported one applies as
   inline properties built from the validated object, checked again at every read and every apply. A
   pre-paint script applies the stored choice before the first frame.
5. **A theme arrives by a file, a paste or the community list. The page fetches nothing.** A pasted
   link is refused. The host fetches the list only on a tap, from one address, and checks every entry
   with the same parser. A device keeps at most eight imported themes; a file is at most 64 KiB; a
   shipped id is reserved. The contrast report warns; only unreadable body text and the terminal
   palette's gates refuse a file.
6. **A theme may name a character from a closed list; the device's choice wins.** The order is the
   device's own pick, then the worn theme (a tried theme first), then Collie. The pick stays on the
   device. The favicon, app icons, splash, boot screen, idle lock, agent start and tour stay Collie.
7. **Every mark keeps one contract.** The host says what (a state, bead colours, a turn), never how,
   and never names a mark's private parts. A mark that fails the conformance suite cannot ship. A mark
   other than Collie is a lazy chunk, and a chunk that cannot load draws Collie.
8. **A theme may name a glyph set from a closed list, and never carries a drawing.** The worn theme
   decides; there is no device switch. Every icon is named by what it means. A set is built into
   Collie and loads lazily; Lucide draws until it arrives and where a set has no glyph. Brand and
   status marks are not icons.
9. **The resting character drifts while the page is visible, in steps, and one switch stops it.** The
   device's "Character moves", once touched, wins; else the worn theme's `characterMotion`; else it
   moves. A theme can only stop the drift. Reduced motion and a hidden page hold it whatever the
   switch says. A hidden page or a covered app pauses every animation, and an endless indicator moves
   in steps. There is no general "Reduce motion" setting.
10. **The UI face is a device preference with a shipped default, and it dresses chrome only.** The
    default, Atkinson Hyperlegible Next, wears no class, so a device that never chose gets no class
    before its first paint. A choice is a root class; no script holds a font stack. A theme with
    `fonts.ui` sets the device face. Agent and machine text never wears the chosen face.
11. **An operator's fonts add to the list, never replace it.** A font cannot fire an action, so it
    has nothing to shadow, unlike a command row (ADR 0018). The bridge serves only a declared row's
    bare `.woff2` name inside the config's `fonts` folder, contained on real paths, and every refusal
    is the same 404. The wire carries no URL, and the service worker never sees these files.
12. **The terminal mirror stays in dark space and inverts in light.** A theme's palette is authored
    in dark space and inverts with it. One agent bit (Muse) renders natively, and a per-pane override
    wins in both directions.

## Today in the code

- Rules 1 and 2: `TOP_KEYS`, `THEME_TOKENS`, `OPTIONAL_THEME_TOKENS`, `COLOUR_SOURCE`, `versionOf`,
  `THEME_VERSIONS_READ`, `DECORATION_WORD`, `themeFallbacks`, `MAX_REFUSALS` (25) in
  `web/src/lib/theme/schema.ts`; `SURFACE_TOKENS` (13 words) in `web/src/lib/theme/surface.ts`.
- Rule 3: `SURFACE_DEFAULTS`, `CHARACTER_MOTIONS` (`schema.ts`). Rule 4: `applyTheme` (`store.ts`)
  sets only properties built from the validated object; `theme-init.js`; `build-themes.ts --check`.
- Rule 5: `theme.paste.refusal.link` (`web/src/lib/i18n/messages/en.ts`); `connect-src 'self'`
  (`bridge/server.ts`); `THEME_REGISTRY_URL`, `REGISTRY_CAP_BYTES`, `REGISTRY_MAX_ENTRIES`
  (`bridge/themes/registry.ts`); `readRegistryEntry` (`web/src/lib/theme/registry.ts`); `LIBRARY_MAX`
  (8, `store.ts`); `THEME_MAX_BYTES`, `SHIPPED_THEME_IDS`, `HARD_TEXT_FLOOR` (3) and the ANSI gates
  (`schema.ts`); `cli/theme-check.ts` runs the same parser.
- Rule 6: `resolveMarkId` (`web/src/lib/mark.ts`); `MARKS` (`web/src/lib/mark-ids.ts`);
  `DesignPrefs.mark` (`design.ts`); the idle lock, tour, agent start and boot draw `CollieMark` direct.
- Rule 7: `web/src/components/mark-contract.ts` (sealed, from collie-brand); `mark-conformance.test.tsx`;
  `loadChunk` and the error boundary (`brand-mark.tsx`); `keepOnFirstUse("/marks/")` (`web/src/sw.ts`).
- Rule 8: `components/icons/keys.ts` and `<Icon>` (`icon.tsx`, `data-icon`); `GLYPH_SETS`
  (`web/src/lib/glyph-sets.ts`); `web/vite-glyphs.ts`; `keepOnFirstUse("/glyphs/")` in `sw.ts`.
- Rule 9: `resolveMarkMoves`, `useMarkMotion`, `STEPS_CLASS` (`web/src/lib/mark-motion.ts`);
  `DesignPrefs.markMoves`; `.mark-steps`, the `data-page-hidden` and `data-app-covered` pause and
  `.status-turn` at `steps(24)` in `web/src/index.css`; `web/e2e/idle-repaint.spec.ts` (at most 16
  frames a second at rest, 0 with the switch off) and `web/e2e/mark-moves.spec.ts`.
- Rule 10: `SHIPPED_FONTS` (`web/src/lib/shipped-fonts.ts`); `DEFAULT_FONT`, `fontClass` (`design.ts`);
  `--font-sans` and `:root.font-*` in `index.css`; `setActiveTheme` (`store.ts`).
- Rule 11: `OPERATOR_FONT_FAMILY_PATTERN`, `isOperatorFontFile`, `MAX_OPERATOR_FONT_BYTES` (2 MiB),
  `resolveOperatorFont` (`bridge/operator-fonts.ts`); its twin `web/src/lib/operator-fonts.ts`.
- Rule 12: `MIRROR_SPACE`, `MIRROR_INVERT` (`web/src/components/mirror-space.ts`); `rendersNativeMirror`
  and `NATIVE_MIRROR_AGENTS` (`lib/harness/muse/display.ts`); 32 overrides (`lib/mirror-invert.ts`).

## Recorded, not found in the code

- ADR 0138 rule 4, "no backdrop blur covers a moving part": `status-area.tsx`, `queued-block.ts` and
  `terminal-draft-preview.tsx` follow it in comments; no test holds it.
- ADR 0106: the zero-pixel exit test ran per M57 branch; no standing check holds it.

## Consequences

- Every colour a component draws must be a token, or a theme cannot reach it (`DESIGN.md` section 13).
- A new character is a generator entry in collie-brand, a row in `MARKS` and a loader case; a new
  icon set is a row in `GLYPH_SETS` and a map of every key. The suite and the compiler name gaps.
- The drift costs about 12 frames a second on a visible page; the switch and `characterMotion` stop it.
- An operator font shifts layout once when it swaps, and has no pre-paint path until it is cached.
  0002 stays live beside this record: why the mirror is inverted, not re-themed with a light palette.

## What we tried before

- 0002, 0047: the mirror inverts in light; Muse is the one agent bit; the per-pane override came later.
- 0033: the face was the maker's choice; then a device setting (Space Grotesk, Aldrich, Atkinson).
- 0106: a theme of colour tokens only; version 2 added shape, palette and display face, and no mark.
- 0136, 0137: a theme names a character and a glyph set; then a device may choose the character.
- 0138: no animation at rest; then a drift while in use; then a stepped drift at rest too, a switch.
