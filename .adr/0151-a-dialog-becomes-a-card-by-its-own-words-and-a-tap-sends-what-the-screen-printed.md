# 0151: A dialog becomes a card by its own words, and a tap sends what the screen printed

- **Status:** Accepted (2026-11-16). Amended in scope by [ADR 0142](./0142-when-collie-is-not-sure-the-person-decides.md) (rule 2, 3f; not built yet)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0054, ADR 0055, ADR 0056, ADR 0058, ADR 0059, ADR 0061, ADR 0076, ADR 0077, ADR 0078, ADR 0079, ADR 0098, ADR 0108, ADR 0133
- **Retires:** ADR 0072 (rule in `web/src/lib/table-run.ts`)
- **Trail:** the `/model` digit probe of ADR 0009, the owner's `/effort` slider of 2026-09-21, the
  owner's asks to put a card down and to dock it in one place, the counsel on ADR 0078 (a six-row cut
  of a write), issue #354 (bind the ticking rows), PR 397 and issues 412, 416, 455 (a grammar per pi
  extension), issue #372, PR 336, the trouble tally of 2026-11-07. Files: `web/src/lib/harness/`
  (`menu-hints.ts`, `prompt-model.ts`, `conformance.ts`, `claude/`, `omp/`, `pi/`),
  `web/src/lib/prompt-action.ts`, `bridge/prompt-binding.ts`, `web/src/components/card-dock.tsx`

## Context

An agent asks the person things on its own screen: a picker, a permission, a question, a scale.
Collie lifts such a dialog into a card, and a tap types keys into a live terminal. About twenty
records shaped this one dialog at a time. An unread screen and the hard stops belong to ADR 0142;
ADR 0080 (walk, read back, confirm) and ADR 0113 (the AskUserQuestion field) stay live.

## Decision

1. **A dialog becomes a card only by its own words.** A grammar names its dialog by its title, body
   or exact footer, and fails closed: a shape no capture shows declines. A family test that makes other
   grammars stand down answers from the dialog it names, never from one line any screen may print. The
   generic menu runs after every dialog grammar. A screen nothing reads is ADR 0142's unread screen.
2. **Collie sends only keys the screen printed, plus the arrows of a walk, plus the named exceptions.**
   Printed means a footer hint, a key on the dialog's own row (a numbered option, a notice's `1:`), or
   a pointer, which licenses the arrows of its list. A menu card's keys come from a short whitelist
   and are never a digit; the generic menu takes them from the footer plus the arrows the screen
   advertised. A row's digit is sent only by that dialog's own grammar, never by the generic menu.
3. **The named exceptions.** Each is one dialog or one action step:
   a. Claude's `/resume` picker commits with an Enter its footer never prints.
   b. Claude's "Switch model?" confirmation prints no footer; a tap is the walk, then Enter.
   c. Claude's plan feedback row commits the typed text with an Enter the footer does not print.
   d. Antigravity's `/artifact` review sends Enter on a row and `Tab, Enter` for Submit.
   e. On a list the grammar declared `clampedEnds`, an edge row commits with one more arrow (rule 6).
   f. The unread-dialog card offers its adapter's declared cancel key, only on the adapter's own
      modal evidence (omp: its key-hint footer, `omp/modal.ts`; ADR 0053, changed by 0142).
   g. A field Collie types into is cleared with edit keys the screen does not print: AskUserQuestion's
      `ctrl+u ctrl+k` (ADR 0113) and the preview note's `ctrl+k` and Backspace sweep.
4. **A printed scale is chips.** When the screen prints the whole scale an `←/→` row moves along, each
   value is a chip, and a tap sends the footer's arrow, repeated by the distance. The scale is part of
   the menu's identity. Fewer than two values, or a value not among them, keeps the plain arrows.
5. **A pointed list is walked, verified, then confirmed (ADR 0080).** A plan is `pointerWalk`: arrows of
   one direction, then the commit key. The pointed row shows `❯`, because a bare Enter takes it. The
   arrows go bound to the tapped screen; Enter goes only bound to a fresh read with the pointer on the
   tapped row. A grammar never shapes a plan to survive a race.
6. **On omp's tool approval, a race never turns a denial into an approval.** On the clamped list of
   omp 18.1 to 18.6, the first row commits as `Up, Enter` and the last as `Down, Enter`, so a desk arrow
   between the bridge's read and its send cannot move the commit off the tapped edge row. On the
   wrapping list of 18.12, Deny is the footer's own Escape, which denies from any row; a desk arrow can
   only move an approval to its neighbour.
7. **A card shows what it binds, or declines.** The omp approval card carries every row of the command
   or the write; a body the agent cut, a hidden or bidi character or a clipped row declines. The omp
   model picker never offers a row whose Enter compacts the session or re-applies the current model.
   The omp plan review declines while a row may be disabled, because the arrows would skip it.
8. **A card types only into a field it modelled:** AskUserQuestion's answer, Claude's plan feedback
   row and the preview note. Search boxes, note keys and footer actions with no field on the model stay
   on the Keys pad. A multi-select with no measured toggle recipe (omp, pi) stays raw.
