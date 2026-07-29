# 0003 — "Seen" is one shared fact, and Collie only trusts what happened in Collie

Status: **Accepted** (2026-07-28)

## Context

The dashboard sorts the herd by attention and then by recency, and it surfaces a **Ready · unseen**
section: agents that finished while you weren't looking. Both need to know two things per pane —
when the agent last moved, and when *you* last looked at it.

Herdr supplies neither. Its pane, tab, and workspace records carry **no timestamps of any kind**
(see [`HERDR_API.md`](../HERDR_API.md)), so every notion of "when" in this feature is one Collie
derives and owns. That forced two questions that would otherwise never have been asked out loud.

**Where does "seen" live?** Collie is a phone UI for a herd you also drive from a desk, and the same
person uses both. The bridge already persists exactly this kind of state — `snooze.json`,
`notify-prefs.json` — bridge-wide rather than per-device, on the same reasoning: a notification
fans out to every device, so muting it on one must mute it on all.

**What counts as looking?** Herdr reports a `focused` flag per pane, so the bridge *could* see you
working in a pane at the desk and count that as having seen it. That was considered and rejected
during design.

## Decision

**One shared "seen", recorded bridge-side and persisted to the state dir.** `activity.json` holds
`{activeAt, seenAt}` per pane, keyed by session name (pane ids are session-scoped and collide across
sessions). Not per-device, not in `localStorage`.

**Only what happens in Collie counts as seeing.** `seenAt` is stamped when a request reaches
`/api/pane/:id` — opening the pane, replying, sending keys, reading its history. A Herdr focus at
the desk does not stamp it, and neither does anything else the bridge merely observes.

**"Seen" is a comparison, not a stored flag.** An agent is unread exactly when
`status === "done" && activeAt > seenAt`. There is no read-receipt table and nothing to keep in
sync: opening the pane bumps `seenAt` past `activeAt`, and the row leaves the section by itself.

**A first sighting is seeded as already-seen** (`activeAt = seenAt = now`), so only transitions
observed *after* Collie first saw a pane can mark it unread. This is the same rule the state engine
already applies to notifications — a first sighting never fires a transition, so a fresh start
doesn't notify for agents that were already blocked.

## Consequences

- **A second device agrees with the first.** An alert cleared on the phone is cleared on the laptop.
  This is the whole point, and it's why per-device storage was rejected: the failure mode there is
  an alert you already dealt with still shouting at you somewhere else.
- **Two people sharing one bridge share one "seen".** Accepted. Collie's threat model is a personal
  tailnet with one operator; a bridge is remote shell access, not a multi-tenant service.
- **Working in a pane at the desk does not clear its Collie alert.** This is the deliberate cost.
  Counting a Herdr focus would let a pane you merely clicked past silently clear an alert you never
  read — a false negative on the one thing the dashboard exists to surface. A false *positive* (an
  item still listed as unseen after you dealt with it at the desk) costs one tap; a false negative
  costs a missed agent.
- **The ledger writes on a debounce.** An open pane polls about once a second and each poll stamps
  `seenAt`; in memory that's free, on disk it would be a write per second forever. Flushes are
  capped at one per 10s plus one on shutdown, so an unclean kill can lose up to ten seconds of
  precision — imperceptible in a feature whose finest unit is "just now".
- **The state can be thrown away.** Delete `activity.json` and the next poll re-seeds every pane as
  seen. Nothing else depends on it.

### What would justify revisiting

- Herdr starts reporting real per-pane activity timestamps — then `activeAt` should come from the
  source rather than from Collie's own observation, and a bridge restart would stop being a
  re-seed.
- Collie grows genuine multi-user support (distinct identities, not just distinct devices). Then
  "seen" becomes per-identity, and this ADR is superseded rather than amended.
- Evidence that clearing-at-the-desk actually matters in practice — i.e. the false positives are
  frequent and annoying enough to outweigh the missed-agent risk. That's a usage question, not a
  design one, and it should be answered with usage.
