# 0133: The omp plan review is lifted, and its tier is named, not moved

- **Status:** Accepted
- **Date:** 2026-11-08
- **Shipped in:** (pending)
- **Amends:** [ADR 0076](./0076-the-omp-resume-picker-is-lifted-and-every-omp-modal-has-a-way-out.md),
  in scope. The plan review was one of the omp modals that 0076 left raw with the Escape card. It is a
  card now. The modal gate of 0076 point 1 is unchanged, and so are
  [ADR 0077](./0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md),
  [ADR 0078](./0078-the-omp-tool-approval-is-lifted-and-deny-never-lands-on-approve.md) and
  [ADR 0079](./0079-the-omp-model-picker-is-lifted-as-its-visible-window.md).
- **Related:** [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md) carries the
  guarantee that a tap on this card is walked, verified, then confirmed.
  [ADR 0129](./0129-an-anonymous-install-count-on-by-default.md) is the count whose trouble tally
  found this screen.
- **Trail:** `web/src/lib/harness/omp/plan-review.ts` (`detectPlanReviewRegion`, its header holds the
  corpus and the key choreography) · `web/src/lib/harness/omp/index.ts` · `web/src/lib/harness/omp/modal.ts`
  · `web/src/fixtures/panes/omp--v18-16-0-plan-review*.txt` · pi-tui `overlays/plan-review-overlay.ts`
  and the coding agent's `interactive-mode.ts` `#handlePlanReview` and `#savePlanAndQuit` (omp 18.16.0,
  the same overlay in 18.18.0) · [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md)

## Context

**omp 18.16 ends every plan-mode turn on a full-screen review.** One box fills the pane: the plan
under the title `Plan Review`, a divider, the prompt `Plan mode - next step`, and five options in a
fixed order: `Approve and execute`, `Approve and compact context`, `Approve and keep context
(~N / M)`, `Refine plan`, `Save and quit`. When two role models resolve, a model-tier slider sits
between the prompt and the options (`continue with ◂ smol ◀ default ▶ ▸` and a `↳ <model>` row). The
footer is `↑/↓ select · ⏎ confirm · [←/→ model ·] [c copy ·] ⇥ regions · [<key> editor ·] ⎋ cancel`.
A plan with two or more headings on a wide pane gets a Contents sidebar.

What Enter does on each row: the three approve rows leave plan mode and run the plan with the tier
the slider shows. `Approve and execute` runs it without the planning context, `Approve and compact
context` compacts that context first, and `Approve and keep context` keeps it (`#handlePlanReview`,
`preserveContext` and `compactBeforeExecute`). `Refine plan` sends the plan back
to the model. `Save and quit` saves the plan and leaves plan mode without running it. Escape closes
the review and stays in plan mode. omp disables `Approve and keep context` above 95 percent of the
context window, and Up and Down then skip it.

**The field found it, not a capture run.** The trouble tally of 2026-11-07 counted 27 "Cannot read a
dialog" cards on omp 18.16.0 over Herdr, and 24 on omp of unknown version on crew member panes, both
mostly from one lead install. A lab sweep of every omp 18.16.0 modal (2026-11-07) put this screen
first. The agent opens it, not the person, and it waits until someone answers, so every pane switch
or reload mounted the Escape card again. Before this decision the phone could only close the review.

## Decision

**The plan review is a card: the five options under omp's own labels, walked from the pointer, plus
Cancel. The plan stays in the mirror above it. The slider's tier is named on the card and never moved
from it. Everything else declines and keeps the Escape card.**

1. **Every option is offered, the three approve rows included.** Approving a plan is the reason the
   screen exists, and a phone that can only cancel leaves the agent waiting. The approve rows run
   tools, so a wrong row is costly. The walk below is what makes them safe to offer.
2. **Up or Down from the pointer, then Enter.** The footer names both (`↑/↓ select`, `⏎ confirm`), so
   this is inside ADR 0009's rule. No digit is sent: the review binds none. The action layer walks,
   verifies, then commits (ADR 0080): the arrows go bound to the tapped screen, and Enter goes only
   bound to a fresh read that shows the pointer on the tapped row.
3. **A possibly disabled row declines the whole screen.** A disabled row makes omp's arrows skip it,
   and the walk would count one row too many. omp disables only the keep-context row, above 95
   percent. The grammar declines from 90 percent up, read from the row's own `(~N / M)`, so rounding
   in those two numbers can never hide a disabled row. Without the numbers, omp never disables it.
4. **The tier is named, not moved.** When the slider is up, the card's question says
   `continue with: <tier> · <model>`, because each approve row runs with that tier. The card has no
   control for the slider. A tier button would mean a second walk on a second axis (`←/→`), with its
   own wrap and its own verify step, for a choice the person already made when they set the roles.
   Refused for now. A tier moved at the desk changes the signature, so a stale tap is refused.
5. **The plan stays in the raw mirror.** The card starts at the prompt title. The plan is what the
   person decides on, and the mirror already pans and scrolls it. A copy of the plan inside the card
   would duplicate a long text into a short control.
6. **The copy, regions and editor keys are not offered.** `c copy`, `⇥ regions` and the editor key
   change what the review shows or open an editor in the terminal. None of them answers the review.
7. **The last button is the footer's way out**, `Cancel`, sending Escape. omp stays in plan mode, and
   the composer comes back.
8. **The race guard is the whole box.** The signature is every row from the top border to the bottom
   border, trimmed of trailing space: the plan as shown, the slider, the pointer and the footer. The
   core signature blanks the pointer glyph alone, the one thing a walk changes on this screen
   (captured with the pointer moved, every other row the same byte for byte). A region over 32000
   characters declines.
9. **Fail closed.** The exact options-focused footer of the `unicode` symbol preset, segment for
   segment. A plain divider over exactly the five option rows in omp's order, one pointer. The slider
   rows exactly when the footer says `←/→ model`. The exact prompt title. Box rows up to the
   `╭─ Plan Review ─╮` top border, with a sidebar `┬` exactly when the divider has its `┴`. So focus on
   the plan or the sidebar, the annotation editor, the `submitting…` state, a footer clipped with `…`,
   a hovered row, a rebound key, an unknown label and the `nerd` and `ascii` presets all decline, and
   the Escape card of 0076 stands in.

## Consequences

- **An operator can approve, refine, save or cancel an omp plan from the phone.** The "Cannot read a
  dialog" card no longer appears at the end of every plan-mode turn.
- **The tier can only be changed at the desk**, or through the Keys drawer before a tap.
- **A long session near its window keeps the Escape card.** From 90 percent of the context window the
  review declines (point 3). The person then answers at the desk or cancels.
- **An 80-column pane with the slider gets the Escape card**, because omp clips the footer there.
- **Live verification is partial.** Every capture is real omp 18.16.0 at 80 and 140 columns, and one
  walk was replayed by hand on 18.18.0 (two Downs, a fresh read, then Escape). No tap has gone through
  the paired card yet, and no approve row was confirmed from the phone.
- **What still shows the Escape card on omp:** the Ask multi-select (0077, by design), and the screens
  the person opens at the desk: `/model`, `/settings`, `/session`, `/changelog`, `/hotkeys`, `/tools`,
  `/context`, `/agents` and Ctrl+R history search.
- **Revisit** when omp adds or reorders an option, binds a digit to the rows, disables another row,
  changes the slider into a list, or when a capture shows the `nerd` or `ascii` preset of this screen.
