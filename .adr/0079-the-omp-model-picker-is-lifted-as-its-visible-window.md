# 0079: The omp model picker is lifted as its visible window

- **Status:** Accepted
- **Date:** 2026-10-02
- **Shipped in:** 1.16.0
- **Amends:** [ADR 0076](./0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md),
  in scope, twice. The compact model picker that 0076 left raw with the Escape card is now a card in
  its session state. And the modal gate of 0076 point 1 accepts ONE segment after the way out, the
  picker's task-mode toggle, so the picker's declined states keep their Escape card. Everything else
  in 0076 stands, as do [ADR 0077](./0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md)
  and [ADR 0078](./0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md).
- **Related:** [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md) carries the guarantee that a tap on this picker's rows is walked, verified, then
  confirmed. Points 2 and 4 and the residual-risk bullets below are written to it.
- **Trail:** the road this closes is a picker that types into its own search box from the card, and
  a card that carries the whole model list; both were weighed and refused below ·
  `web/src/lib/harness/omp/switch.ts` (`detectSwitchPickerRegion`) ·
  `web/src/lib/harness/omp/SWITCH_NOTES.md` · `web/src/lib/harness/omp/modal.ts` ·
  `web/src/lib/harness/omp/index.ts` · `web/src/fixtures/panes/omp--v18-4-switch*.txt` · pi-tui
  `overlays/model-picker.ts` and `overlays/model-browser.ts`, the coding agent's
  `modes/controllers/selector-controller.ts` and `session/model-controls.ts` (omp 18.4.10) ·
  [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md) ·
  [ADR 0058](./0058-the-resume-picker-commits-with-enter.md)

## Context

**omp switches the session's model from a compact picker.** `/switch` with no argument, or Alt+P,
opens a box at the bottom of the pane: a search row, a window onto about 840 models (recent ones
first, then a rule, then the rest), two detail rows about the pointed model, and the footer
`↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close · Alt+P task model`.
Enter switches the live session to the pointed model for this session only. No config file is
written.

Under 0076 the phone showed none of it as a card. Worse, the footer ends one segment past its way
out, so 0076's gate did not see a modal at all, and the picker got no Escape card either.

The 2026-10-02 captures (omp 18.4.10, 23 screens, three pane widths, three window heights) and the
source add what makes this picker different from `/resume`:

- **The list is far taller than the window**, and the window's height follows the pane:
  `max(5, floor(rows × 0.4) − 9)` rows.
- **Up and Down wrap** at the list's ends, and skip the rule between the recents and the rest.
- **Some rows are not a switch.** A model whose context window the transcript has outgrown is marked
  `⦸ context>N`. Enter there compacts the session with the current model first, then switches.
- **A narrow pane shortens rows with `…`**, so a row's id is not always on screen.
- **Typing searches at once**, and a leading `@` turns the picker into a quick-roles list that
  applies a role's model AND its thinking level. Alt+P turns it into the task-model picker, which
  sets what spawned subagents run.

## Decision

**The session state of the picker is a card: its visible window, each row by its full id, walked
from the pointer, plus Close. Everything else declines and keeps the Escape card.**

1. **The card is the visible window, not the list.** One button per model row on screen. A walk
   between two rows on screen never wraps and never scrolls, so ADR 0055's walk is exact. A card
   for the whole list would need a walk past the window, which scrolls it and can wrap. That would
   tie a tap to rows the person never saw. Refused.
2. **Up or Down from the pointer, then Enter**, counted over model rows, because omp's list skips the
   rule. The action layer walks, verifies, then commits ([ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md)): it sends the arrows bound to the
   tapped screen, reads the pointer back, and sends Enter only bound to a fresh read that shows the
   pointer on the tapped row. All keys are in the footer, so this is inside ADR 0009's rule. No digit.
   The pointed row sends Enter alone. The current model is not offered (point 3), so the pointed row is offered only
   when it is another model.
3. **The label is the whole `provider/id`.** A row shortened with `…` is not offered, because its id
   is not all on screen. An over-context row is not offered, because Enter there is a compaction,
   not a switch. The CURRENT model is not offered, because Enter on it re-applies the model the
   session already runs: no config write, but omp still records the pick, logs a model change, resets
   the provider session and so loses the prompt cache, for no change of model. All three still count
   in every other row's walk, because Up and Down stop on them. The card's accessible name ends with
   `● current: <id>` when a marked row with its full id is on screen, so the person still sees which
   model runs. The badges (intelligence, speed, context, price) are the description, shown as labels
   and never parsed for an id, and no longer start with `● current`.
