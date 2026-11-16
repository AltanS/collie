# 0143: How an install updates, and what a release offers it

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0006, ADR 0020, ADR 0037, ADR 0044, ADR 0045, ADR 0050, ADR 0062, ADR 0064, ADR 0110
- **Trail:** #63 and herdrdev/herdr#2250 (leave a managed install to `herdr plugin install`), #169 (a
  marker file the packager writes), #468 and #465 (every machine takes one build on one day), #283,
  PR #71 and PR #298 (Windows as best effort), PR 634 (math engines in every payload), the incidents
  of 2026-09-20 and 2026-09-23. Files: `cli/update.ts`, `cli/update-run.ts`, `cli/install-kind.ts`,
  `bridge/update.ts`, `bridge/update-line.ts`, `bridge/update-action.ts`, `bridge/crew/follow.ts`,
  `web/src/lib/update-screen.ts`, `docs/upgrading.md`

## Context

Fifteen records shaped the update one fault at a time: a turnkey install that could not update, a silent major, a runner killed with its parent's cgroup, a sleeping laptop that blocked a desktop,
and a regression that reached every machine on one day. Several changed others inside their bodies.

## Decision

1. The install kind picks the path, once, from shapes on disk. An install Collie cannot name is
   refused with the reason, never guessed. A packaged install belongs to its package manager.
2. A Herdr-managed checkout advances in place onto a release tag and is never re-linked, because a
   reinstall is its way back and a re-link would block it. It has no rollback.
3. Every other install stages: the new version is built or downloaded beside the live one, and one
   rename of `current` makes it live. A separate runner restarts through the new binary and waits for
   health. It rolls back once, never twice, then stops as `stuck`. Only a successful run prunes.
4. The staging process exits only after its runner is out of its cgroup. A launch that cannot
   confirm that refuses to start from inside a service.
5. One update at a time per machine, and one crew run at a time per crew.
6. A routine update stays inside the installed major. `--major` is the consent to cross one: a flag,
   never a prompt. A prerelease install follows its own train only until a strict release exists.
7. Each machine is on one release line, Stable or Edge. One resolver decides what it is offered, for
   the banner, the verb and the phone alike. Switching the line installs nothing. A machine moves to
   a lower version only by a rollback or a person's switch back to Stable. A build it rolled back
   from is never offered again.
8. A state file only grows: new fields and new files, never a removed, renamed or retyped one, so the
   last Stable can read what a newer build wrote.
9. The name on PATH is a symlink to the live binary, never a copy or a wrapper.
10. Code reaches a crew member from GitHub, by its own decision, or over the operator's SSH. The crew
    link carries the lead's settled release, its line and a turn, never code. A member takes only a
    release, never a major, at most once an hour, and steps down only after its lead's rollback or
    switch.
11. A crew fault blocks the lead's own update only when the update makes the fault worse.
12. An update push comes at most once a day and never before 09:00 host time; a patch-only delta
    waits a week. One changelog line can mark a release urgent. The version never carries it.
13. One pure reducer decides the update screen. A run this device started locks the app until it
    ends, and this phone reloads once, last.

## Today in the code

- Rule 1: `classifyInstall` (`cli/install-kind.ts`) answers `linked-clone`, `detached-checkout`,
  `binary`, `packaged` or `unknown`; `cmdUpdate` (`cli/update.ts`) is the one fork on it. Packaged
  needs no `.git`, no `versions/`, a `herdr-plugin.toml`, and a root that is read-only, outside `$HOME`
  or owned by uid 0. `updateStartVerdict` and `rollbackVerdict` (`bridge/update-action.ts`) refuse
  it as `update.packaged`, and `followGuards` (`bridge/crew/follow.ts`) refuses it first.
- Rule 2: `isManagedCheckout` is the one predicate (`git symbolic-ref -q HEAD`). `detachOnto` fetches
  `--depth 1` only on a shallow checkout and detaches with `--force`. `refreshRegistry` never runs
  `herdr plugin link` there, and `cmdUpdate` refuses its `--rollback`. The action commands in
  `herdr-plugin.toml` are frozen byte for byte, because Herdr before 0.8.0 runs a cached copy.
- Rule 3: a linked clone stages too (`updateStagedCheckout`); a binary install checks the payload's
  sha256 against the release manifest (`updateBinary`). The flip refuses without `BUILD_MARKER`.
  `driveApply` (`cli/update-run.ts`) waits `DEFAULT_HEALTH_TIMEOUT_MS` (30 s), and its reducer allows
  one rollback. Retention runs only on `done`, never after a rollback or a switch: a checkout keeps
  `KEEP_VERSIONS` (3, `current` counted, `pruneVersions`), a binary install 2 (`collectOldVersions`).
  `restartThroughCurrent` restarts with the new binary. On Windows `current` is a junction
  (`flipJunction`), and a source checkout is refused (`WINDOWS_CHECKOUT_SENTENCE`).
