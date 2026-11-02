# 0127: The lead's launcher rows are the crew's rows

- **Status:** Accepted
- **Date:** 2026-11-03
- **Shipped in:** pending
- **Relates to:** [ADR 0094](./0094-launchers-added-from-a-phone.md) (amended: points 7 and 11 are
  superseded, the rest stands), [ADR 0091](./0091-launch-by-id-with-a-request-id.md) (launch by id,
  the request id and the receipt, unchanged),
  [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the crew link forwards, it
  does not interpret; the lead is the one phone-facing door),
  [ADR 0089](./0089-a-second-agent-on-a-branch.md) (the worktree launch carries the same row),
  [ADR 0095](./0095-one-off-commands-and-their-history.md) (one-off history stays per machine).
- **Trail:** the New screen on `bluefin-hc` and `minibuch`, 2026-11-02: the rows Altan declared on
  the lead were missing, and the rows of each member were locked to that member ·
  `bridge/launcher-adds.ts` · `bridge/server.ts` (`launchersRoute`, `pickLaunch`) ·
  `bridge/crew/forward.ts` · `bridge/crew/standby-launchers.ts` (new, beside
  `bridge/crew/standby-devices.ts`) · `web/src/routes/new.tsx` · `web/src/routes/new-add.tsx` ·
  [`CREW_PROTOCOL.md`](../CREW_PROTOCOL.md) (the route table, §18.14) · milestone M82

## Context

ADR 0094 gave every machine its own list. A machine reads its `launchers.toml` and its
`launchers-added.json`, merges them, and offers the result. The lead forwards `GET /api/launchers`
and `POST /api/launch` to the machine the phone picked with `?host=`, and forwards the three add
routes the same way. Point 7 says "no row is ever copied to another machine". Point 11 says "one
list per machine".

The reasons in 0094 were about something else. A bridge that rewrites `launchers.toml` loses the
operator's comments. A free line is a remote shell line. A chip with no prompts must not read as an
answer to a prompt nobody saw. None of these is an argument for keeping the rows on the machine
that runs them. They would hold just as well if the rows lived on the lead.

The cost showed on 2026-11-02. Altan declared his agent commands once, on the lead, and the New
screen with a member picked offered none of them. Rows he added from the phone while a member was
picked landed on that member and stayed there. His words: "my agent commands are not prepopulated
but locked to machines." The crew is one thing to the person holding the phone. The lead is already
the machine that holds the pairing and masks the members' text. Its rows are the ones the person
wrote.

The allowlist is the part to keep safe. `pickLaunch` accepts a `command` only when it equals a row of
this machine's merged list. The lead forwards the body untouched, so a member never receives a row
definition. If a member is to run a lead row, it must learn the row from somewhere, and a phone must
not be that somewhere.

## Decision

**The lead's merged launcher rows are the crew's rows. The New screen offers them on every host. A
launch of a lead row on a member carries the row over the crew link, and only over the crew link. A
member's own rows stay as its additions.**

1. **The lead's list is the crew's list.** The lead's merged rows (its `launchers.toml` plus its
   `launchers-added.json`) are offered for every host of the crew. A member's own rows are its
   additions for that host. On the same `command`, the member's own row wins: the local operator's
   word, and its `cwd`.
2. **A row is evaluated where it would run.** `available` and `reason` of a lead row for a member
   come from the member: its harness list (`not_found`) and, for a pinned `cwd`, whether the folder
   exists there (`no_folder`, new). A `~` in a `cwd` is the member's home.
3. **A launch of a lead row on a member carries the row.** `POST /api/launch` and
   `POST /api/worktree`, forwarded with `?host=`, gain a `row` field (`command`, `label`, `cwd?`,
   `harness?`, `noPrompts`). The lead sets it when the command is one of its rows. A member accepts
   `row` only when the call came over the crew link from its lead (`caller.via === "crew"`). A
   phone-direct body with `row` is refused, `launch.row_not_from_lead` (400). When the member's own
   list matches the `command`, its own row wins and `row` is ignored. So the allowlist on the phone
   door is unchanged: a phone names a row, it never sends a line.
4. **Adds go to the lead.** `POST /api/launchers/added`, `/remove` and `/rename` are answered on the
   lead whatever `?host=` says. The rows a member's store already holds stay, and they are listed as
   that member's own. The wording "added on {machine} only" goes from the New screen.
5. **The deputy keeps a copy.** The lead's merged rows are synced to the deputy beside the device
   registry (CREW_PROTOCOL §18.14). The deputy serves them while it leads. It holds them as a
   read-only copy, never merged into its own files.
6. **What does not change.** ADR 0094 points 8 and 10 stand: operator rows cannot be changed from a
   phone, and the no-prompts confirm stays per device, per machine and per line. Sent and the
   one-off history stay per machine (ADR 0095, ADR 0107). Solo mode stands: one machine is its own
   lead, and nothing is forwarded.
7. **Consequences** are listed below.

## Consequences

- **A member runs a line its lead sent over the pinned link.** A paired phone can already type into
  a member's pane, so the phone gains no power. The lead is already the phone-facing trust root: it
  masks the members' text and holds the pairing. The member's `row` check is what keeps a phone from
  using the same door by hand.
- **An old member says no, plainly.** A member that predates 0127 ignores `row` and answers
  `launch.not_allowlisted`. The lead passes that answer on, and the phone says the machine needs an
  update. Nothing runs by accident.
- **A lead row can be absent on a member.** A row whose `cwd` does not exist on the member reads
  unavailable with `no_folder`. A row whose harness is not installed there reads unavailable with
  `not_found`. The person sees the reason before the tap.
- **One place to edit.** A row added from the phone, or written in the lead's `launchers.toml`,
  shows on every machine at once. A row a member had before stays on that member and still runs.
- **The deputy needs the copy to lead.** Without it a takeover would show an empty list. The copy is
  a file the deputy reads and never writes into its own stores, so a demotion leaves nothing behind
  to merge.
- **The wire grows by one optional field and one error code.** `row` is additive-optional
  (CREW_PROTOCOL §7.1). The add routes stay in the route table, answered on the lead; only
  `forget-device` still crosses the link, unchanged.
