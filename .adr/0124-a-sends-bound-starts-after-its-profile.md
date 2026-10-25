# 0124: a send's bound starts after its profile

- **Status:** Accepted
- **Date:** 2026-10-25
- **Shipped in:** unreleased (1.24.1 candidate)
- **Trail:** issue #594 (follow-up to #544) · the reporter's `collie doctor` row `surface-pi--` (`unknown-outcome 18`,
  `probed 2`, version `-`) · rig runs of 2026-10-25 under `~/.cache/collie-lab/pi-594/` (pi 1.3.0, pi-powerline-footer
  0.20.2, @baggiiiie/pi-context-chart 0.0.5, a goal widget that ticks over the box, a 254-column pane) ·
  `bridge/surface/protocol.ts` · `bridge/surface/binary-version.ts` · `bridge/login-path.ts` ·
  `bridge/surface/holds.ts` · `web/src/components/composer-held.tsx` · fixtures `pi--v130-powerline-goal-widget-idle--w254.txt`,
  `pi--v130-powerline-goal-widget-running--w254.txt`, `pi--v130-powerline-welcome-idle--w254.txt`,
  `pi--v130-powerline-welcome-gone--w254.txt` · amends the Send Protocol's bound (M56 spec 05, the
  protocol header) and [ADR 0091](./0091-launch-by-id-with-a-request-id.md) (the login shell's PATH)

## Context

Every send on the reporter's pi pane ended `unknown` with "The send ran past its bound." The first guess
was the screen: a goal widget ticking its seconds over the box, and a footer of five rows under it. The rig
ruled that out. On the same extensions and width, an idle send went in with S0 at 133 ms, and a send into
a running turn went into pi's queue. S0 compares the box alone, and the probe and S1 of a message into a
framed box read only the box and the rows under it, so a row that only ticks moves no compare.

The reporter's own numbers point elsewhere. A profile marked `provisional` probes every send that passes
S0, but only 2 of their 18 `unknown` sends were probed. The other 16 ended before S0's first read, and
the only `unknown` there is the guard: the request was already past its deadline. The deadline was the
accept time plus the step bounds, 7.6 s. Before S0 the run waits for the profile, and the profile waits
for the binary's version: the login shell's PATH (asked once a process, 3 s cap) and then
`pi --version` (5 s cap). Their version cell is empty, so that read failed.

The caps did not bound the read. Bun's spawn `timeout` kills the child, but the read of its stdout and
stderr waits for both pipes to close, and a grandchild that inherited them keeps them open after the
kill: a shell wrapper's `sleep`, an agent a login profile starts, a node script's helper. The lab's slow
stand-in returned after 20 s against the 5 s cap. With the rig's bridge reading such a binary, a send
answered after 9 s with `unknown(bound)`, nothing read and nothing typed, as in the report. A read that
failed was then trusted for 10 minutes, so the next send that came 10 minutes later paid again, and two
sends that asked during one read each started their own.

The same guard also ended steps that had used their own bound to the end: a poll whose step end is the
request's deadline sleeps up to that end, a real timer wakes a millisecond late, and the next read met
the guard. S2's `no_evidence` and S1's `typed_not_submitted` came out as `bound` with no word of which
step it was.

## Decision

1. **The bound starts once the profile is known.** The run measures the wait from the accept (or a held
   send's release) to the profile and moves the deadline by it. The receipt keeps it as `gapsMs.profile`,
   and the phone's receipt list prints it first. A slow version read no longer spends the send's time.
2. **The version read is bounded for real.** `boundedRun` (`bridge/login-path.ts`) kills the child at its
   cap and answers at once, never waiting for the pipes. The login shell's PATH, the version command
   and `collie doctor`'s version read all use it (3 s each; doctor names a killed read "did not finish in time"), and the whole read ends inside `VERSION_READ_BUDGET_MS` (4 s), so a
   send waits at most that long for its profile. The login PATH keeps resolving in the background, once
   per process, for the next read.
3. **A failed read stands for `VERSION_FAILED_CACHE_MS` (60 s), a good one for 10 minutes.** A later
   success replaces a failure. Sends that ask while a read runs share it. The cache is per bridge
   process, so per host.
4. **A step that runs out at the request's bound ends with its own outcome.** A poll that wakes past the
   deadline ends the step as its own bound would. The guard still ends a request whose write, submit key
   or read starts past the deadline, and its detail names the step and the gaps so far: "The send ran
   past its bound at the submit key (s0 120 ms, probe 160 ms, write 0 ms, s1 80 ms, commit 0 ms so far)."
5. **An unread version says so.** A version Collie could not read leaves the profile `provisional`, and a
   send in a running turn is held, not queued, by design: the queue key is trusted only on a version the
   binary reported. The refusal, the held answer and the held row (`versionUnread`) now say the version
   is unread and point to `collie doctor`, which names the binary it resolved and why the read failed.
6. **pi's rows above the box may lose text** (`idle.volatile.above.losesText`). A fresh pi session draws
   a welcome splash over the box and clears it at the first key. On an unread version the probe compares
   the whole screen, and the splash going read as a moved screen, so the first send of every session was
   held once. Rows that only go blank or scroll away pass; a row that gains text still fails.

The rule that a row which changes only in a time or counter token is no moved screen needed no change:
S0's two reads compare the box, a running row's spinner and digits are masked (`steadyRow`), the profile's
volatile band over the box is left out, and a message into a framed box is judged by the box and the rows
under it. The protocol tests pin it on the live captures: a widget that ticks on every read, a footer row
that ticks, both at once in a running turn, and a dialog that opens at the first key, which still stops
the send.

## Consequences

- A send on a host whose agent answers `--version` slowly waits up to 4 s before S0, once a minute,
  and its receipt shows the wait.
- A `bound` receipt names its step. A report with one tells which step used the time.
- A stuck version read no longer leaves a child Collie waits on; a grandchild that holds the pipe
  ends on its own, unread.
- The reporter's sends still run `provisional` until their pi's version reads. In a running turn they are
  held until the turn ends; `collie doctor` says why the version is unread.