- Rule 4: `handOff` waits for `systemd-run` up to `HANDOFF_CONFIRM_MS` (15 s); `setsid` and fork
  refuse inside a `.service` (`serviceCgroup`). A refused hand-off writes an `abort`.
- Rule 5: `refuseIfUpdateRunning` and the lock; a run still for `STALE_AFTER_MS` (10 min) with a dead
  pid reads `interrupted` (`bridge/update-run.ts`). `updateStartVerdict` answers `update.in_progress`
  while a crew run is open, and `CREW_RUN_TTL_MS` closes a crew run after 2 hours.
- Rule 6: `planUpdate`, `nextMajorRelease` and `wantsMajor` (`cli/update.ts`); `followsTrain`
  (`bridge/update.ts`). The phone needs its own confirm for a major (`update.major_confirm_required`).
- Rule 7: `lineOffer` (`bridge/update-line.ts`) serves `planUpdate` and, through `lineReading`, the
  bridge's monitor. No `update-line.json` reads as Stable. `POST /api/update/line` needs a request id
  and installs nothing. `planToTag` takes a lower tag only with `--downgrade`, which the bridge
  passes for `POST /api/update/back` and a member's step down. `afterRollback`, `afterFailedBuild`
  reject an Edge build; `lastStableKept` keeps the last Stable on Edge; `stampCheckout` stamps Edge.
  A tag whose `collie-release.json` answers 404 is not offered yet (#503).
- Rule 8: `bridge/state-shapes.test.ts` (fixtures of 1.22.6) holds `UNREADABLE_BY_LAST_STABLE` empty.
- Rule 9: `cmdLink` (`cli/link.ts`) replaces only a name Collie published, and `cmdUnlink` removes only
  this checkout's own. `republishName` re-points the name at `current` after the first staged update.
- Rule 10: `LEAD_RELEASE_HEADER`, `LEAD_LINE_HEADER`, `UPDATE_TURN_HEADER` and `followGuards`: no `-dev`
  build, no major, no rejected build, one try per tag and run, and `FOLLOW_ATTEMPT_INTERVAL_MS` (1 h)
  except for a later step of the same run or a fresh step down. `UpdateTurns.observe` grants a turn
  only at the target. `cmdCrewUpdate` (`cli/crew-update.ts`) asks one TTY consent, with no `--yes`.
- Rule 11: `doctorCheck` (`cli/update-check.ts`) is red only on a local error; a crew error and a
  `sends-<harness>` error are amber. `mergedUpdateVerdict` with `tolerateAbsent` lets an unreachable
  member pass the lead's own start, not a peers-only run. `skewCheck` stays red for a member below
  `PROTOCOL_FLOOR_VERSION` (1.8.0) under a lead at 1.9.0 or newer.
- Rule 12: `shouldNotify` (`bridge/update.ts`); Edge skips the windows, not the 09:00 floor.
  `scripts/release-reading.ts` writes `urgent` into `collie-release.json`.
- Rule 13: `web/src/lib/update-screen.ts` decides `dismissible`, the seven steps and every threshold;
  `update-run-store.ts` owns the poll and the standby door; `web/src/sw.ts` counts files. The claim
  lives in `sessionStorage` for `CLAIM_MAX_AGE_MS` (3 h, `update-ribbon.ts`), `UPDATE_MODE_HOLD`
  holds the reload, and `DESIGN.md` section 6 fixes the panel heights.

## Recorded, not found in the code

- ADR 0050 point 3: the card names an unreachable member before the tap ("It will be skipped").
- ADR 0021: no install path publishes the name. `scripts/install.sh` runs `collie link`.
- ADR 0020: a linked clone gated at `@{u}` before `git pull --ff-only`. `updateLinked` exists, but
  `cmdUpdate` stages every linked clone, so no verb reaches it.

## Consequences

- A failed build changes nothing a person sees. A silent member below a future protocol floor gets
  no floor check; the next protocol bump must decide that case (ADR 0050).
- Live beside this record: 0035 (packaged), 0046 (urgent), 0075 (Windows), 0132 (the math pack is a
  release asset fetched on a tap), 0144 (the crew link, which replaced 0016), 0111 (`collie skill sync` after an update).

## What we tried before

- 0006, 0021: every checkout advanced in place, now only a managed one; the PATH name is a pointer.
- 0020: a major by flag, and a beta install frozen on its beta until the addendum of 2026-08-30.
- 0037: a fire-and-forget hand-off; `KillMode=process` and a poll loop were declined.
- 0044, 0064: three surfaces read one run; then one reducer, and update mode with no toast at the end.
- 0045, 0050: every crew error was red; then only a fault the update makes worse blocks.
- 0062: the lead granted a turn before it stated its target, and the member counted the second step.
- 0110: one line for every machine; then Stable and Edge, and the state-shape rule.
