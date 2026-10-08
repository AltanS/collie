# 0089: A second agent on a branch

- **Status:** Accepted
- **Date:** 2026-10-07
- **Shipped in:** 1.18.0
- **Relates to:** [ADR 0032](./0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md) (the
  multiplexer opens a worktree; a half-done create is opened, never created again),
  [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the crew link carries no
  Herdr vocabulary).
- **Trail:** `bridge/worktree-receipts.ts` · `bridge/worktree-branch.ts` · `bridge/server.ts`
  (`createWorktree`, `typeIntoFreshShell`, `WORKTREE_ROUTE_BUDGET_S`) ·
  `bridge/mux/herdr/client.ts` (`WORKTREE_TIMEOUT_MS`) · `web/src/lib/branch-off.ts` ·
  `web/src/lib/worktree-name.ts` · `web/src/components/new-space-sheet.tsx` · `herdr api schema
  --json` on Herdr 0.9.3, protocol 22

## Context

An operator watching one agent on the phone wants a second one on the same repo, on its own branch,
so the two do not edit the same files. Collie could already create a worktree from the dashboard,
but the create was a bare shell, and starting an agent in it took a second trip to the launcher.

Three things made the plain route unsafe to call from a pane's menu:

- **A create is slow.** Herdr runs `git worktree add` and opens a workspace before it answers. The
  Herdr client gave every call 5 s, and Bun closes a request that has been idle for 10 s (probed on
  Bun 1.4.1: a 12 s handler got a dropped connection unless the route called `server.timeout`).
  So a create on a large repo finished on the host while the phone was told it failed.
- **A retry is a second create.** The operator taps again after a lost reply. Without a way to tell
  the second tap from a new intent, that is a second worktree, or a refusal because the path is
  taken, while the first one sits there unseen.
- **The phone must not name a command line.** Typing an agent into the new shell is a launch, and
  `POST /api/launch` already decided that the client names a `launchers.toml` row and the bridge
  supplies the line.

Herdr 0.9.3 also accepts `trust_repository` on `worktree.create`. Its help text says it grants
per-request Git trust (`safe.directory`) and is "not a routine retry for a failed worktree
command". The schema lists no refusal code for an untrusted repo; Git's own sentence arrives inside
`worktree_create_failed` or `not_git_worktree`, which Collie already passes through.

## Decision

**A pane's ⋯ menu offers "New agent on a branch". It opens the new-space sheet in worktree mode, on
the pane's repo, with a fresh branch name and an agent picker. The create carries a request id and,
optionally, a launcher row.**

1. **One receipt per request id.** The phone mints a UUID per sheet opening and sends it as
   `requestId`. The bridge stores the outcome of every create that succeeded in
   `<stateDir>/worktree-receipts.json` (0600, at most 200, oldest dropped). A POST with a known id
   answers from the receipt with `replayed: true` and runs nothing; a POST whose id is still in
   flight waits for the first one's answer. A refusal stores nothing. The phone keeps the id across a
   failed or lost create and mints a new one per opening. A body with no id is a fresh request, which
   is what the dashboard's sheet still sends.
2. **The launcher is a row, matched exactly.** `launcher` must equal the `command` of a
   `launchers.toml` row, the allowlist `/api/launch` uses; anything else is a 400 before the
   multiplexer is touched. After the create the bridge types it into the new root pane with the same
   wait-then-type step `/api/launch` uses (`typeIntoFreshShell`).
3. **A launcher failure is not a create failure.** The worktree exists, so the answer is 200 with the
   pane, `launcherStarted: false` and `launcherError`. Nothing is rolled back and nothing is removed:
   the recovery is to open what was made, never to create it again (ADR 0032).
