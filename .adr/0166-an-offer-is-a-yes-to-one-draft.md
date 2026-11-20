# 0166: An offer is a yes to one draft

- **Status:** Accepted (2026-11-20)
- **Date:** 2026-11-20
- **Trail:** The 1.30.0 triage of 2026-11-20 (Brief 3 "Open", then Brief 5): a test showed Replace wipe a
  draft the phone never showed. The other road, that Add to it and Replace act on the box as it is at
  the tap, was the design until then, and the operator ruled it out for 1.30.0. PR 831 had asked for the
  opposite direction, a failed probe that lets Add to it go on; it was declined the same day. Files:
  `bridge/surface/protocol.ts` (`offerDraftSeen`, `draftRefusal`, the Replace order), the composer's
  `onProtocolOffer` in `web/src/components/composer.tsx`, `docs/multiplexers.md`

## Context

A send to a box that holds a draft is refused `draft_present`, and the phone offers Add to it, Replace
and Cancel. Commit, Submit and Discard already carried the rows hash of the answer the person read, and
the bridge went ahead only while the screen still hashed the same. Add to it and Replace carried no
hash: they acted on whatever the box held at the tap. A person at the desk who typed another draft in
the seconds between the offer and the tap lost it to Replace, or had the phone's text glued onto it by
Add to it. Neither is what the person said yes to.

Replace also emptied the box before the probe of a send into a running turn. The probe is the check
that a dialog opens in a turn, so a probe that failed left the draft deleted and the text not typed.

## Decision

**Add to it and Replace act on the draft the offer showed, and on no other.**

- **The offer carries its proof.** The `draft_present` refusal carries the rows hash of the read it
  refused on, the same field Commit, Submit and Discard use. The bridge keeps, for each hash it handed
  out, a hash of the box's text in that read, beside the loose form it already kept (M102 spec 12). The
  same refusal carries that read's box text as `draftText` (masked as the mirror is, at most 2000
  characters with `draftCut`, never for a sign-in field or a box shown only in part), so the phone
  can show what Replace would delete.
- **The tap sends it back, and the bridge compares before any key.** At S0, before the draft's probe,
  a box that holds a draft must hold the one the offer showed: the request's hash is S0's own, or a
  hash this bridge handed out for a read whose box held the same text. A turn that streams above the
  box moves the rows, not the draft, so it does not refuse.
- **Another draft is the same refusal again.** `draft_present`, the same sentence and the same three
  offers, over the draft as it is now and with its hash. Nothing is typed, cleared or pressed. No new
  string and no new code: Submit and Discard answer a changed box with "The screen moved since you
  looked", which is about the screen, not the draft, so it is not used here.
- **An empty box is a plain send.** The draft went out or was deleted at the desk, so the text alone
  goes in and out, as the first send wanted, through every rule a send meets (a dialog, a turn, a box
  Collie cannot read). A box that is not free keeps its own refusal, as in every other mode.
- **No hash, no act on a draft.** This is the precedent of Submit and Discard: they need the hash
  wherever the box holds a text the request does not name, and a draft always is one here. A request
  with no hash over a draft gets the offer again with its hash. A phone page from before this change
  therefore cannot Add to it or Replace until it reloads; a new page sends the hash.
- **Replace probes before it clears.** Its probe goes in after the draft, as Add to it's does, and the
  clear follows the probe. A draft the clear would refuse (taller than the box, or past the clear's
  length) is refused before the probe.

## Consequences

- After a bridge restart the bridge remembers no hash, and the exact hash alone decides. In a running
  turn that moves the rows, the first tap after a restart gets the offer again; the next one goes.
- The crew link needs nothing new. A member's reply route takes the same body, and the lead streams
  it on as it is. A member on an older build ignores the hash for these two modes and acts as before.
- A window stays between the clear and the write: a dialog that opens in those milliseconds still
  leaves an empty box. The write and S1 then end the send as today, and the phone keeps the text.
- Revisit if a harness can delete its box in one key that the bridge can undo, or if the bridge learns
  to hand the old draft back into the box after a failed write.