9. **Every card tap is bound; a multi-select macro binds its first write.** The phone sends the
   region as `expected_prompt`, and the bridge refuses the keys unless that region ends in the last
   six non-blank rows of a fresh read. A grammar may widen that to twelve when it read every row
   below as its own live chrome (`bindTail`), cut rows to the columns it read (`bindColumns`), or
   bind a pointer drawn as a style (`styledSignature`, ADR 0080). The bridge holds no grammar.
10. **One dock, one card, a way to put it down.** Every card renders in one dock above the belt,
    outside every scroller, capped. A Terminal control shows the rows it replaced, for that dialog
    only. The draft notice and held sends float over the mirror's bottom edge and move nothing.

## Today in the code

- Rule 1: `classifyFooter` needs `namesTrustDialog` (`harness/claude/markers.ts`); `menu` runs after
  the specific grammars in `CLAUDE_DIALOG_DETECTORS` (`harness/claude/index.ts`).
- Rule 2: `menuKeyFor` has no digit branch (`harness/menu-hints.ts`). `describeAdapterConformance`
  (`harness/conformance.ts`) checks over each adapter's own captures: every `menu` key round-trips
  through `menuKeyFor` and none is a digit; a notice card's keys are exactly the digits (letters under
  a `letters` head) its key block printed, in order; a walk is arrows of one direction then Enter, at
  most one row on `["Enter"]`; every key is a valid Herdr key (`isValidHerdrKey`). It does not check
  that any key but a notice's was printed: the whitelist passes d, b gets only the key check, the clears,
  the sticky arrow and the declared key are outside `emittableKeys`. Recipes are reviewed per dialog.
- Rule 3: a. `harness/claude/resume.ts`. b. `harness/claude/switch-model.ts`. c. `submitPromptFeedback`
  (`web/src/lib/prompt-action.ts`, `grammar/PLAN_FEEDBACK_NOTES.md`). d. `harness/agy/artifact.ts`.
  e. `commitKeysFor` (`harness/prompt-model.ts`), declared in `harness/omp/approval.ts` and
  `harness/kiro/workspace-trust.ts`. f. `cancelKey` in each adapter's `index.ts`. g. `clearField`
  (`web/src/lib/answer-field.ts`); the note clear (`web/src/lib/preview-action.ts`).
- Rule 4: `MenuLeftRight.values`, `menusSameIdentity` (`harness/menu-model.ts`); `menu-block.tsx`.
- Rule 5: `pointerWalk`; `splitWalk`, `sameKeysModuloWalk`, `identityDiff` (`harness/prompt-model.ts`);
  `submitPromptOption`, `walkVerifyCommit` (`web/src/lib/prompt-action.ts`); `WALK_PAIRS` and the
  shrinking `WALK_GAPS` (`harness/walk-pairs.ts`).
- Rule 6: `detectBlankRowApproval` sets `clampedEnds`; `detectDividedApproval` makes Deny `["Escape"]`
  (`harness/omp/approval.ts`, header). `commitKeysFor` adds the arrow only on a vertical list.
- Rule 7: `hasHiddenCharacter`, `MAX_REGION_CHARS` = 32000 (`harness/bound-region.ts`); the skipped
  rows of `harness/omp/switch.ts`; `KEEP_CONTEXT_DECLINE_RATIO` = 0.9 (`harness/omp/plan-review.ts`).
- Rule 8: `fillAnswerField` (`answer-field.ts`); `submitPromptFeedback` (`prompt-action.ts`); the note
  flow (`preview-action.ts`); multi-select left raw in `harness/omp/ASK_NOTES.md` and `detectPiQuestion`.
- Rule 9: `DEFAULT_PROMPT_TAIL_LINES` = 6, `verifyPromptBinding` (`bridge/prompt-binding.ts`);
  `checkPromptBinding`, one read, text then style at the same place, `MAX_EXPECTED_PROMPT_CHARS` =
  32768 (`bridge/server.ts`); `tailLinesFor`, `MAX_TAIL_LINES` = 12 (`web/src/lib/tail-lines.ts`).
- Rule 10: `CardDock` (55dvh, 40dvh with the keyboard up); `PromptPanel`, `rawMode`; `HeldCard`.

## Recorded, not found in the code

- ADR 0058 asked a record for each new unprinted key; 3b, 3c and 3d have none, so rule 3 is that list.
- ADR 0053: a ritual re-runs the capture lab per Claude Code version. It is a ritual, not code.

## Consequences

- A walked tap costs one more read and can leave the pointer moved with nothing committed. A gap of
  milliseconds stays between the bridge's read and its send, except on a clamped edge row.
- Uncaptured shapes (new presets, clipped footers) decline to ADR 0142's unread screen.
- Revisit when a multiplexer gains a conditional send, or when a harness offers a structured answer
  path (ADR 0024 decides whether Collie may take it).

## What we tried before

- 0009, 0053: footer keys only and no digit on a generic menu; the unread card (both wait on 0142).
- 0054: chips. 0055: a pointed list in one batch, until 0080. 0058: `/resume`'s unprinted Enter.
- 0056, 0059, 0061: a card can be put down, docks above the belt; notices float. 0072: a box pans.
- 0076 to 0079, 0133: omp's modal gate, `/resume`, Ask, tool approval, model picker, plan review.
- 0098: pi questions by shape and footer. 0108: a dialog over live chrome declares its tail.
