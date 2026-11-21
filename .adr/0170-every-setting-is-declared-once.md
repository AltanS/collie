# 0170: Every setting is declared once, and Settings is its eleven pages

- **Status:** Proposed (2026-11-21)
- **Date:** 2026-11-21
- **Trail:** The Settings card sort of 2026-11-21: eight readers sorted every row of Settings, of a pane's
  own sheets and of the views, into today's pages (four readers) and into pages of their own (four
  readers). Closed readers found 69% of the rows on the page they looked on first; the four open readers
  made the same seven pages. The operator approved the eleven page names and the label table. Files:
  `web/src/lib/settings/` (`types.ts`, `pages.ts`, `registry.ts`, `index.ts`), `web/src/routes/settings-sections.tsx`,
  `web/src/components/setting-slot.tsx`, `web/src/components/settings-search.tsx`, `web/src/lib/nav.ts`.

## Context

Settings had nine pages (Appearance, Harness configurations, Device, Voice, Alerts, System, Machines,
Experiments, Tricks) and a growing number of values that had no Settings row at all: the pane view, the
Chat text size, the short form of long replies, wrap, the whole last reply, the raw terminal and tap to
type lived only in a pane's Display sheet, and the Keys pad's editor only in its tray. Appearance held 24 of
34 rows, Device and System read alike to every reader, and a person who looked for a value in Settings
and did not find it concluded it did not exist.

Nothing listed the settings. A page was a column of cards, and the only record of which value a card set
was the card's own code. So a search could not be written, a test could not say a value was unreachable,
and a later settings file (one file a person edits for all devices) had nothing to key on.

## Decision

**Every setting is declared once, in `web/src/lib/settings/registry.ts`, and the pages, the search and the
tests read that list. Settings is eleven pages.**

- **One row, one id.** A row has a stable dotted id (`look.math`, `notifications.load.cpu`), never reused
  once shipped. Its label and hint are plain `en.ts` keys, so a word change is one line. A row drawn once
  per item (a harness, a machine, a trick) keeps one id; the item is the value's key.
- **The registry describes; it moves nothing.** A row names who holds its value (device, machine, pane,
  profile) and how the value is stored TODAY (a localStorage key, a field of a blob, a route, the
  browser). The card that sets it still writes through its own hook, so a value set in Settings and the
  same value in a pane's sheet are one value.
- **One place per value, and the pane's own sheet.** A value has one Settings row. Its second place may
  only be the pane's own sheet or menu (`also`). A value that lives only in a pane, a view or the New
  page is declared too, with that place as its page; the search says where it is and links nowhere.
- **The eleven pages**, in this order: Look and feel, Chat and terminal, Keys and touch, Notifications,
  Voice, Dashboard and projects, Profiles, Tricks and the Hill, Devices and machines, Privacy and data,
  Updates and about. The index draws Updates and about first, because its line changes without you.
  Profiles shows while the machine offers profiles; every other page is always on the index. Machines is
  a row of Devices and machines, not an index row.
- **Marks, not copies.** A page wraps each control in a `SettingSlot` naming the ids it draws. The marks
  are what the tests read and what a search result scrolls to (`/settings/<page>#<id>`, marked for two
  seconds in the focus frame's colour).
- **Old addresses redirect.** `/settings/appearance`, `harnesses`, `device`, `alerts`, `experiments` and
  `system` (and the pages below them) open the page that holds most of what they held, with the query
  and the fragment; an old fragment (`#changes`, `#paired-devices`, `#install-count`) picks its row's page.
  The redirect is an element, because a loader's request carries no fragment.
- **Experiments are marked on their rows.** The Experiments page and its notice are gone. Each
  experimental row wears the Experimental badge and carries the notice's sentence in its hint.

## Consequences

- `registry.test.ts` fails a saved key of the app that no row stores into and `NOT_SETTINGS` does not
  explain, an id or a key that does not exist, and a route nobody calls. `settings-marks.test.tsx` renders
  every page and fails a Settings row no page marks. A new preference is declared in the same change.
- The search is the registry's: it finds a pane's own rows by the words of where they are, and a row
  shown only in a state (push off, no crew) says why in one line.
- Some cards split across headings (Notifications' switches stand under three) through a part prop of
  the same card, not a second card.
- A settings file can key on the ids later; nothing reads or writes one yet. Revisit the store
  descriptors when it does: they are declarations today, not adapters.