4. **The last row is the footer's way out, sending Escape, labelled for what that tap does.** Its
   description is the footer's own `type to search` segment, so the card says how to reach models
   outside the window. omp's first Escape clears a typed search and closes the picker only when the
   search is empty, so the label is the footer's verb, `Close`, while the search row is empty, and
   `Clear search` while it holds text (the card then re-renders as the full list).
5. **No search from the card.** The card types nothing into the search box. The person searches with
   the Keys drawer or with Type mode, and each keystroke changes the signature, so a stale tap is
   refused and the card re-derives on the next poll. A search field on the card would type into a
   live terminal on every character, and `PromptModel` has no field for it. Refused for now.
6. **The race guard is 0076's.** The signature is the whole box verbatim, title through bottom
   border, rows trimmed of trailing space: the pointer column, the search text, every window row, the
   scrollbar thumb and both detail rows. The core signature blanks the pointer alone. A region over
   32000 characters declines.
7. **The card starts at the window.** The title, status sentence and typed search stay in the raw
   mirror above it, as the approval card leaves its body there (0078 point 4).
8. **Fail closed on the exact session footer**, character for character, plus the exact title and
   status sentence, the search row, a window of 5 to 60 rows of known shape, one pointer, at most one
   current mark and one rule, badges that each read as a known column, and a chips row that agrees
   with the pointed row, and at least one model row the card can offer (never the current model, so a
   window offering only that row declines). So the quick-roles state, the task-model state, a search with no match, the
   Nerd Font and `ascii` presets, a rebound key, a clipped footer, a config error and any unknown row
   decline.
9. **The modal gate accepts the task-mode toggle after the way out.** `ompModalOnScreen` reads a
   footer that ends `⎋ close · Alt+P task model` or `… · Alt+P session model` as a modal, and nothing
   else past the way out. Without this, the four declined states that print a way out would have no
   card at all.

## Consequences

- **An operator can switch the session's model from the phone**, among the rows the window shows.
  The switch is session-only, as at the desk.
- **A model off screen needs a search first**, typed through the Keys drawer or Type mode.
- **The window follows the pane's height**, so a short pane offers as few as five rows. Heights
  between the captured 5, 15 and 16 are read as the same layout. That is a deliberate reading of a
  rule omp computes, not a capture of each height.
- **The current model is named on the card and not tappable.** A tap on it would re-apply the same
  model and reset omp's provider session, which loses the prompt cache and switches nothing (point 3).
  A window whose only offerable row is the current model declines, and the Escape card stands in.
  Residual risks counsel named, and where each stands now:
  - A streaming agent can push a row over the context limit between the poll and the tap. Enter then
    compacts the session instead of switching. Covered by [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md): the walk is sent first, the
    pointer is read back, and Enter is bound to that read, so a row that turned over-context is no
    longer offered and no Enter is sent. The residual window is the bridge's own read-to-send gap of a
    few milliseconds, closable only by a conditional send in the multiplexer, which does not exist.
  - A key typed at the desk between two keys of the walk lands in the picker. Covered the same way:
    the fresh read must show the pointer on the tapped row, so a moved pointer or a changed search
    sends no Enter. The same residual window applies.
  - A typed search makes the first Escape clear the search. Resolved by the label in point 4: the
    last row reads `Clear search` while a search is typed and `Close` when it is empty.
- **The 74-column picker gets nothing.** omp clips the footer before its way out, so neither the card
  nor the Escape card can stand on it, like `/tree`.
- **The splash above the picker pans as a table again** (`table-run.test.ts`), since it is a raw
  block above a card now.
- **Live verification is partial.** Every walk was checked against a sandbox pane on 2026-10-02 by
  sending the walk without Enter and reading the pointer back, with the one-batch plan that
  [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md) replaced. No tap went through the paired card, and no Enter was sent. `SWITCH_NOTES.md` lists what remains for the maintainer.
- **Revisit** when omp prints a page key in the footer, changes what Enter does on an over-context
  row, adds a field to the row, or when a capture shows the Nerd Font preset as a lift candidate,
  the quick-roles state or the task-model state as their own cards.
