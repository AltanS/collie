# 0170: Every setting is declared once, and Settings is its eleven pages

- **Status:** Accepted (2026-11-21). The operator approved the page names, the labels and the index lines on
  2026-11-21.
- **Date:** 2026-11-21
- **Trail:** The Settings card sort of 2026-11-21: eight readers sorted every row of Settings, of a pane's
  own sheets and of the views, into today's pages (four readers) and into pages of their own (four
  readers). The eight readers were language models, each given the cards and a reader's brief. It is no
  user research: it showed where the old pages were ambiguous and which groups readers made, and the
  operator decided the pages. Closed readers found 69% of the rows on the page they looked on first; the
  four open readers made the same seven pages. Files:
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
- **An id survives a move.** The first segment of an id is a namespace, not the page: today it reads like
  the page the row was declared on, and when a row moves its `page` changes and its id does not. The ids
  are public from this release on (a search result links to `/settings/<page>#<id>`), so
  `web/src/lib/settings/shipped-ids.json` lists every id that shipped, and a test fails when a listed id is
  neither declared nor a key of `ALIASES` (`pages.ts`, old id to new id, empty today), or when a declared
  id is missing from the list. Stability is promised for a row that holds a value (a switch, a choice, a
  number, a text): its id stays, or its value moves to a new id through an alias. An action, a link or an
  info row holds no value; its id may be retired through the alias table.
- **The registry declares; it moves nothing.** A row names who holds its value (device, machine, pane,
  profile) and how the value is stored today (a localStorage key, a field of a blob, a route, the
  browser). A store is a declaration, not an adapter: no code reads or writes a value through it. The card that sets it still writes through its own hook, so a value set in Settings and the
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
- **Old addresses redirect, for good.** A push already delivered, a crew member on an older Collie, a
  bookmark and an installed app's history carry them, so the redirects are never removed.
  `/settings/appearance`, `harnesses`, `device`, `alerts`, `experiments` and `system` (and the pages below
  them) open the page that holds most of what they held, with the query and the fragment. An old fragment
  (`#changes`, `#paired-devices`, `#install-count`, the only three the old pages answered to) picks its
  row's page, on an old page and on `/settings` itself, which the read-only banner and the Changes link
  used before 1.25. A row's id as the fragment of an old page opens the page that holds the row today.
  `web/src/routes/settings-redirect.test.tsx` holds every address a release tag emitted, with its target.
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
- A settings file can key on the ids later; nothing reads or writes one yet. The stores are declarations,
  not adapters, and stay so until a settings file is decided.

## Not decided here

A settings file would need more than the registry holds today. Each of these is left for the record that
decides the file:

- A default per row. Today the default lives in the hook or the blob's defaults object that owns the value.
- The values a row allows: the choices of a choice, the range and step of a number, the length of a text.
- A validator per row, so a file that names a wrong value is refused with a reason, not taken.
- The address of a per-item row (`each`): how a file names one harness, machine, trick or profile, and what
  happens to an entry whose item is gone.
