# 0153: The first frame paints from a remembered shape

- **Status:** Proposed
- **Date:** 2026-11-17
- **Trail:** Altan's report of 2026-11-17 ("lots of layout switches when I load the settings page",
  the header word that moves right on a reload), the calm-load survey of the same day (27 findings,
  five causes), and the roads argued for and turned down there: keep the fail-open "capable" default
  of `web/src/lib/mux-capability.ts` and accept the swap; move a late card (the install card, the
  telemetry notice) to the end of the page; remember the last label, count or row so the first frame
  can draw it in full; key a remembered answer per machine. Files: `web/src/lib/remembered-shape.ts`,
  `web/src/lib/remembered-mux.ts`, `web/src/hooks/use-bounded-hold.ts`, `web/src/lib/operator-config.ts`,
  `web/src/lib/mux-capability.ts`, `web/src/lib/authed-url.ts`, `web/src/lib/wipe.ts`, `DESIGN.md` §2

## Context

DESIGN.md §2 already says every layout shift is a defect. The phone still shifted on almost every
cold load, and the cause was one pattern in many places: a part depends on a read that ends after
the first paint (`/api/config`, the tricks and Hill stores, the launchers and accounts reads, the
bytes of a picture), and it has no reserved place and no remembered answer. The first frame drew a
guess, and the read moved what the person was reading or about to tap.

The read cannot simply be awaited: a cold open must paint at once, offline and from cache too. A
reserved box alone is not enough either, because for many parts the question is whether the part is
there at all, and a box for a part most devices never show is its own defect. What the device does
know is how the page looked the last time it was opened here.

## Decision

1. **Paint the first frame from a remembered fact on the device.** The fact answers "is this part
   there, and how big", never "what is in it". Only three kinds exist: a boolean, a whole number from
   0 to 99, or one word from a fixed list. Never an identity, a name, an email, a path, a label, a
   message, a URL, an operator row, or the count of something private. The `ANSWERS` table in
   `web/src/lib/remembered-shape.ts` is the only way to name a fact, and its types make any other value
   impossible. Do not write a second store for the same purpose.
2. **One key per fact, per mount, never per machine or pane.** Keys are
   `collie:shape:<mount>:<name>`. A host name or a pane id in a key would be an identity, so a fact
   about a crew member or a session card is not remembered; those parts keep their earlier behaviour
   until their own read lands.
3. **The device wipe reaches every fact.** `lib/wipe.ts` removes the whole `collie:shape:` prefix on
   unpair, revoke and expiry, and `lib/storage-keys.test.ts` holds the prefix. A first visit and a
   wiped device have no memory and paint as before this record.
4. **A real read always wins.** The fresh answer replaces the remembered one in full and is written
   back for the next load. A remembered fact never outlives one read on the page.
5. **The multiplexer's capabilities: last known, else capable; a real read replaces it.** The front
   machine's declared capabilities (`yes`, `no`, `unsaid`), its `spaces` word and whether a speech
   provider was offered seed the config store at module load (`lib/remembered-mux.ts`). With no memory
   the fail-open default of `mux-capability.ts` holds. A remembered "not capable" must never hide a
   control after the real read says capable (tested). The name, the notes, the mark, the refused keys
   and every operator row stay unremembered: a note that explains an absent capability arrives with
   the read. The microphone is seeded as a disabled placeholder in its slot, never as a working one.
6. **Where a part is known to come, hold its box at the final size.** An invisible copy of the part
   (the crew-state bar, the install card) or a quiet box (`h-40` for a picture with no size on the
   wire) holds the place, and the part replaces it, never sits beside it.
7. **Never put a part into the middle of a page after the first paint.** Wait for the read inside a
   bounded time, `CALM_HOLD_MS` (400 ms, `hooks/use-bounded-hold.ts`), or add the part at the end.
   The bound is counted from the mount and cannot be extended; past it the page draws as it did
   before. An answer that arrives later does not open a part above a painted list on that load.
8. **A wrong statement on the first frame is fixed before a mere jump.** The Hill does not draw its
   "clear" ridge while it has no list and the snapshot says the Hill exists.
9. **The settled look does not change.** A fix may not add a part, make a part always visible, move a
   part, or add a sentence. A case that needs one of those goes to the operator first.
10. **A picture already fetched is there on the first render.** `lib/authed-url.ts` keeps the resolved
    object URLs in memory beside its promises, never in storage.

## Consequences

- The second cold load on a device paints the page where it will stand: the dashboard of a machine
  with no screen, the Spaces controls on tmux and zellij, the Launch header, the Settings rows, the
  Hill. The first visit, a wiped device and a crew member's own answer still shift once.
- A stale fact can be wrong for one read: a capability withdrawn since the last visit is offered until
  the read lands, and a part that is gone holds its box until then. That is the same bounded cost the
  fail-open default always had, now in both directions, and a real read ends it.
- Each new late part costs one `ANSWERS` row, and the table's types refuse a value that is not a
  shape. A reviewer checks the row's meaning (a flag, not a tally of something private).
- Some parts wait up to 400 ms on a cold open with nothing in their place: the Hill with no list yet,
  the dashboard while an unspent telemetry notice is asked for, the belt's harness section for an
  operator with remembered bar rows, the Voice hub. A slower bridge still shows the old behaviour past
  the bound.
- Revisit when the wire carries a picture's size (a true aspect box replaces the `h-40` guess), when a
  part needs a per-machine fact (that needs a key form that is not an identity, and a new record), or
  when a measured trace shows the 400 ms bound is felt as a wait.
