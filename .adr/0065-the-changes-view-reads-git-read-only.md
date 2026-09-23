# 0065 — The Changes view reads git, read-only

- **Status:** Accepted
- **Date:** 2026-09-23
- **Shipped in:** pending
- **Trail:** GitHub discussion 258 and issues 256 / 257 (@lighcen: "show me what the agent changed")
  · `bridge/changes.ts` · `bridge/server.ts` (`PANE_ROUTE`, `paneChanges`) ·
  `bridge/crew/forward.ts` · `bridge/journal/files.ts` (header) · `web/src/routes/changes.tsx` ·
  `web/src/components/changes-view.tsx` · `web/src/lib/unified-diff.ts` ·
  `web/src/hooks/use-dash-prefs.ts` · [ADR 0060](./0060-an-attachment-is-a-chip-not-a-path.md)

## Context

The operator watches an agent work from the phone and cannot see what it did to the files. The
request (discussion 258, with issues 256 and 257 folded in) asked for a diff view; the roads people
propose next are an editor, staging and committing from the phone, and a full diff library with
syntax highlighting. Three facts shaped the answer.

- **A pane already carries its folder.** `AgentView.cwd` is on the snapshot, so the bridge can find
  the repo without the client naming a path. zellij reports no folder (`cwd` is `""`), so the view
  cannot exist for its panes.
- **The workspace shape matters.** Altan's own workspace is a git repo that keeps its member repos
  gitignored inside it. `git status` in the workspace does not see them, so a view that asks only
  the containing repo shows almost nothing.
- **`git status` on a hostile checkout runs code.** A repo's config and `.gitattributes` can name an
  fsmonitor hook, an external diff, a textconv program and clean/smudge filters. An agent may have
  cloned anything, and the operator only tapped "Changes".

Weights of the libraries considered, as reported in the design round: `@pierre/diffs` about 180 KB
gzipped (it brings Shiki), `react-diff-view` about 23 KB. Measured for what shipped: the parser
(`lib/unified-diff.ts`) is 0.4 KB gzipped, and the whole view (parser, list, diff rows, route and
settings card) is about 4 KB.

## Decision

**The Changes view reads git and nothing else, against HEAD, and it never writes.**

1. **Read-only.** No staging, no commit, no edit, no checkout. Every git run carries
   `GIT_OPTIONAL_LOCKS=0`, so not even the index's stat cache is written.
2. **HEAD is the base.** Staged and unstaged changes show together: `git status --porcelain=v2`
   for the list, `git diff <base> --numstat` for the counts, `git diff <base> -- <path>` for one
   file. A repo with no commits diffs against the empty tree. An untracked file is read by the
   bridge and sent as an all-added diff.
3. **Discovery finds nested repos, bounded by two per-device settings.** The repo that contains the
   pane's folder is found by walking up to the nearest `.git`. With "Look for repos inside this
   folder" on (the default), the bridge also walks the folder's subtree down to "How deep to look"
   (1 to 4, default 2) for folders holding a `.git` entry. The walk does not ask git, so a repo the
   parent ignores is found. It never follows a symlink, never enters a dot-folder or
   `node_modules`, `dist`, `build`, `vendor`, `target`, and stops at 20 repos or 5000 entries. A
   submodule or untracked nested repo that discovery finds is shown once, as its own repo, and its
   entry in the parent's list is dropped.
