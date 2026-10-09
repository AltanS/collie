# 0093: A branch's folder is named by its parent, and checked on every use

- **Status:** Accepted
- **Date:** 2026-10-09
- **Shipped in:** pending (1.19.0)
- **Relates to:** [ADR 0089](./0089-a-second-agent-on-a-branch.md) (the worktree create, its
  receipts and its base), [ADR 0032](./0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md)
  (the multiplexer makes the worktree), [ADR 0083](./0083-the-files-view-reads-the-changes-root.md)
  (the other places a client value becomes a path).
- **Trail:** `bridge/worktree-folder.ts` · `bridge/worktree-choices.ts` · `bridge/worktree-branch.ts`
  · `bridge/server.ts` (`planWorktree`, `createWorktreeAt`, `runWorktreeCreate`) ·
  `bridge/mux/herdr/client.ts` (`createWorktree`) · `herdr worktree create --help` and
  `herdr api schema --json` on Herdr 0.9.3 · spec M48/01

## Context

> **Addendum 2026-10-09 (1.19.0).** The sheet is now the New page, `/new`, and the switch reads "New
> worktree". On a member or a multiplexer with no worktrees the switch stays on the page, off and
> disabled, with the reason beside it. The decision is unchanged.

The New sheet's "On a new branch" switch makes a Herdr worktree from the folder in its Where field.
Herdr 0.9.3 puts the checkout in `<dir>/<repo folder name>/<slug>`, where `<dir>` is `[worktrees]
directory` in Herdr's `config.toml` (a leading `~` expanded) or `~/.herdr/worktrees`, and the slug is
the branch in lower case with every other run of characters turned into one `-` (probed in an
isolated Herdr session: `feat/x-y` → `feat-x-y`, `Feat_A.b` → `feat-a-b`). It also accepts `path`
(`WorktreeCreateParams.path`, absolute only). Operators asked for the checkout beside their other
projects, not in a hidden folder.

A path from the phone is a client value that becomes a folder the bridge asks to be CREATED. The
law in `CLAUDE.md` allows a client value to become a path in three places only, each with a narrow
rule. This is a fourth, so it needs its own narrow rule.

## Decision

**The sheet offers two folder kinds. "Herdr's default" sends no path. "Other folder" names a PARENT,
and the bridge names the child after the branch. The bridge checks the parent with one rule, at
every use, and always shows the absolute target before Start.**

1. **Herdr's default sends nothing.** No `path` goes to Herdr, so Herdr decides. The sheet shows
   where that will be, worked out by the bridge from Herdr's rule above (`GET /api/worktree/plan`,
   `defaultTarget`). It is a prediction; the created pane's folder is the fact.
2. **Other folder names a parent, never the folder.** The parent comes from Recent, Favourites or
   the field. The child is Herdr's slug of the branch, so the folder name matches the default kind.
3. **The rule** (`resolveParentTarget`), in this order:
   - a string with no control character, at most 4096 characters; a leading `~` is home;
   - no `..` segment in the string AS SENT (refused, never resolved), and absolute after `~`;
   - it exists and is a directory, read through `realpath`;
   - under the real home folder (`worktree.folder_outside_home`);
   - no link below home: the path as written, with home's spelling swapped for its real one, must
     equal the real path (`worktree.folder_link`). Home itself may be a link (Fedora Atomic's
     `/home` → `/var/home`);
   - no segment below home starts with `.`, which keeps out every dotdir and every `.git`
     (`worktree.folder_hidden`);
   - not inside the repo it branches from (`worktree.folder_in_repo`);
   - the child must not exist, checked with `lstat`, so a dangling link counts
     (`worktree.target_exists`).
4. **The branch is checked as git checks it.** The static rule (`isValidWorktreeBranch`) now also
   refuses `@` alone, a leading `/`, a trailing `.`, and a component that starts with `.` or ends in
   `.lock`. Then `git check-ref-format --branch` runs on the bridge. A name never starts with `-`.
5. **At every use.** The plan route runs the rule to show the target. The create runs it again,
   immediately before Herdr is asked. Nothing is cached.
6. **Argv only.** Git runs hardened with an argv array (`askGit`); Herdr gets the path as a JSON
   value over its socket. No shell ever sees it.
7. **The repo comes from the folder.** The nearest `.git` at or above the Where folder, then
   `git rev-parse --git-common-dir`, so a folder inside a linked worktree branches from the main
   checkout, which is what Herdr calls the repo.
8. **Memory is per repo and per machine, on the bridge.** After a create that worked, the bridge
   writes the base kind (`default` or `current`), the folder kind and the last parent to
   `<stateDir>/worktree-choices.json` (0600, at most 100 repos, oldest dropped), keyed by the repo's
   real main folder. Never by a pane id. A refusal writes nothing. The default kind keeps the last
   parent, so switching back offers it again.
9. **Lead-local.** Like every worktree route, `POST /api/worktree` and `GET /api/worktree/plan` are
   not forwarded across the crew link. On a member, the sheet shows the switch as off, with the
   reason.

## Consequences

- A checkout can sit beside the operator's projects. It cannot sit in a dotdir, in the repo, outside
  home, behind a link, or on top of anything that exists.
- A parent that was fine in the plan and broke before Start (a link swapped in, a folder made) is
  refused by the create, with the same code.
- The state dir gains one file, written only by a branch create that worked.
- If Herdr changes its default folder rule, the shown default path is wrong until Collie follows;
  the create itself is not affected, because no path is sent.
