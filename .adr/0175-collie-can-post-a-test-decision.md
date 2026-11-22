# 0175: Collie can post a test Decision

- **Status:** Accepted (2026-11-22), the owner said yes to the button
- **Date:** 2026-11-22
- **Trail:** A person who switched the Hill on had no way to see the whole loop once: a card arrives and the phone
  gets a notification. When no notification came, nothing said why, because the reasons were folded into one
  boolean. Files: `bridge/hill/test-card.ts`, `bridge/hill/push.ts` (`hillRingBlock`), `bridge/hill/service.ts`
  (`requestTest`), `bridge/server.ts` (`hillTestRoute`), `bridge/index.ts`, `web/src/lib/hill/wire.ts`,
  `web/src/components/hill-test-group.tsx`, `web/src/hooks/use-hill-test.ts`.

## Context

A Decision marked Now sends one notification, through the push rules of `bridge/push.ts`. Five facts can stop it:
push is not set up, the "Decisions that need you now" switch is off, notifications are snoozed, this machine is a
crew member, and the crew state is Quiet or Away. A sixth, the rate, stops a sender that sent too many in an hour.
`ready()` in `bridge/index.ts` folded four of them into one boolean, `HillPush.check` answered "off" for all four,
and the crew state gate sat in the hill service. A device that polled in the last `LOOKING_MS` (11 seconds) does not
get the push while the person looks at the app, so a test pressed on the phone would never notify that phone.

## Decision

**Collie posts one Decision of its own, marked Now, when the person presses "Send a test Decision" on the Hill's page.
It posts 20 seconds after the press, and the answer to the press names the first reason no notification would be sent.**

1. **A card of Collie's own, of the ref type `test`.** Its value in `HILL_OFF_TRICK_CARDS` is `false`: it is about no
   trick, so with the Hill off nothing posts it, serves it or answers it, and the button is disabled then. The sender is
   Collie, with the ref id `test` and the hash of the fixed string "collie hill test".
2. **Fixed words, and an empty request.** The title, the summary and the one option ("It works") are constants in
   `test-card.ts`. The route takes an empty body, so nothing from the request enters the card. The card expires after
   ten minutes. A new test card supersedes the open one, so at most one is open, and it keeps the notification slot.
   Its answer closes it as answered with nothing typed anywhere.
3. **The delay is `LOOKING_MS` plus nine seconds, 20 seconds.** A phone that left the app within nine seconds of the
   press is no longer looking at the post, so the push goes at once. A phone that left later has the push held and sent
   late (`push.ts`, `lookAgain`), never dropped. The timer is in memory; a restart drops it. One test waits at a time: a
   second press schedules nothing and answers with the seconds that remain.
4. **One pure function names the reason.** `hillRingBlock` returns the first of `push_off`, `no_devices`, `pref_off`,
   `snoozed`, `crew_member`, `quiet`, `away`, `rate`, or null. `ready()` asks it for its four facts, so the verdict and a
   real send cannot drift. `no_devices` and the crew state and rate facts are for the verdict only: a real send gets no
   new gate.
5. **The route is `POST /api/hill/test`, behind the write right.** It sits behind `browserGate("write")`, as the Hill's
   switch does, and a crew member host is a 400. No agent or trick holds a paired device's token, and no door of theirs
   makes a card of Collie's own, so none can reach it. The Hill off is a 409 `hill_off`, a machine that is not the lead
   a 409 `not_on_lead`. The audit line `hill.test` names the device and whether a notification would be sent.

## Consequences

- A person sees a card arrive and gets a notification, or reads why not in one sentence, before a real agent posts.
- The test sender counts toward the push rate (three an hour from one sender), so the fourth press in an hour is told
  `rate`.
- A bridge restart inside the 20 seconds drops the test; the person presses again.
- The meaning of the priorities and the time a real Decision sends a notification do not change.
