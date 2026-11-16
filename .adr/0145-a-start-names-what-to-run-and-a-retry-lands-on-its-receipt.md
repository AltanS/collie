# 0145: A start names what to run, never a line, and a retry lands on its receipt

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0089, ADR 0091, ADR 0093, ADR 0094, ADR 0095, ADR 0127
- **Trail:** ADR 0032 (the multiplexer makes the worktree, reversed by 0126), the New page on the
  Herdr core on 2026-11-02 (M81), the owner's report of 2026-11-02 that rows were locked to machines
  (M82), the counsel on M82 spec 07 (a header marks a lead row, not the body), the release counsel
  on ADR 0095 (runs off by default, secret lines kept), issue 732, M100 spec 04. Files:
  `bridge/server.ts` (`launch`, `pickLaunch`, `createWorktreeAt`), `bridge/launch-receipts.ts`,
  `bridge/worktree-receipts.ts`, `bridge/worktree-add.ts`, `bridge/worktree-folder.ts`,
  `bridge/launcher-adds.ts`, `bridge/crew/launcher-rows.ts`, `docs/configure.md`

## Context

The New page, the "+" sheet and a pane's "New agent in a worktree" start an agent, a row, a one-off
line or a shell on any machine of the crew, maybe on a new branch. Eight records shaped this one step
at a time. The Files and Changes views are another topic (ADR 0150, with 0088 beside it).

## Decision

