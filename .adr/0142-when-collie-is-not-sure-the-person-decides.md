# 0142: When Collie is not sure, the person decides

- **Status:** Accepted (2026-11-16). Rules 1, 2 and 6 hold in part today; rules 3, 4, 5 and 7 wait for
  the milestone "No block without an exit" (see "Decided, not built yet").
- **Date:** 2026-11-16
- **Supersedes:** ADR 0117
- **Amends in scope:** ADR 0009, ADR 0053 and ADR 0151 (rule 2, 3f), all by rule 3
- **Trail:** the other road is the old posture: a provable receipt first, a block when Collie is unsure.
  It was argued in #34 (a blind Enter approved a permission dialog), in the `/model` digit probe of
  ADR 0009, in #103 (a password prompt) and in #623 (late keys). Field reports of 2026-11-16 argue
  against it: a first-run theme screen whose card offered only Esc; a sign-in code the agent took but
  the phone showed as "cannot tell"; a "Login successful. Press Enter to continue…" screen with no card;
  three phone sends to a linked background session that stuck. Files: `bridge/surface/`,
  `web/src/lib/surface/send.ts`, `web/src/lib/harness/index.ts`, `web/src/components/composer.tsx`

## Context

The Send Protocol checks the screen before and after it types. The check protects the person from
four things: text in the wrong place (a dialog, a permission prompt), a double send, a lost send that
looks sent, and text mixed into a draft someone typed at the desk. The check reads a copy of the
screen. The person sees the screen itself. When the copy was unclear, Collie refused, and many
refusals had no next step on the card. That put Collie's own ignorance in the person's way. A person
looking at "Press Enter to continue" could not press Enter from the phone. A code that worked read as
a failure. About 30 records shaped this road one case at a time, and none states the rule of today.

## Decision

1. Collie may refuse to act alone. It never refuses the person's informed tap. The person sees the
   screen; Collie only reads a copy.
2. No block without an exit. Every stop card says what Collie sees, and the next step is on the card.
3. A screen Collie cannot read gets one card, and its keys are the person's own Keys pad, not a
   second keyboard. The pad opens once per dialog, and only when no drawer is open; its digits stay
   closed. The card holds a caption, the live screen, the adapter's declared key with its second
   tap, and "Type it anyway". It draws a key only for a core key (Esc, Enter, an arrow) the person's
   board lacks, named as a key, never as an answer. This changes ADR 0009 and ADR 0151 (rule 2, 3f)
   in one point: the person may press plain keys the screen did not print. Collie never presses one.
4. "Cannot tell if this was sent" shows the screen as it is now and two actions. "It arrived" clears
   the card. "Send again" is a new request, made by the person's tap.
5. The receipt stays honest, but it is no gate. A send by the person's override is recorded as sent
   on the person's word, not as verified. Collie never holds an override: it types now on the rows
   the person saw or is refused. A message the agent queues in a running turn goes in as any send.
6. Four hard stops stay, because the risk is real. Each card names the reason and the next step.
   a. No message into an open permission prompt or question: text can approve a command.
   b. No secret into a normal field, the hold queue or any store. Where Collie knows the screen asks
      for a secret, the composer is the secret field, and "Send again" reads "Enter it again".
   c. Collie never sends again by itself: one request id, one road, never twice automatically.
   d. No WalkyTalky message from another agent over the person's draft.
7. A stop card without an exit is a bug. The trouble tally counts such cards.

## Today in the code

- One request id, one receipt, a closed list of outcomes and reasons: `web/src/lib/surface/send.ts`
  (`SEND_OUTCOMES`, `SEND_REASONS`). The steps and their bounds: `bridge/surface/protocol.ts`, header.
- Rule 1: the two-tap Send on an unread screen (`gateManual`), and the override on every other one
  (addendum below). A moved screen is refused `stale_surface`: the tap was informed by an older one.
- Rule 2, in part. `offersFor` in `web/src/lib/surface/send.ts` gives each refusal its offers: Add,
  Replace or Cancel on a draft, Submit or Discard on typed text, the Keys pad on the rest. A queued card
  never vanishes without an exit (`bridge/surface/queued.ts`, ADR 0122). A Stop is refused before any
  key with a named reason (`bridge/surface/stop.ts`, ADR 0116).
