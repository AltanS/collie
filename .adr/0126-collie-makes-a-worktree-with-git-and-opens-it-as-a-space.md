# 0126: Collie makes a worktree with git and opens it as a space

- **Status:** Accepted
- **Date:** 2026-11-02
- **Shipped in:** pending
- **Supersedes:** [ADR 0032](./0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md) (a
  worktree is opened by the multiplexer, not by Git).
- **Relates to:** [ADR 0089](./0089-a-second-agent-on-a-branch.md) (receipts, base, the 60 s
  budget and the launcher, all unchanged), [ADR 0093](./0093-a-branch-folder-is-named-by-its-parent.md)
  (the folder rule, the path and the plan, unchanged),
  [ADR 0022](./0022-the-mux-seam-is-a-port-collie-owns.md) (the port the three verbs leave).
- **Trail:** ADR 0032, which names this road as "the cheap route" and rejects it · the New page on
  the Herdr core (`bluefin-hc`), 2026-11-02: the "New worktree" switch stayed off because no
  adapter but the Herdr TUI's declares `createWorktree` · `bridge/worktree-folder.ts`
  (`herdrDefaultTarget`) · `bridge/server.ts` (`planWorktree`, `createWorktreeAt`,
  `runWorktreeCreate`) · `bridge/mux/types.ts` and `bridge/mux/capabilities.ts` (the three verbs) ·
  `bridge/mux/herdr/adapter.ts` and `bridge/mux/herdr/client.ts` (`worktree.list|create|open`) ·
  `bridge/changes.ts` (`gitBinary`) · [`HC_API.md`](../HC_API.md) · milestone M81

## Context

ADR 0032 put the worktree in the multiplexer. Collie asked the Herdr daemon to run
`git worktree add` and open the checkout as a workspace, through three port verbs:
`listWorktrees`, `createWorktree` and `openWorktree`. It named the obvious other road, git in the
bridge and then `createSpace`, and rejected it for three reasons:

1. **The record.** Herdr kept `open_workspace_id`, `repo_root` and `checkout_path` for each checkout.
   A checkout made behind Herdr's back would have none of it.
2. **Removal.** Herdr's `worktree.remove` is addressed by workspace, so a checkout made outside
   Herdr could never be removed through the socket.
3. **Placement.** Herdr has a folder for its checkouts, and a Collie that picked its own would
   scatter them.

Its revisit trigger was "a second multiplexer growing real worktree bookkeeping, or Collie deciding
what it means to destroy a space".

The trigger is met, from the other side. The Herdr core (M74, `herdr-core`) is the second Herdr
multiplexer, and it has no worktree verb. It never will: the core keeps terminals, and spaces and
tabs belong to herdr-app's layout document ([`HC_API.md`](../HC_API.md)). It does open a space
(`createSpace`, a terminal with fresh `herdr.space` and `herdr.tab` labels). On 2026-11-02 the New
page on `bluefin-hc` could start an agent in a folder but not in a new worktree, because only the
Herdr TUI's adapter declared `createWorktree`. pi, Oh My Pi and Codex have no worktree feature of
their own, and a worktree a harness makes is one Collie cannot see.

Most of the feature already lives in the bridge. The branch check, the base, the folder rule, the
receipts, the choices memory and the launcher are Collie's (ADR 0089, ADR 0093). Only
`git worktree add` and the open were handed to the daemon.

The record was never only Herdr's either. Since Herdr 0.9.3 the workspace row carries no worktree
block, and the adapter asks `worktree.list` once per workspace to learn the repo (0032's addendum of
2026-10-07). Herdr's `worktree.list` answers for a repo nothing has open, which is git's answer, not
a record Herdr made at creation time.

## Decision

**A worktree is Collie's. The bridge runs `git worktree add` on the host and opens the checkout with
the multiplexer's `createSpace`. No adapter has a worktree verb.**