4. **Hardened git.** argv only, no shell, a 5 s timeout and an output cap per run. Each run
   neutralises the repo-driven ways to execute: `core.fsmonitor=false`, `core.hooksPath=/dev/null`,
   `diff.external=` with `--no-ext-diff`, `--no-textconv`, every configured filter driver's
   clean/smudge/process set empty and `required=false` (the names are read first with
   `git config --get-regexp`, which runs nothing), `core.pager=cat`, `color.ui=false`,
   `status.submoduleSummary=false` and `--ignore-submodules=dirty` (status never recurses into a
   submodule under that repo's config). `--git-dir` and `--work-tree` are explicit, so a repo's
   `core.worktree` cannot move the scan; `--literal-pathspecs`, so a file name is never a pattern.
   Every inherited `GIT_*` variable is dropped, then `GIT_TERMINAL_PROMPT=0`,
   `GIT_OPTIONAL_LOCKS=0` and `GIT_CONFIG_NOSYSTEM=1` are set. **No run touches the network.** In
   a partial clone a missing blob makes git lazy-fetch from the promisor remote, and the repo's own
   config picks that remote's transport. So every run also sets `GIT_NO_LAZY_FETCH=1`,
   `GIT_ALLOW_PROTOCOL=` (empty, so every transport is refused, and unlike `protocol.allow` it
   outranks a repo's `protocol.<name>.allow=always`) and `GIT_PROTOCOL_FROM_USER=0`, and carries
   `protocol.allow=never`, `protocol.ext.allow=never`, `credential.helper=` (empty resets the
   helper list), `core.sshCommand=`, `core.askPass=`, `fetch.recurseSubmodules=false` and
   `submodule.recurse=false`. A missing blob then fails that one run: the file stays listed with
   zero counts and an empty diff. Left alone as harmless:
   `core.untrackedCache`, `include.path` (a `-c` outranks what it includes), trace2 (read from
   system and global config only). The operator's global config is trusted, like their shell.
5. **The listed-paths rule.** A diff is served only for a `repo` that the same discovery (same
   depth, same nested flag) returns, and only for a `path` git itself listed as changed in that
   repo. Anything else is `unknown-repo` or `unknown-path` before a path exists. An untracked read
   also passes `containedRealpath` (`bridge/journal/files.ts`) against the repo's real path, so a
   listed symlink out of the repo is refused; one that stays inside shows its link text, as git
   does.
6. **This is the second place a client-supplied value becomes a path**, after the journal, and the
   listed-paths rule is its bound. `files.ts`'s header and `CLAUDE.md` say so.
7. **No diff library and no highlighting.** The bridge sends git's raw unified text; a 60-line
   parser in the web app reads hunks and line kinds, and the view draws plain monospace rows with
   two line-number gutters, tinted add and delete rows, and lines that wrap.
8. **Not on the poll loop.** The list is read on open and on the refresh button. The route is a
   read like `history`, forwarded to the member that owns the pane with `?host=`, additive-optional
   on the crew link.

## Consequences

- **Git LFS files may read as modified.** With the clean filter off, a tracked LFS file whose stat
  changed is compared against its pointer. That is the price of rule 4, and it is only wrong in the
  direction of showing too much.
- **A submodule outside the depth shows as one gitlink entry** in its parent, with a
  "Subproject commit" diff, rather than its own files.
- **zellij panes have no Changes row.** The web app hides it when `cwd` is blank, and the route
  answers `no-folder` if reached by URL.
- **Untracked folders are one entry.** `--untracked-files=normal` keeps a new `node_modules` from
  listing a hundred thousand files; the view says the folder is new and does not list inside it.
- **Counsel, 2026-09-23.** Fixed here: the lazy fetch in a partial clone, and with it every
  repo-chosen transport, credential helper and `core.sshCommand` (rule 4, and the partial-clone case
  in the hostile-repo test). Declined, with the reason:
  - Rejecting `.git` pointer files. Git worktrees and submodules use them, and Herdr opens worktrees
    ([ADR 0032](./0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md)). A pointer that leads elsewhere only
    mislabels the list; it grants nothing the agent in that folder could not already read.
  - The race between checking an untracked file and reading it. The only party able to win it is
    the agent running as the same user, and that agent can already read any file the bridge can.
  - `safe.directory` stays at git's default. A repo owned by another user then fails with an error
    rather than being trusted wholesale.

  Already so, and confirmed: the list's truncation flag, per-repo status run in parallel with a
  limit, rename-aware `-M` on both numstat and diff with both paths named, and a diff cut on a line
  boundary.
- **Revisit** if a real repo needs highlighting to be readable on a phone (measure the cost against
  the numbers above first), or if rule 4 misses a vector: a new git config key that executes during
  status or diff belongs in `bridge/changes.ts`'s `HARDENING` list and in its hostile-repo test.
- **Later, on the same rails:** a Files view (browse the tree, read-only, the same listed-paths
  shape) and review comments on a diff line that attach to the composer as a chip, reusing the
  attachment chip of ADR 0060.