1. **The bridge owns what may start.** A start names exactly one kind: `command` (a row, matched
   exactly), `harness` (an id from the bridge's own list), `shell: true`, or `run` (a one-off line).
   None or two is a 400. The phone sends a line to type only as a `run`. Starters (ADR 0146) and
   accounts (M101) ride the same route and belong to their own topics.
2. **The agents are the bridge's list.** Each id is a mux contract name with one binary word, looked
   for on the operator's login shell PATH (asked once per process, kept 60 s). An answer with no
   `harnesses` field is an older bridge, and the phone offers it no agent rather than guess.
3. **The allowlist is a merge at read time, never stored.** Built-in ids, then the operator's
   `launchers.toml`, then the rows phones added, as far as the `[phone]` switches allow. An operator
   row wins on the same line. The bridge never writes `launchers.toml`: it would lose the operator's
   comments, and a stolen token would edit the operator's own list.
4. **A phone adds a recipe, and a free line only on the operator's word.** A recipe is a harness
   plus option ids; the bridge builds the line from its own table. The switches are `adds` (on),
   `free_text` (off) and `run` (on); a value that is not a boolean reads as off. A stored row meets
   the add's rule again at every read. A line is at most 200 code points, a label 60, with no control,
   separator or bidi character. A row that skips permission prompts carries a badge, and each device
   confirms it once per machine and line; the bridge does not require that confirm.
5. **A named folder is checked on the machine that runs.** `cwd` is absolute, `~`, or a bare name
   under home; a `..` as sent, a control character or `~name` is refused, and so is a folder that is
   not there. A row's pinned folder wins.
6. **One request id per intent, and one receipt.** The phone mints a UUID per intent and keeps it
   for a retry of that intent. A known id answers the first outcome with `replayed: true` and runs
   nothing; an id in flight is joined. The phone never re-sends on its own: "Try again" sends the same
   id. A create nobody can confirm stays `unknown`, and that id never creates again.
7. **A one-off run adds no power.** A paired phone can already open a shell and type the line, so a
   run is on by default. It is never a row and never starts on a new branch. A run that worked joins
   that machine's history of twelve lines, unless the line looks like a secret. A revoke leaves the
   history alone: a line is not a grant.
8. **A worktree is Collie's.** The bridge runs `git worktree add` on the host and opens the folder
   with the multiplexer's `createSpace`. No adapter has a worktree verb, and removal stays out of the
   phone. ADR 0126 stays live for why the multiplexer road was closed.
9. **A branch's folder is a parent the bridge checks at every use.** The default is
   `<dir>/<repo folder>/<branch slug>`, where `<dir>` is the machine's "Worktree folder" setting,
   else Herdr's `[worktrees] directory`, else `~/.herdr/worktrees`. "Other folder" names a parent
   under home, not in a dotdir, behind a link or in the repo, and the child must not exist. The rule
   runs at plan and again at create. Nothing fetches: the default branch is the one the repo last saw.
10. **A half-done create is opened, never made twice.** When git made the checkout and the open
    failed, the checkout stays. A retry that finds the same finished worktree only opens it, or reuses
    the space that shows it. A launcher is typed only into a fresh bare shell.
11. **Each machine starts its own, and the lead's rows are the crew's.** Launch and worktree routes
    go to the addressed host with the request id, so the receipt lives where the pane was made. The
    lead's merged rows are offered on every host and judged where they would run. A member takes a
    carried lead row only over the crew link with the lead's mark; its own row on that command wins.
    Adds, renames and removals are answered on the lead. One-off histories stay per machine.

## Today in the code

- Rule 1: `pickLaunch` (`bridge/server.ts`) counts the kinds, for `launch` and `createWorktreeAt`.
- Rule 2: `HARNESS_LAUNCHES`, `NOT_STARTED`, `FOUND_TTL_MS` (`bridge/harness-launch.ts`);
  `LOGIN_PATH_TIMEOUT_MS` and `POSIX_LOGIN_SHELLS` (`bridge/login-path.ts`).
- Rules 3 and 4: the header of `bridge/launcher-adds.ts`; `launchersRoute` (`bridge/server.ts`);
  `DEFAULT_SWITCHES` (`bridge/operator-launchers.ts`); `buildRecipe`, `cleanLauncherText`,
  `scanNoPrompts`, `MAX_COMMAND_CHARS` (`bridge/launcher-recipes.ts`); `MAX_ADDED` = 20
  (`bridge/launchers-added.ts`); `forgetDeviceRows`, `sweepRevokedRows` (`bridge/launcher-adds.ts`);
  `NO_PROMPTS_KEY` (`web/src/lib/no-prompts.ts`).
- Rule 5: `askedFolder` and `launch.folder_missing` in `launch` (`bridge/server.ts`).
- Rule 6: `ReceiptFileStore`, `MAX_RECEIPTS` = 200, files 0600 (`bridge/worktree-receipts.ts`). A
  launch, tab or space create writes a `pending` receipt first, and `expirePending` turns an old one
  `unknown` (`bridge/launch-receipts.ts`, `createRecorded` in `bridge/server.ts`, `LAUNCH_BUDGET_MS`).
  `earlierLaunch` is synchronous up to its `null`, so no await falls between the check and `track`.
  A worktree stores only a success (`WorktreeReceiptStore`). The phone: `web/src/lib/create-intent.ts`
  (30 s per action) and `newPage.unknown` (`web/src/lib/i18n/messages/en.ts`).
- Rule 7: `MAX_RECENT` = 12 (`bridge/recent-runs.ts`), `looksSecret` (`bridge/secret-line.ts`), the
  `workspace.run` audit line with word and length (`finishLaunch`), `serveLaunchCheckRoute` (a read),
  `launch.run_no_branch`.
- Rule 8: `addWorktree` with `--no-track` through the hardened `runGit` (`bridge/worktree-add.ts`,
  `core.hooksPath=/dev/null` in `bridge/changes.ts`); `worktreeDeclaration` lifts `createWorktree` only
  when the adapter opens a space and git is found (`bridge/worktree-capability.ts`); the `worktree`
  fact and `withRepoFacts` (`MUX_CONTRACT.md`, "A worktree space"; `bridge/repo-facts-mux.ts`).
- Rule 9: `resolveParentTarget`, `resolveSetFolderTarget`, `herdrDefaultTarget`
  (`bridge/worktree-folder.ts`); `gitAcceptsBranch` (`server.ts`: `isValidWorktreeBranch`,
  then `check-ref-format`); `resolveDefaultBranch` (`bridge/worktree-base.ts`).
- Rule 10: `worktreeMatchOf`, the per-folder `inFlight` map and the timeout cleanup
  (`bridge/worktree-add.ts`); `spaceShowing` (`bridge/worktree-reuse.ts`); `worktree.created_not_opened`.
  Budgets: `WORKTREE_ADD_TIMEOUT_MS` 60 s, `WORKTREE_ROUTE_BUDGET_S` 90 s, the phone's
  `WORKTREE_TIMEOUT_MS` 75 s, the lead's `WORKTREE_WRITE_BUDGET_MS` 85 s.
- Rule 11: `FORWARDABLE` (`bridge/crew/forward.ts`); `LEAD_ROW_HEADER`, `folderQuestion`
  (`bridge/crew/launcher-rows.ts`); `leadRowGate`, `launch.row_not_from_lead`, `ADDED_LAUNCHER_PATHS`
  (`bridge/server.ts`); the deputy's read-only copy (`bridge/crew/standby-launchers.ts`).

## Recorded, not found in the code

- ADR 0127: the phone "says the machine needs an update" on an older member's refusal; it shows the
  plain `launch.not_allowlisted` sentence. No constant holds its "about 1.5 s" for the deputy's copy.

## Consequences

- A lost reply costs a look, never a second pane, as long as the retry carries the same id.
- A host needs git for worktrees; zellij gets none, because it cannot open a space. A repo's
  `post-checkout` hook does not run during a create.
- A lead can make a member type a row's line and run git; a shell gave it that power already.

## What we tried before

- 0032, 0126: the multiplexer made the worktree; now git in the bridge does (0126 stays live).
- 0089, 0093: a second agent on a branch, its receipt, base and folder rule, once lead-local.
- 0091: start by id with a request id; a failed launch stored nothing, until M100 kept `unknown`.
- 0094, 0127, 0095: phone rows lived on each machine, now on the lead; one-off lines and their history.
- 0131: the "+" opens the rows; it stays live for the four roads it turned down.
