# 0156: Approving a trick's code is a hold, and reading is offered

- **Status:** Accepted (2026-11-17)
- **Date:** 2026-11-17
- **Trail:** The read gate came from the security reads of package I (review 7 R1, the single card, C-A2 of
  review 8, and the read of f1d386c21, points 1 to 4): they argued that the yes must wait until the end of
  every card's code was on screen, and that the card stand still for a second. The operator turned that road
  down on 2026-11-17, on his phone: "i think having to read the code is kinda stupid, the operator knows the
  risk, we should have it hold to release or sth, so i have to hold switch it on for 3 secs or so."
  Files: `web/src/components/hold-to-approve.tsx`, `web/src/hooks/use-approve-hold.ts`, `web/src/lib/arm.ts`
  (`APPROVE_HOLD_MS`), `web/src/components/session-trick-card.tsx`, `web/src/components/decision-card.tsx`,
  `web/src/lib/hill/code-card.ts`, `bridge/hill/service.ts` (`groupRule`, `singleCodeRule`),
  `bridge/hill/parse.ts` (`readGroupAnswer`), `docs/tricks.md`, `docs/tricks-reference.md`

## Context

A trick runs as the person, so its yes is the one moment its code is approved. Until this record the
phone guarded that yes three ways: the "Read the code" fold had to be open and the mark after the last
line of every card had to have been on screen (an IntersectionObserver per card, kept per tab in
sessionStorage); the card had to stand still for a second; and a press begun before all of that was
ignored. The phone sent the cards it had seen (`opened`), and the bridge refused a yes without every card.

The check never proved that a person read anything, and the code said so. In use it was friction: a long
trick meant a forced scroll through code the person had already decided about, or had asked a session to
read, before the yes would wake up. The person who approves knows the risk; what the phone must make sure
of is that the yes is meant and that it approves the code the card showed.

## Decision

1. **The yes to a trick's code is a hold of 1.5 seconds, everywhere.** Switching on a proposed trick and
   taking a proposed or changed version, on the chat's card, the agent view's card, the Hill and Settings,
   Tricks, through one control (`HoldToApprove`). A fill grows across the button; at `APPROVE_HOLD_MS`
   (1500 since the operator's word of 2026-11-17, first 3000; the fill starts at the press) the yes goes out once,
   with the finger still down.
2. **A hold ends with no yes** when the finger lifts early, leaves the button or moves past a thumb's
   jitter, on `pointercancel`, when the page is hidden, when the card's digest changes, when an answer goes
   in flight, and when the card leaves. A scroll, a layout shift and the window's focus do not end it: in a
   live chat they came from the chat following its tail, and the first build, which ended a hold on them,
   could not be approved on an Android phone (2026-11-17). While a finger holds, the chat does not follow its
   tail, and the button takes no pan (`touch-action: none`). A second finger, and any press while an answer
   is in flight, does nothing. A hold starts only with a press on the rendered, enabled button.
3. **A key or a switch device presses twice**, as the belt's Stop does: the first press arms for `ARM_MS`,
   a second one at least `ARM_DWELL_MS` later approves.
4. **Reading is offered, not required.** "Read the code" stays on every card and opens as before. No card
   has to be opened, scrolled to its end, or held still before the yes.
5. **The bridge asks for the digest, not for what was seen.** A yes to a group or a single card of code
   needs the digest the phone was given, a request id and a paired phone with the write level; it no
   longer needs `opened`, and reads and ignores it. The phone still sends `opened` with every card number, a
   legacy field for a bridge of 1.29.0-edge.1 to edge.4 in a crew, which refuses a yes without it.

## What stays

- A card that cannot show every byte of the code as it is (a masked line, a hidden character, a file that
  is not text or is too large, a node the phone cannot draw) offers no yes on the phone. A card with no code
  offers no yes, and the bridge refuses one that comes anyway.
- The answer carries the digest and a request id and gets a receipt; the bridge hashes the stored bytes
  again before it installs, and a changed card is refused. The agent can never approve.
- The decline (Not now, Keep), and Dismiss on the Hill, stay as they were.

## Consequences

- The yes is slower than a tap by 1.5 seconds and faster than a forced read of a long trick.
- A yes that got no answer offers no Try again: the hold is the way to send it again.
- What the phone records about reading is gone: the per-tab opened marks (`collie:hill-group-opened:v1:`)
  and the still wait. A question of whether a person read the code is not answered by the phone, and no
  text claims it is.
- Revisit if a yes ever goes out that the person did not mean: the remedy is a stronger hold, not a
  return of the forced read.