1. **Git in the bridge.** The repo comes from the folder, as ADR 0093 point 7 says. The bridge runs
   `git -C <repo> worktree add -b <branch> <path> [<base>]` with an argv array, through the hardened
   git runner, never a shell. Then it calls `createSpace({ cwd: <path>, label })`. `createSpace`
   never moves the operator's own screen, so the old rule "`focus` is never sent" holds.
2. **The verbs leave the port.** `listWorktrees`, `createWorktree` and `openWorktree` leave the
   `MuxAdapter` port, and their request and result types go with them. `listWorktrees` and
   `openWorktree` leave `MUX_CAPABILITIES`. The conformance set drops the three probes and its test
   repo.
3. **`createWorktree` stays a capability name.** The phone, the peer hello and the New page still
   read it. An adapter never declares it. The bridge lifts it, in a wrapper beside the beacon
   decorator, when the adapter supports `createSpace` and a git binary is found (`gitBinary()`). An
   adapter that declares it itself is refused, the way the beacon decorator refuses
   `agentSessionRef`.
4. **A half-done create is opened, never made twice.** When git made the checkout and `createSpace`
   refused, the answer says so and the checkout stays. A retry finds the path in
   `git worktree list --porcelain` of the repo and only opens it. This replaces `openWorktree` as
   the recovery ADR 0032 described.
5. **The default folder keeps Herdr's convention**: `<dir>/<repo folder name>/<branch slug>`, where
   `<dir>` is `[worktrees] directory` in `~/.config/herdr/config.toml`, else `~/.herdr/worktrees`.
   `herdrDefaultTarget` already predicts it for the plan. The "Other folder" kind of ADR 0093 is
   unchanged.
6. **The worktree routes go to the addressed host.** Git runs where the checkout lives, so
   `GET /api/worktree/plan` and `POST /api/worktree` are forwarded across the crew link like the
   launch, with the request id intact. This narrows ADR 0093 point 9 (lead-local); every other
   point there stands.
7. **Removal stays out.** Collie still has no `closeSpace`, and this decision gives it none.

## What each objection of ADR 0032 becomes

- **The record is git's own.** `git worktree list --porcelain` in the main checkout lists every
  linked checkout. A linked checkout's `.git` file names its repo (`gitdir: <repo>/.git/worktrees/<name>`).
  The bridge reads `repoRoot` and `isWorktree` for every space from disk, on every multiplexer, and
  needs no daemon record. A space shows a checkout when its folder is that checkout. 0032 said the
  record "cannot be reconstructed afterwards"; it can, because git keeps it.
- **Removal is still not decided, and still not possible from the phone.** The argument 0032 left
  open (what it means to destroy a space) is the same one, and it stays open. When it is settled,
  `git worktree remove <path>` is addressed by path and works whoever made the checkout.
- **Placement is Herdr's.** The bridge puts the default checkout where Herdr puts its own. Checkouts
  made before this decision keep their folders and keep listing, and the plan's `defaultTarget` is
  right on both Herdr multiplexers.

## Consequences

- **Every multiplexer that opens a space gets worktrees**: the Herdr TUI, the Herdr core, tmux,
  tuios and tern. The Herdr TUI keeps the same flow and the same default folder. tmux's old reason
  for declining (no record of which session shows a checkout) is gone with the record.
- **zellij stays without worktrees.** It cannot open a space: one collie drives one zellij session.
- **A host needs git.** With no git binary the bridge does not lift `createWorktree`, and the New
  page shows the switch off, with the reason.
- **One bridge module holds the worktree code**, with tests on a real git repository. The Herdr
  daemon's worktree calls, its fixtures and six `unsupported` stubs go.
- **The New page reads the capability of the machine it starts on.** A crew member that opens a
  space and has git makes its own worktree on its own disk.
- **If Herdr changes its default folder, the default path follows only when Collie does.** Before,
  Herdr chose the folder at create time and only the shown prediction could be wrong. Now Collie
  makes the checkout there, so the two can drift. Old checkouts still list, because the record is
  git's.
- **What would justify revisiting this.** A multiplexer whose space cannot be opened at a folder,
  or a harness that owns its worktrees in a way Collie can read. Removal is its own argument, as it
  was in 0032.
