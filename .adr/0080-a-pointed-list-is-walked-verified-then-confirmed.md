# 0080: A pointed list is walked, verified, then confirmed

- **Status:** Accepted
- **Date:** 2026-10-02
- **Shipped in:** pending
- **Amends:** [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md), point 4 only. Points 1 to 3
  and 5 to 7 stand.
- **Trail:** `web/src/lib/prompt-action.ts` (`submitPromptOption`, `walkVerifyCommit`) ·
  `web/src/lib/harness/prompt-model.ts` (`splitWalk`, `sameKeysModuloWalk`, `promptsSameIdentity`) ·
  `web/src/lib/harness/menu-hints.ts` (`pointerWalk`) · `web/src/lib/dialog-guard.ts` ·
  `bridge/server.ts` (`checkPromptBinding`) ·
  [ADR 0078](./0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md) ·
  [ADR 0079](./0079-the-omp-model-picker-is-lifted-as-its-visible-window.md) · the Oh My Pi `/switch`
  picker marking a row `⦸ context>N` while the agent streams

## Context

**ADR 0055 point 4 chose one batch per tap.** A tap on a row of a pointed list sends
`[Down × n, Enter]` (or `Up`) as ONE `pane.send_keys` call, bound (`expected_prompt`) to the screen
the user tapped. The reason was sound on its face: the guard runs once, and no half-walked pointer is
left behind.

**It leaves two races that the binding cannot see.** The bridge checks the binding once, before the
whole batch. Nothing checks that the pointer stands on the target when the Enter lands.

1. A keystroke at the desk while the batch is in flight moves the pointer, and the Enter confirms
   whatever row it now rests on.
2. A row changes under the pointer. The concrete case is the Oh My Pi `/switch` picker (ADR 0079):
   while the agent streams, a row can turn into `⦸ context>N`, the over-context marker. The walk
   then lands on a different row, or the list shifts, and the Enter on a row that is not what the
   user tapped **compacts the session** instead of switching the model. That is a committed wrong
   row, and it cannot be undone.

**Oh My Pi's approval card patched the same hazard for itself.** ADR 0078 gave Deny a fixed
`Down, Enter` plan that leans on omp's list clamping, so any race ends on a denial. That special case
protects one card on one harness, and the picker above shows it does not generalise: a plan cannot be
shaped so that every race is harmless. The fix belongs where the keys are sent. The other change set
for ADR 0078 removes the special case.

**Without it, one gap stays on omp's card.** With a plain `Enter`, a tap on Deny with the pointer on
Deny could become an approval inside the milliseconds between the bridge's re-read and its send: a
desk `Up` lands in that gap and the `Enter` confirms Approve. That is the direction ADR 0078 forbade.
Point 6 restores it.

**A half-walked pointer with nothing committed is harmless.** It is a highlight, and the card
re-derives it on the next poll. A committed wrong row is not harmless. ADR 0055 weighed the first
against the second the wrong way round.

## Decision

**A tap on a pointed row is walked, verified, then committed. The rule is generic for every harness
and lives only in the action layer.**

