# 0108: a dialog over live chrome declares its tail

- **Status:** Proposed (2026-10-16), for the maintainer to accept with the Hermes adapter
- **Date:** 2026-10-16
- **Shipped in:** pending
- **Trail:** [issue #354](https://github.com/AltanS/collie/issues/354), whose local Hermes adapter
  bound the ticking rows under the panel and answered every tap with "Menu changed: reloading" ·
  [ADR 0098](./0098-pi-questions-are-read-by-shape-and-footer.md), amendment 2026-10-12 (the
  precedent: `bindColumns`, a binding refinement the phone names and the bridge only counts to) ·
  `bridge/prompt-binding.ts` (`DEFAULT_PROMPT_TAIL_LINES`) · `bridge/server.ts`
  (`expected_tail_lines`) · `web/src/lib/tail-lines.ts` · `web/src/lib/harness/prompt-model.ts`
  (`bindTail`) · `web/src/lib/harness/hermes/` · `web/src/lib/harness/conformance.ts`

## Context

Every dialog tap is bound: the phone sends the dialog's region as `expected_prompt`, and the bridge
re-reads the pane and refuses the keys unless that region is on screen and **ends inside the last six
non-blank rows**. The six-row tail is what keeps a stale copy of a dialog higher up the screen from
taking a tap meant for the live one; a replacement dialog pushes the old match out of the window.

Hermes Agent's classic CLI draws its modal panels above its input and keeps live chrome under every
one of them: a spinner with elapsed time, the panel's key hint with a countdown, a status bar with
two clocks, the top rule, the input row and the rule under it. Six or seven non-blank rows, most of
which repaint about once a second. The panel's own bottom border is therefore the seventh or eighth
row from the end, and a tap bound to the panel alone is refused `not_in_tail` on a screen that never
moved. Measured on the captures in `web/src/fixtures/panes/hermes--*` (Hermes v0.22.2, 120 columns).

Three roads were open:

1. **Bind the rows down to the tail**, clocks and all. That is what #354's local adapter did. The
   region then changes every second, the guard's fresh read never matches the one the operator
   tapped, and no tap ever lands.
2. **Raise the bridge's default window** for everyone. Every other harness's dialogs sit at the
   tail, so the change would buy them nothing and would widen, for all of them, how far up a stale
   match may sit and still be accepted.
3. **Teach the bridge to blank the clocks.** The bridge holds no pane grammar (HARNESS_CONTRIBUTING.md,
   "Which side parses a pane"), and a Hermes rule in it would be the first.

## Decision

**A grammar that has recognised every row under its region as its harness's own chrome declares how
many rows the region may end above the tail, and the bridge widens its window to that, within a cap.**

1. The model carries it: `PromptModel.bindTail`, built with `tailLinesFor(rowsBelow)`
   (`web/src/lib/tail-lines.ts`): undefined when the default already covers the region, otherwise
   one row of headroom past the rows the grammar saw, null (do not lift) past the cap.
2. The phone sends it as the optional body field `expected_tail_lines` beside `expected_prompt`, on
   `/keys` and `/reply`. Like `expected_columns` it refines the binding and never replaces it: alone
   it is a 400, and so is anything but a whole number from the default (6) to `MAX_TAIL_LINES` (12).
   It can widen the window and never narrow it.
3. The bridge counts rows to that number and does nothing else. It reads the rows below as text it
   does not interpret; the grammar on the phone is what vouched for them.
4. It is not part of a dialog's identity: it counts chrome outside the dialog.
5. The conformance suite checks the declaration: the declared window binds the model's region in
   its own raw capture through the bridge's verifier, and the default window refuses it, so a tail
   is never declared where it is not needed.

## Consequences

- Hermes's clarify and approval taps bind to the panel alone, and the clocks under it cannot refuse
  them. A change inside the panel still refuses the tap, and a panel that scrolled up still does.
- An older bridge ignores the field, keeps six rows and refuses the tap: a Hermes button against a
  peer one release behind fails closed, with the raw mirror and the Ctrl+C card still there.
- A grammar that declares a tail takes on the duty the six rows used to discharge for it: it must
  account for every row below its region and decline a screen with anything it does not know there
  (`panelAboveInput` in `hermes/clarify.ts`).
- Revisit if a second harness needs a window past 12 rows, or if Herdr grows a conditional write
  (a `send_keys` with a precondition checked server-side), which would make the tail bound moot.