4. **The branch is checked first.** Empty, a leading `-`, whitespace, control characters, `..`,
   `@{`, `\`, `~`, `^`, `:`, `?`, `*`, `[`, a trailing `/` or `.lock`, and `//` are a 400
   (`worktree.invalid_branch`). The phone mints `worktree/<adjective>-<noun>-<4 hex>`, which passes.
5. **The budget is a minute.** The Herdr client takes a per-call timeout, and `worktree.create` and
   `worktree.open` get 60 s. The route holds its connection for 90 s, and the phone waits 75 s, so
   the bridge always answers first and a phone that gave up retries into the receipt.
6. **Lead-local.** The menu row shows only on the lead's scope and only when the multiplexer declares
   `createWorktree`. The crew does not forward the route; a member's pane does not offer it.
7. **No `trust_repository`.** The operator trusts a repository in Herdr, on the machine. The phone
   never sends the flag, and Git's refusal for an untrusted repo reaches the phone as Herdr's words.

## Consequences

- A second tap after a lost reply lands on the worktree the first tap made. Two creates for one
  intent can only happen across a bridge restart that lost the receipt file, or across two sheet
  openings, which are two intents.
- The state dir gains one file, written only by a create that carries an id.
- A launcher that names a row the operator later removed replays fine (the receipt is checked
  first) but a fresh create with it is refused, as `/api/launch` would refuse it.
- Removing a worktree stays out of the phone. Revisit only with a design for what a removal does to
  an agent still running in it.

## Amendment — 2026-10-08: the operator chooses where the branch starts

Status: **Accepted** (2026-10-08). Shipped in: pending. Adds one request field and one state file.
Everything above stands.

### What changed

Herdr cuts a new worktree's branch from `base`, or from the HEAD of the folder it was asked from
(`WorktreeCreateParams.base` in `herdr api schema --json`, Herdr 0.9.3, protocol 22; the socket docs
say a missing branch is created "from the requested base or `HEAD`"). That HEAD is whatever the repo's
own checkout is on. The create body now takes an optional `base`:

- `{ "kind": "default" }` is the repo's default branch, resolved on the bridge: the local branch
  named by `refs/remotes/origin/HEAD`, else a local `main`, else a local `master`, else nothing (no
  `base` is sent and Herdr starts from its own HEAD).
- `{ "kind": "ref", "ref": "<name>" }` is a named ref. The ref is checked as strictly as the branch
  name is (no leading `-`, no whitespace or control character, no `..`, `@{`, trailing `.lock`, at
  most 200 characters), then by Git itself (`check-ref-format`, and `rev-parse --verify` that it
  names a commit). Anything else is a 400, `worktree.invalid_base`, before the multiplexer is touched.
- No `base` is today's create, to the byte: nothing is passed to Herdr and no `git` runs.

Git is only ever started with an argv array and the hardening `bridge/changes.ts` gives every run
(no `GIT_*` from the environment, no transport). **Nothing fetches**, so the default is the one the
repo last saw, not the remote's latest. The resolved ref goes to Herdr as `base`.

### The sheet

"Start from" is a two-segment control in the new-space sheet: the default branch by name, and
"This branch" for the pane's own. It shows only when the sheet was opened from a pane on a named
branch that differs from the default, and only for that pane's repo; otherwise there is nothing to
choose and the create sends `{ "kind": "default" }`. From a pane it opens on "This branch". The
dashboard's Worktree tab has no pane, so it always starts from the default branch. On "This branch" a
line says that changes not yet committed stay behind: the new worktree starts from the last commit.
The default branch's name comes from the `defaultBranch` field `GET /api/workspace/:id/worktrees`
now carries (`null` when none can be named), so the label and the create share one resolver.

### What is stored

`<stateDir>/worktree-bases.json` (0600, `{ version: 1, bases: { "<checkout folder>": { base,
createdAt } } }`, at most 500, oldest dropped) is written after Herdr reports success, and only when
a ref was sent. Nothing reads it yet: a later "vs base" view in Changes will. It holds no branch
name, request id or launcher.

### Consequences

- A tap on "main" while the main checkout sits on another branch now starts from `main`, where it
  used to start from that other branch.
- A repo whose default cannot be named (no `origin/HEAD`, no local `main` or `master`) still starts
  from Herdr's HEAD, and the sheet shows no control for it.
- A retry that changes the starting point is a new request and gets a new id, like a changed branch.
- Trail: `bridge/worktree-base.ts` · `bridge/worktree-bases.ts` · `web/src/lib/branch-off.ts`
  (`startFromChoices`, `startFromBase`).
