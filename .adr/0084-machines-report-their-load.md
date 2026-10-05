# 0084: Machines report their load

- **Status:** Accepted
- **Date:** 2026-10-05
- **Shipped in:** 1.17.0
- **Relates to:** [ADR 0042](./0042-notification-kinds-and-the-cache-watch.md) (the cache
  warning, whose shape the machine alert copies), [ADR 0074](./0074-a-push-title-is-a-code-the-phone-translates.md)
  (push titles are catalogue codes), [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (Collie collects nothing;
  this holds). Nothing in them is retracted.
- **Trail:** `bridge/machine-stats.ts` · `bridge/machine-history.ts` · `bridge/machine-alerts.ts` ·
  `bridge/machine-parse.ts` · `bridge/machines.ts` · `bridge/crew/router.ts` and `lead.ts` (the
  sibling) · `bridge/server.ts` (`serveMachinesRoute`) · `CREW_PROTOCOL.md` §5, §7.1, §11, §19 ·
  `docs/crew.md` → *Machines*

## Context

An operator with three machines in a crew could see every agent on each of them and nothing about
the machines themselves. A build that pins a laptop's CPU for an hour, or a member that runs out of
memory, was found by walking over to it. The phone already talks to the lead, and the lead already
asks every member for its snapshot on every sweep, so the fact was one field away.

## Decision

1. **Each Collie samples its own machine, on the tick it already has.** `MachineSampler` reads CPU,
   memory, load and network at most once every five seconds, from the `StateEngine.onTick` listener
   list. There is no second timer and no child process (CREW_PROTOCOL.md §10.1, §11). On Linux CPU
   comes from the aggregate line of `/proc/stat`, with iowait counted as idle, because Bun's
   `os.cpus()` there drops iowait, softirq and steal (measured 2026-10-05 under Bun 1.4.1: each core's
   times are exactly 10 x the jiffies for user, nice, sys, idle and irq, and nothing else). Memory on
   Linux is `MemTotal - MemAvailable`, so the page cache is not counted as used. Network on Linux is
   `/proc/net/dev` without `lo`. Every other platform reads `node:os`: CPU from `os.cpus()`, memory
   from `totalmem - freemem`, no network, and no load average on Windows, where Node answers zeros.

2. **A member's reading rides the answer it already gives.** `machineStats` is an additive-optional
   sibling of the `/crew/v1/snapshot` body, beside `version`, `updatePreflight` and `updateRun`. The
   peer reads the sample it holds, so the answer does no disk read. The lead parses it defensively:
   any field that is not a finite number in range drops the whole sample. It stamps the sample on
   its own clock (§10.2). `X-Crew-Protocol` stays `2`.

3. **The history is the lead's, not each member's.** The lead (or a solo Collie) keeps one bucket per
   minute per machine for 24 hours: CPU average and maximum, memory fraction, and network averages.
   It persists them to `machine-history.json` from the tick, at most once every five minutes and on
   shutdown, atomic and owner-only. A peer keeps nothing. The phone asks the lead for everything, so
   history kept on a peer would need a forwarded route and a second copy of the same day, and would
   still be lost with that peer. A removed member's history is dropped with it.

4. **One rule per metric per machine, judged by a pure function.** Rules live in
   `machine-alerts.json` on the lead, keyed by member id, written on change only. A rule fires when
   every complete minute in its window is at or above the line and at least 80% of the window has
   data. The episode closes after five straight complete minutes below the line minus 0.05. Open
   episodes are saved with the rules, so a restart does not push twice. An unreachable machine
   neither opens nor closes an episode: missing data is not a recovery.

5. **The push is the cache warning's shape.** `type: "machine"`, tag
   `collie:machine:<id>:<metric>`, title codes `machine.cpu` and `machine.mem`, and
   `data: { target: "machine", machine: <id> }` so a tap opens `/machines/<id>`. The id is not in
   `host`: an old cached service worker reads `host` as a crew member and opens `/?h=<id>`, which
   names no member on a solo Collie (id `local`); with no `host` it opens the dashboard. The collapse
   topic is one per machine and metric, `collie-machines-` and the first 12 base64url characters of
   the SHA-256 of `<id>:<metric>` (28 characters, `machineTopic` in `bridge/push.ts`), so two alerts
   queued for an offline phone do not replace each other at the push service. It respects the snooze, and a
   snooze records nothing, so a value that outlasts it still pushes. The new `NotifyPrefs.machines`
   switch is on by default, because a rule is something the operator set on purpose.

6. **Three routes, on the lead and on a solo Collie.** `GET /api/machines`,
   `GET /api/machines/:id/history` and `POST /api/machines/:id/alerts`. A peer answers 404
   `crew.not_lead`, like `/api/crew`. None is forwardable with `?host=`. The POST takes the write gate
   and is audited as `machine.alerts`, with the machine in `host`. A row's id is the
   `CrewMemberStatus.id` of `GET /api/crew`, the lead's own row included. A solo Collie that never
   enrolled answers one row, id `local`.

7. **Solo zero-tax is renegotiated on purpose.** The three routes and the two files join the
   solo-baseline goldens. `machine-alerts.json` appears only after the first rule.
   `machine-history.json` appears after five minutes of running. No snapshot key is added, the
   browser's snapshot bytes are unchanged, and nothing is written by a bridge that is only started
   and stopped.

## Not built

- **Per-process figures.** A reading is per machine. Which process is busy is a question for the
  terminal on that machine.
- **History on a peer.** Covered in point 3.
- **Alerts while the lead is down.** The lead judges. When it is down nobody records and nobody
  judges, and the chart shows a gap.
- **Network figures off Linux, and disk.** No `node:os` source exists for them without a child
  process.

## Consequences

- ADR 0034 holds: readings travel on the crew link and stay on the lead. Nothing is collected or
  sent outside the crew.
- A member older than this feature sends no reading. Its row says "no sample", never zero.
- The day of minutes costs the lead about 9 numbers x 1440 minutes per machine on disk, rewritten
  at most every five minutes.
