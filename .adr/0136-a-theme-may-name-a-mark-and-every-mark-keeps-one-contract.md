# 0136: A theme may name a mark, and every mark keeps one contract

- **Status:** Accepted
- **Date:** 2026-11-08
- **Shipped in:** pending
- **Amends in scope:** [ADR 0106](./0106-a-theme-is-a-closed-file-of-named-tokens.md), item 1 of its
  amendment of 2026-10-16 ("the mark is gone"): a theme may name a header mark again, from a closed list.
- **Trail:** ADR 0106's amendment of 2026-10-16, where M57 spec 13 removed the theme's `mark` field after
  Altan called the first marks on quality · Altan's brief of 2026-11-08 for the theming release (two more
  marks for a different crowd, pickable in Appearance and in a theme file), then the same day: "make sure we
  have the right internal contract for these brand marks, so that we can colour the beads, spin speed etc."
  · the host code that reached into the Collie mark: `index.css` (`.collie-applying .cm-b circle…`,
  `.collie-reconnected …`) and `components/collie-home.tsx` (a `getAnimations()` filter on keyframe names)
  · `web/src/components/mark-contract.ts` (a sealed copy of collie-brand `src/mark-contract.ts`) ·
  `web/src/components/brand-mark.tsx` · `web/src/lib/mark-ids.ts` · `web/src/lib/mark.ts` ·
  `web/src/lib/theme/schema.ts` · `web/src/components/mark-conformance.test.tsx`

## Context

ADR 0106 kept the Collie dog the same under every theme, after a first `mark` field shipped marks that did not
meet the bar. On 2026-11-08 Altan asked for the opposite: the current mark reads as masculine, and the theming
release should offer marks in other design languages, each still a border collie with beads on an orbit,
chosen per device in Appearance and named by a theme. The new marks come out of the collie-brand pipeline
(one artwork origin, one generator, a sealed file), and Altan picked them by name from a playground.

The same day showed the second problem. Collie now uses the mark for its loading states: a spin round on a
status, a steady turn while busy, a recolour while the app updates and for one turn when the link returns, a
dimmed mark while offline. The host did that by naming the Collie mark's private parts in a stylesheet and
by filtering its animations by keyframe name. With four marks that already needed a table of prefixes, and
each further mark would break it quietly: a bead drawn as a `rect` instead of a `circle` simply stayed grey.

## Decision

1. **A theme may name a mark.** The optional `character` key takes one word from the registry's closed list
   (`collie`, `kawaii`, `kawaii-tilt`, `pixel`, `glass`, `glass-front`, `delft`, `delft-front`, `sheep`). A file
   that sets it is version 4, the lowest version that holds
   it; a file without it reads and exports exactly as before. Collie is the default everywhere. A person reads
   the word "Character" for a mark, in Settings and in the docs; the code says mark. The key is not `mark`,
   the name the removed field of M57 spec 09 had, so a file written for that design is refused, not misread.
2. **The device decides first.** Appearance offers "From the theme" (the default) and every character. A device
   choice other than "From the theme" wins over the theme; a theme without `character` draws Collie. The favicon,
   the app icons, the splash and the link card stay the Collie mark.
3. **A mark other than Collie costs nothing until it is chosen.** Each is a lazy chunk under `marks/`, outside
   the precache, kept by the service worker on first use. A chunk that cannot load draws the Collie mark.
4. **Every mark implements one contract, `mark-contract.ts`.** It is hand-written in collie-brand, where the
   generators emit against it, and consumers copy a sealed copy beside the marks. It holds the semantic states
   (`rest`, `loading`, `applying`, `reconnected`, `idle`), the one turn table, the state colours (the status
   tokens), the props (`size`, `weight`, `paper`, `title`, `className`, `state`, `beads`, `turn`, `ref`), the
   variables (`--mark-turn`, `--mark-bead`, `--mark-bead-<i>`, `--mark-accent-1`, `--mark-accent-2`,
   `--mark-ink`, `--mark-paper`), the root attributes (`data-mark`, `data-state`) and one handle, `setRate`.
   A mark is its drawing plus one call into that runtime.
5. **Everything else in a mark is private.** The host never names a mark's classes, parts, keyframes or
   custom properties. It says what (a state, bead colours, a turn) and the mark decides how, in its own idiom.
   Every state differs from `rest` by colour, so it still reads under reduced motion.
6. **A conformance suite runs over the registry.** Every registered mark must pass it: each state at both
   weights, bead colours by prop and by variable, the turn by prop and by variable, the phase carried across a
   change, the rate handle, no keyframe name outside its prefix, and a size budget. A mark that fails it
   cannot ship, because registering it puts it under the suite.

## Consequences

- The host lost its two doors into the Collie mark: the applying and reconnected rules left `index.css`, and
  the spin round drives the mark through `setRate`. `collie-mark.tsx` was regenerated on purpose; its look is
  pixel-identical at rest and loading, proved by a pixel comparison in collie-brand.
- The website copies the Collie mark, so it now copies `mark-contract.ts` too.
- A new mark is a generator entry in collie-brand, a row in `mark-ids.ts`, a loader case in `brand-mark.tsx`
  and the sealed file. The suite then decides whether it ships.
- The turn table is one table for every mark. A mark that wanted its own pace (the first pixel mark drifted at
  96 seconds) gives that up, because a spin round and the reconnection's single turn are timed in turns.
- Revisit if a mark needs a state the five do not cover: add it to the contract, never to one mark.
