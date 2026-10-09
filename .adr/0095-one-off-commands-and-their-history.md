# 0095: One-off commands and their history

- **Status:** Accepted
- **Date:** 2026-10-09
- **Shipped in:** pending (1.19.0)
- **Relates to:** [ADR 0091](./0091-launch-by-id-with-a-request-id.md) (the launch kinds, the request
  id and the folder rules this reuses), [ADR 0094](./0094-launchers-added-from-a-phone.md) (the
  `[phone]` switches, the character rule and the versioned state file this copies),
  [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the crew link forwards, it does
  not interpret), [ADR 0017](./0017-recognising-a-password-prompt-changes-what-collie-says.md) (what
  the audit log keeps of typed input).
- **Trail:** `bridge/server.ts` (`launch`, `pickLaunch`, `pickRun`, `runLaunch`,
  `serveRecentRunRoute`, `launchersRoute`) · `bridge/recent-runs.ts` · `bridge/operator-launchers.ts`
  (`[phone] run`) · `bridge/crew/forward.ts` · `web/src/lib/api.ts` (`startRun`, `removeRecentRun`,
  `clearRecentRuns`) · `bridge/run-once.test.ts`

## Context

The New page starts an agent, a `launchers.toml` row, a row a phone added, or a plain shell. The
owner also wants to start a command nobody configured, straight from that page, and start it again
later from a list. Until now there were two ways to do that, and both were clumsy:

- **Open a shell and type.** It works, because a paired phone may open a shell and type into it.
  It takes two screens and the keyboard, and nothing remembers the line.
- **Add a free-text row.** That needs `[phone] free_text = true` (off by default, ADR 0094), and it
  makes a permanent row for a line the person wanted once.

ADR 0094 says the launch allowlist is the security story of `POST /api/launch`. A one-off run seems
to break that. It does not add a power, though: the phone could already reach the same shell and
type the same line. The allowlist protects a stolen token from *adding a row* that every phone then
offers; a one-off run adds no row.

## Decision

**`POST /api/launch` takes a fourth kind, `{ run: "<line>" }`, typed into a fresh shell exactly as a
row is. A run that works joins a per-machine history of twelve lines, and starting from the history
is the same run again.**

1. **The shape.** Exactly one of `command`, `harness`, `shell: true` and `run`; none or two is a 400.
   `cwd` and `requestId` mean what ADR 0091 says. A `run` on `POST /api/worktree` is refused with
   `launch.run_no_branch` before any git or multiplexer call: a one-off line never starts on a new
   branch, as the page already holds for a command row. A `run` field there used to be ignored, which
   would have opened a plain shell, so the refusal is on the bridge too.
2. **The gates, in order, all before anything runs.** A paired device (`launch.no_device`, 403), the
   operator's switch (`launch.run_off`, 403), the character rule of ADR 0094 at 200 code points
   (`launch.bad_line`, 400, detail `{ problem, max }`), then the folder rules of ADR 0091
   (`launch.bad_folder`, `launch.folder_missing`). The route is on the write gate like every launch.
3. **The switch.** `[phone] run` in `launchers.toml`, default **true**; a value that is not a boolean
   reads as false. On by default because a paired phone can already open a shell and type into it,
   so the run adds no power; the switch lets an operator remove the shortcut.
4. **Typed as a row is.** The line goes through `typeIntoFreshShell`, the one path a row, an agent and
   a worktree launcher take. The space is named after the command word.
5. **Request ids.** As ADR 0091: a replay answers the first pane and runs nothing, a request still in
   flight is joined, a failed send closes the pane and stores no receipt.
6. **No prompts.** The answer carries `noPrompts`, the result of `scanNoPrompts` on the line, and each
   history entry carries it too, so the page can badge it and confirm before it runs the line again.
   The bridge does not require that confirm, the same as for rows.
7. **The history.** `<stateDir>/commands-recent.json`, `{ "version": 1, "entries": [...] }`, mode 0600,
   written to a temp name and renamed over the target, as `launchers-added.json` is. Each entry is
   `{ line, cwd, at, noPrompts }`, where `cwd` is the folder it last ran in, absolute, or `null` for
   home. At most 12 entries, newest first, one per exact line; a re-run moves a line to the top. An
   entry is recorded only after a run that worked: never on a refusal, a replay or a joined retry. A
   history that cannot be written does not undo the run.
8. **Checked again at read.** Every entry meets the character rule again, and its folder must be
   absolute or `null`; an entry that fails is dropped alone. A visible no-prompts flag reads as
   no-prompts whatever the file says. A file that is not version 1 reads as empty and refuses every
   write until the operator moves it away.
9. **On the wire.** `GET /api/launchers` gains `recentRuns: [{ line, cwd, at, noPrompts, available,
   reason? }]`, and `adding.run` carries the switch. While the switch is off the history is still
   listed, and each entry is unavailable with reason `run_off`. `POST /api/launch/recent/remove
   { line }` and `POST /api/launch/recent/clear {}` are writes that any paired write device on that
   machine may call. There is no separate start route for an entry.
10. **Crew.** A run rides the existing `launch` forward, and the two history writes are forwarded the
    same way: `?host=` reaches that member's own file, and nothing is copied between machines.
11. **Unpair and revoke leave the history alone.** An entry is a line, not a grant: running it again
    is a fresh one-off run, which needs a paired device, the write gate and the switch at that moment.
    A revoked device can run nothing, so its lines give it nothing. Unlike a phone-added row (ADR
    0094), an entry is never offered as something the machine starts on its own authority.
12. **The audit line names the command word and the length, never the line.** A run writes
    `workspace.run` (or `tab.run`) with `{ program, length, cwd, requestId }`. `program` is the first
    word after any leading `NAME=value` assignments, so `TOKEN=… deploy` records `deploy`. The two
    history writes record `launch.recent.remove { program, length }` and `launch.recent.clear
    { removed }`. Pane input is not kept whole either: a reply is a 120-character preview, and Type
    mode keeps no character at all. A history line is the one place a person might type a secret
    into a launch, so the run keeps less than a reply does. Under `COLLIE_AUDIT_CONTENT=none` the
    word redacts and the length stays. The service log's line for a shell that never settled gives
    the length of a one-off line too, not the line.

## Consequences

- A person can start `make test` or `htop` on any machine from the New page without editing a file,
  and start it again from the history with one tap.
- `launchers.toml` is still the only list of rows the operator writes, and `[phone] free_text` still
  governs rows. A one-off run makes no row.
- The state dir gains one file, written only by a one-off run that worked.
- The history is readable by any paired device on that machine and can hold a secret the person
  typed. It sits in the state folder at 0600, as the audit log does; the person can remove a line or
  clear the list from the phone.
- An operator who wants no free lines at all from a phone sets both `free_text = false` (the default)
  and `run = false`.
