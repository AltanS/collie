# 0037 — A staged update confirms its runner before it exits

Status: **Accepted** (2026-09-08)

Contract: [`docs/upgrading.md`](../docs/upgrading.md) ·
Related: [ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md) (which made `update`
advance the checkout Herdr installed) ·
[ADR 0021](./0021-the-path-name-is-a-pointer-never-a-copy.md) (which made `current` a pointer, and
so made the swap a thing a separate runner performs)

## Context

An update stages a new version and then hands the swap to a detached runner, because the swap
restarts the very service that asked for the update. The staging process therefore has one job left
after the payload is on disk: start something that will outlive it.

On a linked-clone and on a binary install, that handoff was fired and forgotten. It was measured on
the VM lab lead on 2026-09-08, levelling v1.8.2 to v1.8.3, with nothing restarted to get it. The
staging ran inside the bridge's own transient unit, printed its handoff line, and the outer unit was
gone 4.8 ms later. The transient unit the handoff named was never created:

```
12:41:43.797053 collie[52529]: ✓ v1.8.3 is staged — handed off to systemd-run --user --collect (transient unit collie-update-mtsnsbxp).
12:41:43.801831 systemd[761]: collie-api-update-1788871300641.service: Consumed 3.641s CPU time.
```

The cause is one property of the launch, and it is not a property of `systemd-run`. `spawn(...,
{ detached: true })` gives the child a new session. It does not give it a new cgroup. The
`systemd-run` client stays a member of the caller's cgroup until it exits, and under the default
`KillMode=control-group` a unit whose main process exits takes the rest of that cgroup with it. The
same shape was reproduced with the user manager at debug level: the outer unit entered
`stop-sigterm` 112 microseconds after its main process exited, and the cgroup was empty 9 ms later.

The same command typed at a shell always worked, which is why the defect survived. An ssh shell
lives in a `session-<n>.scope`, and a scope has no main process, so nothing in it exiting triggers a
teardown.

What the operator was left with was worse than a failure. The run record sat at `staging`, the lock
was held, no `abort` was ever written, the runner log was 0 bytes, and the record cleared itself only
after the ten minute staleness window, during which a retry was refused. The phone showed a live run
the whole time.

Two narrower fixes were tried and declined. `KillMode=process` on the launching unit works on the
guest, and it fixes only the launch path that sets the property, leaves the fragile shape in place,
and orphans any stray build child into a cgroup systemd can no longer clean. A poll loop on the
runner unit buys the same guarantee for more code and needs a timeout policy of its own, when the
client's exit code is the manager's own answer.

## Decision

**A staging process confirms that its runner has escaped the staging process's cgroup before it
exits, and a tier that cannot confirm does not launch from inside a service.**

- **The guarantee lives with the launch, not with the host.** A staging started by the bridge, by
  cron or by an operator's own wrapper unit is protected the same way, because nothing about the
  rule reads the caller's environment.
- **Each launch tier declares how it confirms**, as a field on the plan rather than a fact somebody
  infers from the tier's name. The handoff dispatches on that field, so a tier added later has to
  answer the question instead of inheriting an answer that does not hold for it.
- **`systemd-run --user --collect` confirms through the manager.** The client is run synchronously
  and its exit code is read. `systemd-run` without `--wait` returns as soon as the manager has
  accepted the job and started the unit, so the wait is tens of milliseconds and the race is gone by
  construction: the staging cannot exit before the runner exists. Exit zero means the manager
  accepted the job. What happens inside the runner afterwards is the runner's own failure, reported
  through the run record as before.
- **The wait is bounded**, at fifteen seconds. An unbounded synchronous call would turn a wedged
  D-Bus into a staging process that never exits, which is worse than the stall it replaces.
- **`setsid` and the plain fork confirm nothing, because there is no manager to ask**, and on those
  tiers the child is not a fast client, it is the whole runner. Before launching, such a tier reads
  its own cgroup and refuses when it is inside a `.service`, naming the unit and saying that a
  hand-off from inside a service needs the user manager. Making those tiers survive a service cgroup
  without a manager is not possible and is not attempted.
- **A handoff that did not happen is an abort, not a silence.** The lock is released, an `abort`
  record is written, and the reason carries the tier, the exit code or the word timeout, and the
  first line of the client's stderr. The client's own output is appended to the runner log, the file
  the operator is told to watch.

## Consequences

- **"Handed off" is now printed after the manager answered.** The command is slightly slower by
  design, by the tens of milliseconds job acceptance takes, and the line it prints is true.
- **The phone sees a refused handoff within one poll**, as an abort with a reason it can show,
  instead of a run that looks live for ten minutes with the button locked and the retry refused.
- **An unconfirmed tier is now a refusal where it used to be a silent death.** A host with no user
  manager still updates from a shell. A host whose bus probe fails while the bridge runs as a
  service gets an error naming the unit, which is the honest answer and not the one an operator
  wanted.
- **The abort reason quotes a tool.** `systemd-run`'s wording may change between systemd releases.
  That is accepted: the reason is a diagnostic for a person, nothing parses it, and a quoted
  complaint beats `exit 1`.
- **Machines already stuck are not repaired by this.** A 1.6.0 install that hit the defect still
  holds its lock and its `staging` record until the staleness window passes. The recovery is by
  hand, and it is written down in [`docs/troubleshooting.md`](../docs/troubleshooting.md).
- **What would justify revisiting.** A launcher that can prove the runner exists without running a
  client at all, for instance a manager API this process can call and read an answer from, or a
  platform where a detached child genuinely leaves the caller's resource domain. Either would
  replace the synchronous client with something cheaper and keep the invariant in the heading, which
  is the part that must not be traded away.
