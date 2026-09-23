# 0062 — A crew run levels to its target, and its second step is not a new attempt

- **Status:** Accepted
- **Date:** 2026-09-23
- **Amends:** [ADR 0016](./0016-updates-ride-the-operators-ssh.md), the 2026-09-04 addendum, fact
  "One attempt per hour, on the peer"
- **Shipped in:** pending
- **Trail:** `bridge/crew/follow.ts` (`followGuards`, `followLimit`, `UpdateTurns.observe`) ·
  `bridge/crew/lead.ts` (`foldTurns`) · `web/src/lib/update-screen.ts` (`legDetail`) ·
  [`CREW_PROTOCOL.md`](../CREW_PROTOCOL.md) §20

## Context

The 1.12.0 run on the release lane, 2026-09-23. The lead ran 1.11.1, the member minibuch ran 1.11.0.
The phone confirmed 1.11.1 to 1.12.0 on the lead.

- 07:54:22, the lead opened its turn queue on the confirm and granted minibuch the turn at once. Its
  own detached updater had not written a record yet, so the release header still stated 1.11.1.
- 07:54:23, minibuch levelled itself to 1.11.1, under the run's id. The turn carries no version, so
  the header was the only target it could read.
- 07:54:40, the lead came back on 1.12.0 and granted the turn again. minibuch refused: its
  once-an-hour limit counted the step it had just taken.
- 08:14:40, the lead's 20-minute wall clock failed the leg as `unreachable (no change for 20
  minutes)`. The phone said "Could not update minibuch". minibuch had answered every sweep.

Three faults, one on each side and one between them. The lead granted a turn before it stated the
run's target. The member treated the run's second step as a new attempt. And the lead held the
reason in its hand, the member's own run report, and still wrote a stall.

## Decision

**A turn goes out only while the lead states the run's target. A member's step inside the run it
already joined is not a new attempt. And the lead names a member's hourly limit instead of failing
it.**

1. **The lead grants no turn below the target.** `UpdateTurns.observe` takes what the lead states
   about itself on the same sweep, and hands out a turn only when that is the run's target. The run's
   target is then the only version a member can be sent to. No header changes.
2. **The member exempts one case from the hourly limit.** Its last run finished `done`, in the run
   the turn names, at a version below the one the lead now states. That member is finishing an
   attempt the limit already counted.
3. **The lead reads the limit off the member's report.** A waiting member whose report shows an
   attempt inside the hour is skipped for the turn, its leg reads `rate-limited, retries in about
   N min`, and the wall clock starts when the limit lifts. The member's report carries `updatedAt`,
   not `startedAt`, so the time is an upper bound: the member retries by then, never later.
4. **Every crew run ends, and says why** (amended after counsel, same day). The stamp is the
   member's clock, so the lead caps the limit's end at an hour and two minutes after it first read
   it, on its own clock. The leg states a span, not a clock time, because the lead's time zone is
   not the phone's. If the lead's own update ends rolled back, stuck or interrupted, the run closes
   on that sweep. If the lead is done but does not state the target, it closes after the 20-minute
   wall clock. While the lead is still updating, queued legs do not expire. Every run closes after
   2 hours at most. A closed leg reads `unreachable` with its reason, for example `not started: the
   lead's update rolled back`, so no older phone meets a new state. A second confirm while a run is
   open is refused as `update.in_progress` (`levelling the crew`).

## Why the exemption keeps the protection

The limit exists so that a buggy or hostile lead cannot cycle a member through restarts. The
exemption does not reopen that:

- Each exempt step needs a version strictly above the last one that succeeded, and there is no
  downgrade path. A lead can walk a member up the published tags, each tag at most once, and can
  never go round.
- A step that rolled back never qualifies. Guard 5 still refuses the same tag in the same run.
- Every other recent attempt, another run, a run from a terminal, still waits the full hour.

## Consequences

- **A fixed lead with any member** never sends a member to an intermediate release.
- **A fixed member with an older lead** (1.12.0 and earlier) still takes the intermediate step,
  because the older lead still grants early. It then takes the target within the same run instead
  of refusing it.
- **An older member with a fixed lead**, left one step short by an older lead, is granted the turn
  and refuses in silence. The lead cannot tell the two builds apart without reading a version
  number, so it names the limit after the member has held the turn a minute without moving, and it
  keeps the leg open until the limit lifts. The member then finishes inside the run.
- **Both sides older** behave as on 2026-09-23. The remedy is **Retry crew update** on the phone
  once the member's hour is up.
- **A run can now stay open up to about 80 minutes**, the hour plus the wall clock, when a member is
  rate-limited. It is not stalled: the lead can say when it moves. No run stays open past 2 hours,
  and none outlives a lead update that did not arrive.
- **One crew run at a time.** A new confirm, full or peers-only, waits until the open run settles.