1. **`splitWalk(keys)`** (`harness/prompt-model.ts`) returns `{ walk, commit }` exactly when `keys` is
   `(Up|Down|Left|Right)* Enter`, with the walk possibly empty, and `null` for everything else:
   digits, `["y"]`, `["Escape"]`, `["1", "Enter"]`, and a lone arrow such as the back key `["Left"]`.
   A list may run down the screen or along it (opencode's permission chips walk `Right`). One plan
   uses one direction.
2. **`sameKeysModuloWalk(a, b)`** is true when both plans are walk-class, otherwise exact equality.
   `promptsSameIdentity` compares option keys with it. The walk is a claim about where the pointer
   stands, and the pointer is our own choreography's effect, which `coreSignature` already blanks.
   `promptsEqual` still compares the byte-faithful `signature`, which carries the pointer, so a stale
   tap is still refused at entry. It also compares every option's exact plan. For a grammar that draws
   the pointer as a glyph this adds nothing, because the signature already moved. For one that draws
   it as a style only (opencode's chip background), the text is the same with the pointer anywhere,
   and the plans are the only trace of the pointer, so this line is what refuses its stale tap.
3. **`submitPromptOption` does three things for a walked option** (`splitWalk` non-null with a
   non-empty walk):
   - the entry guard, then the arrows, bound to the region of the screen the user tapped;
   - a poll until a fresh read shows the SAME dialog (`promptsSameIdentity`) with the tapped row's
     plan now exactly `["Enter"]`, meaning the pointer stands on it. A poll that ends in drift OR
     timeout sends **nothing** and answers `changed`: the pointer may be anywhere and nothing is
     committed;
   - one more read, which must still show the pointer on the row, and then `Enter` bound to THAT
     read's region. This is the same last step as `submitPromptFeedback`.
4. **Everything else is unchanged.** A plan with no walk (a digit, or `["Enter"]` on the pointed row)
   is one guarded, bound write.
5. **A grammar MUST carry the pointer verbatim in `signature` and blank it in `coreSignature`. It MUST
   build its plans with `pointerWalk`. It MUST NOT special-case a plan to survive a race.** The
   action layer survives the race for every harness; a per-harness plan shape is a second, weaker
   guard and is refused in review. The conformance suite checks that every walk-class plan is arrows
   in one direction before its Enter, and that at most one option carries the plan `["Enter"]`.
   **A grammar's `coreSignature` MUST blank everything the pointer's own move changes.** That is the
   glyph and any text that follows the pointer: a detail row under the list, a description of the
   highlighted row, a position counter such as "(n/m)". The verify step compares the fresh read with
   `promptsSameIdentity`, so text that follows the pointer makes every walked tap answer `changed`
   and never commit. The omp `/switch` picker shipped this defect: it rewrites its two detail rows
   for the pointed model, and a live test found it, because no test had compared two REAL captures
   of one picker with the pointer on different rows. **Text that changes with the clock when the
   screen redraws is the same class.** A relative age (`1 minute ago`, `just now`) ticks between the
   arrows and the verify read with no key pressed, so a resume picker that kept it in `coreSignature`
   answers `changed` after a minute. The grammar blanks the age in `coreSignature`, and only there:
   `signature` keeps it verbatim, so the entry guard still refuses a tap on a screen whose age
   ticked (the trade ADR 0058 records), and the final Enter is still bound to the fresh verbatim
   read. It blanks the one token its own row parse located, never a pattern run over the whole
   region. The Claude and Oh My Pi `/resume` pickers do this.
   **Twin rows keep their ages.** Two sessions with the same title and the same meta row apart from
   the age (same size, branch, marks) are told apart only by the age. With ages blanked, a re-sort
   that swaps them during the walk would pass identity, and the Enter would resume the other session.
   So when two or more sessions are identical in title and in meta-minus-age, `coreSignature` keeps
   the ages of those sessions verbatim. Every other session still gets the age token. A tick on such
   a row then makes a walked tap answer `changed`, which is the safe side. **Every blank is a safety
   decision.** `coreSignature` is the only link between the dialog the user tapped and the Enter that
   is committed after the walk. So each grammar ships mutation tests for both directions: what the
   blank must hold (every age shifted, a detail row replaced) and what it must refuse (a title, a
   size, an id, a badge, a mark or a row changed, removed or swapped). A grammar whose pointer is only a
   style, so that it cannot appear in `signature` at all, carries the pointer in its option plans
   (point 2). **The corpus MUST hold such a walk pair for
   every grammar that emits walked plans.** `harness/walk-pairs.ts` declares the pairs, and the
   conformance suite (`describeAdapterConformance`, "walk pairs") asserts for each that the two
   captures are `promptsSameIdentity` both ways, not `promptsEqual`, and that the row with the plan
   `["Enter"]` differs. It reads the walked fixtures off the adapter over the whole corpus, so a
   grammar cannot opt out, and it fails for a grammar group (agent, family, dialog title) that has
   neither a declared pair nor a dated one-line gap in `WALK_GAPS`. The set of gaps is pinned by a literal list in the suite and only shrinks: a new gap needs a second capture first. The message says to capture the same
   dialog with the pointer on another row.

6. **A clamped list commits an edge row with a sticky arrow.** A grammar whose source or capture
   proves that its list clamps (Up on the first row and Down on the last row leave the pointer where
   it is) sets `clampedEnds: true` on its model. For a walk-class plan `["Enter"]` or `[arrows…,
   "Enter"]`, the commit batch is then `["Up", "Enter"]` when the tapped option is the FIRST row of
   the list, `["Down", "Enter"]` when it is the LAST, and `["Enter"]` otherwise
   (`commitKeysFor`, `harness/prompt-model.ts`). The walked case sends that batch bound to the fresh
   read, after the verify step; the pointed row (no walk) guards with `commits` and sends the same
   batch bound to the guarded region. The verify predicate does not change: the fresh model's tapped
   row must still carry the plan `["Enter"]` before the commit goes out. **Why it is safe:** on a
   clamped list the extra arrow toward the edge is a no-op when the pointer is on the edge row, and a
   desk arrow that landed in the last gap before the send is pulled back onto the edge row. **The
   caveat is hiding rows.** First and last mean the first and last ROW OF THE LIST AS THE ARROWS SEE
   IT, that is the first and last option with a walk-class plan; an option with another plan (omp's
   `Cancel`, which sends `Escape`) is not a row. A grammar that hides rows from `options`, as the omp
   `/switch` picker hides over-context and current rows, or one whose list wraps, must never set the
   field: the visible edge is then not the real edge, and the extra arrow would move the pointer
   onto a row nobody tapped. **This is the ONE place a grammar may hand the action layer a fact
   about its list.** It is a fact, proven by source or capture and never guessed. A grammar still
   never shapes a plan: plans stay the plain walk (point 5). `promptsSameIdentity` requires equal
   `clampedEnds`, so the guard refuses a model that gained or lost the fact.

## Consequences

- **One extra read, about 350 ms, per walked tap.** A tap on the pointed row itself costs nothing
  extra.
- **A walk can leave the pointer moved with nothing committed.** The card then re-derives from the
  screen and the user taps again. This is the accepted cost; ADR 0055 point 4 was trying to avoid it.
- **Where a harness shows its pointer only as a style, the bridge cannot see it.** The bridge's text
  binding compares screen text, and opencode's permission chips differ from one another by a
  background colour, so the same binding matches with the pointer on any chip. Before this ADR the one
  batch had the same blind spot: the bridge never saw a style-only pointer, and nothing checked the
  pointer between the arrows and the Enter. Now the phone's read verifies the walk: the tapped chip
  must carry the plan `["Enter"]` before Enter goes out. The window that remains runs from that verify
  read to the send. It is larger than the window of a text-visible pointer, where the bridge's own
  re-read sees the pointer. opencode's "Always allow" opens a second confirm step (`Confirm` and
  `Cancel`, see `web/src/lib/harness/opencode/PERMISSION_NOTES.md`). So a one-chip slip from "Allow
  once" lands on a confirm dialog, not on a standing grant.
- **The race window is smaller, not gone, and for an edge row of a clamped list it is covered.**
  What remains is the milliseconds between the bridge's own re-read and its send (see
  `checkPromptBinding` in `bridge/server.ts`). Point 6 covers that gap for the first and last row of
  a list that declares `clampedEnds`, which is both rows of omp's approval card. For every other row
  it remains. Closing it fully needs a conditional send in the multiplexer, which neither Herdr nor
  tmux has.
- **Supersedes ADR 0055 point 4 only.** The rest of 0055 stands: the shape, the dialog's own words,
  the keys, the visible default, the pointer as visible state, and the numbered shape untouched.
- **Revisit** if a multiplexer gains a send that is conditional on the screen, or if a harness prints
  a pointed list whose Enter commits a different row than the one the pointer shows.

### Follow-ups

1. Answer opencode permissions over its HTTP channel by id. That removes the pointer.
2. Add a bridge-side pointer check for style-only pointers.
3. Let the poll return its last model, so the commit needs no extra read.
4. Let a drift refusal report which field differed, so a harness drift is a one-line diagnosis.