- An unread dialog gets one card: the whole screen and the one cancel key its adapter declared
  (`withUnreadDialog` in `web/src/lib/harness/index.ts`, `web/src/components/unread-dialog-block.tsx`,
  ADR 0053). The composer keeps its second-tap override (`web/src/components/composer.tsx`).
- Rule 4, in part. After `unknown` the draft stays, and a second tap on the same text asks "Send it
  again?" first (`web/src/lib/send-again.ts`). An expired hold keeps its text for a Resend
  (`bridge/surface/holds.ts`).
- Rule 6a. A known dialog or question over the box ends `not_free` before any key, and a box that
  answers the agent's question takes only the person's own send (`bridge/surface/protocol.ts`,
  `answersQuestion`).
- Rule 6b. A sign-in field's text is never held, kept or recorded (`isSecretSend`), and the phone keeps
  no draft of it (`secretField`). A password prompt changes only words (`no-echo.ts`, ADR 0017).
- Rule 6c. The data road hands a command to a part once (`data-send.ts`); a held send goes again only
  under its own id (`holds.ts`); one override id types at most once.
- Rule 6d. A WalkyTalky message waits over a draft and types nothing there (`draftHolds`, `DRAFT_REFUSAL`).
- A steer is the person's choice, never the default (`bridge/surface/protocol.ts`, header).

## Decided, not built yet

These wait for the milestone "No block without an exit"; until then the old rule holds.

- Rule 2 in full: `not_free`, `probe_failed` and `unknown` offer only the Keys pad today, and the
  sentence does not name a next step (`offersFor`, `web/src/lib/i18n/messages/en.ts`).
- Rule 3 (M102 spec 03): the unread card offers one declared key, and a screen without one or without
  modal evidence gets none. It gains the Keys pad, a missing core key and "Type it anyway".
- Rule 4: `unknown` gains "It arrived" and "Send again" on its card. The queued card's `unconfirmed`
  state gains "Send again" beside Discard.
- Rule 6b for a normal field: Collie cannot tell a secret typed into a normal box today; only a
  secret shape leaves no trace in the shell-line record (`bridge/sent.ts`, ADR 0107).
- Rule 7: the trouble tally counts `dialog` and `send` only (`TROUBLE_KINDS` in `bridge/telemetry.ts`).

## Consequences

- A person can now send into a screen Collie did not verify. The receipt says so, in its own word, so
  a report and the tally never mistake an override for proof.
- A person can press Enter on a screen Collie did not read, on a key labelled as a key. A wrong Enter
  on an unread permission prompt is possible; the live screen above the keys is the guard. This is
  no new power: the Keys pad already sends any key to any screen. The four hard stops cost a tap and
  a sentence, never a dead end.
- Revisit if an override send causes harm a refusal would have stopped, or if the tally shows the
  plain keys are pressed where a lifted card should exist (then lift that dialog).

## What we tried before

- 0004, 0048, 0005: the box is found by its own frame; a composed key queue never outlives its dock.
- 0009, 0053: a menu sends only keys it names, never digits; the unread card (both changed by rule 3).
- 0010, 0017: a long send is proven by its paste placeholder; a password prompt changes only words.
- 0054 to 0061, 0076 to 0079, 0098, 0108, 0133: the dialog rules, now ADR 0151.
- 0080, 0109, 0113: a pointed list is walked, verified, confirmed; a notice above the box is not a
  modal; an AskUserQuestion answer is typed into its field, cleared only when it holds what was seen.
- 0116, 0117, 0140: a Stop and a steer are a person's tap with a receipt; a send by data, never twice.
- 0122 to 0124: a queued send is a card with an exit in each state; three failed sends offer an issue.

## Addendum (2026-11-17): the override reaches every screen, never a menu (M102 spec 12)

An override (`override` plus the rows hash seen) is typed on any reading but five: no pane or grant, a
sign-in field (6b), a question the reader read (6a), a moved screen (`stale_surface`) and the generic
menu sign (`menu_open`, `menu-sign.ts`; on the blind road none for a shell foreground, else live at the
bottom). On a manual Send it is the commit, submit key on the exact hash only (loose match: no key); else
one piece, no probe, no key: `typed_not_submitted(override)`. Spec 13: an `unknown` whose submit went out
waits `awaitingEventUntil` for the agent's prompt event (data road too); a match settles it `effective`.
Amended 2026-11-25 (#863): a guess is no wall: no profile, an agent's box or footer, no one-key row: typed, no key.
