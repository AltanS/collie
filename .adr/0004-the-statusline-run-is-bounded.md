# 4. The statusline run is bounded, but the bound guards less than it looks

Status: Accepted · 2026-07-30

## Context

`locateInputBox` (`web/src/lib/harness/claude/chrome.ts`) walks up from the buffer tail and accepts at
most `MAX_STATUS_LINES` non-blank, non-border rows before it requires the input box's bottom border.
That run is the statusline plus its hint rows.

**A statusline's height is not ours to assume.** It is whatever `statusLine.command` prints, and Claude
renders that verbatim below the box. Nothing in the contract caps it: a multi-line statusline is an
ordinary configuration, generators in common use expose several line slots, a hand-rolled script can
print as many rows as it likes, and any single row can soft-wrap into two on a narrow pane — which is
the usual case on a phone. At 3, the bound was smaller than configurations that are entirely normal.

**Statusline height also varies at runtime, which is why the failure reads as intermittent rather than
reproducible.** Common widgets are conditional — git state, PR or review state, a context-usage meter, a
session timer — so a statusline can gain or lose a row while nobody touches a setting, carrying a pane
over the threshold and back. Observed exactly that way in the field: panes that failed to send one day
were fine the next, and vice versa, with no config change in between.

When the border is never reached, `extractInputDraft` returns `null`, so `draftCarriesSend` is false
and `sendGuardedReply` withholds Enter with *"Message didn't reach the input box"* — while the text is
already sitting in the box.

This is the second time this walk has been broken the same way. `web/src/fixtures/panes/README.md`
records that the background-agents footer "broke `locateInputBox` (**it tolerated only the statusline
window**), so the whole box stayed visible on the mirror **and** no draft chip surfaced", fixed in
`d9521e3` by admitting more rows below the border under `MAX_FOOTER_LINES`.

### Four justifications for keeping the bound low, all falsified

The old comment credited the bound with protection it does not provide, which is why raising it felt
unsafe and why "just delete it" was proposed twice. Each claim was tested against the real modules:

| Claimed role | Verdict |
| --- | --- |
| Stops the walk stripping unboundedly | **False.** Step (c) requires a border, so an over-long run degrades to *no match*. 200 000 borderless rows with the bound removed strip 0 lines. |
| Distinguishes the live box from one that scrolled into scrollback | **False for this harness.** A Claude pane runs on the terminal's alternate screen and keeps no scrollback ring, so the buffer only ever holds the visible viewport — stated in seven places in this repo (`bridge/types.ts`, `web/src/lib/types.ts`, `loaders.ts`, `nav.ts`, `api.ts`, …) and confirmed against running panes, none of which reported a non-zero `max_offset_from_bottom`. |
| Keeps a dialog below the box from being swallowed as chrome | **False.** All 20 dialog fixtures are refused by step (c), (d) or (e) — never by the row count. Step (c) fires because Claude paints a blank line above a dialog's footer hint, ending the tail run within 2 rows in **20 of 20**. The blank is the guard. |
| At least hedges against a blank-free run below the box | **Backwards.** Dialogs are 2-11 rows, so a taller ceiling admits *more* of them: a blank-free dialog is refused for 8/20 fixtures at 3, but only 2/20 at 8. |

So on the real corpus the bound has no measurable protective effect at 3 or at 8, and at 3 it has one
measurable cost: blocked sends.

### The two bounds compose

Step (a) peels up to `MAX_FOOTER_LINES` rows plus their blank separator and hands its position to step
(b), which then takes up to `MAX_STATUS_LINES` more. The deepest strippable run below the box is
therefore `MAX_STATUS_LINES + 1 + MAX_FOOTER_LINES` — **12 rows at 3, 17 at 8**. Measured:

```
complete box + K rows + blank + 8 footer rows
  K   MAX_STATUS_LINES=3   MAX_STATUS_LINES=8
  3   MATCH strips=15      MATCH strips=15
  4   no match             MATCH strips=16
  8   no match             MATCH strips=20
  9   no match             no match
```

## Decision

**Keep a row bound, size it to `MAX_FOOTER_LINES` (8), and stop crediting it with protection it does
not provide.**

- Keep it, rather than delete it, for one narrow reason: an unbounded walk has no failsafe of its own.
  A 60-row blank-free run below a complete box is matched, and `stripChrome` then deletes all 63 lines.
  Nothing like that shape appears in 47 real captures, but this repo has already been surprised once by
  Claude adding rows below the box.
- 8 rather than some other number because `MAX_FOOTER_LINES` already bounds a run in the same region of
  the same buffer. Nothing on today's corpus depends on the exact value, so "the same as its neighbour"
  is the only justification available that is not a guess — and two different numbers would invite a
  reader to look for a distinction that does not exist.
- The comment on the constant says what the bound is *not*, and points here. `chrome.test.ts` pins both
  halves: the heights that must work, and the dialogs that must stay untouched.

## Consequences

- **Nothing on the current corpus depends on this number.** That is unusual for a constant and has to be
  said out loud, or the next reader re-derives one of the four false justifications above — which is
  exactly what happened four times while this was being written.
- **The scrollback-echo false-ENTER window widens from `r<=3` to `r<=8`.** An echo of our own sent text,
  bracketed by rules with the lower rule flush beneath it, is structurally identical to the live box.
  `draftCarriesSend` cannot discriminate, because the echo *is* the sent text. Zero instances in 47 real
  captures, and the precondition (a `❯` line with a border flush below and only blanks up to a border
  above) appears in no real render — the two real echoes in the corpus have transcript text above them
  and so fail step (e). Pinned as a known limitation in `chrome.test.ts` rather than left implicit.
- **The composed ceiling rises from 12 rows to 17.** Unobserved: the deepest real run below a border in
  the whole corpus is 11 rows (`claude--wizard-submit.txt`), and that is a dialog which fails
  (c)/(d)/(e) anyway.
- **A statusline taller than 8 rows falls back to the raw mirror.** Safe direction — the box stays
  visible instead of being stripped — but sending stalls again, and the fix is to raise the number, not
  to remove it.
- **A dialog block cannot serve as an interlock in the send path.** Tried and measured: appending a box
  shape below a real dialog fixture flips `buildBlocks` from `[raw, prompt-select]` to `[raw]`, and
  `extractInputDraft` then returns the appended text. The grammars need the dialog at the buffer tail,
  so the interlock goes silent in exactly the screen it was meant to protect.

**What would justify revisiting this:** `web/` gaining Herdr's `agent_status` or `scroll` geometry.
Neither is plumbed into the client today. With either, box liveness could be *established* instead of
inferred from shape — and then the bound can go, along with the echo limitation it cannot fix.
