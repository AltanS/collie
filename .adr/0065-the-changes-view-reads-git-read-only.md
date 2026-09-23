# 0065 — The Changes view reads git, read-only

- **Status:** Accepted
- **Date:** 2026-09-23
- **Shipped in:** pending
- **Trail:** GitHub discussion 258 and issues 256 / 257 (@lighcen: "show me what the agent changed")
  · `bridge/changes.ts` · `bridge/server.ts` (`PANE_ROUTE`, `paneChanges`) ·
  `bridge/changes-root.ts` (`workspaceRoot`) · `WORKSPACE_CHANGES_ROUTE`, `workspaceChanges` ·
  `bridge/crew/forward.ts` · `bridge/journal/files.ts` (header) · `web/src/routes/changes.tsx` ·
  `web/src/components/changes-view.tsx` · `web/src/lib/unified-diff.ts` ·
  `web/src/lib/diff-highlight.ts` · `web/src/lib/diff-highlight-engine.ts` ·
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
3. **The root is the pane's WORKSPACE folder, not the pane's own.** The workspace is the mux's
   container the pane belongs to: a herdr workspace, a tmux session, a zellij session. Every pane in
   one workspace shows the same list. `bridge/changes-root.ts` (`workspaceRoot`, pure and tested)
   picks the root in this order:
   - the mux's own folder for the workspace, when it keeps one and it is within the bound: herdr's
     `worktree.checkout_path` (its workspace record carries no cwd of its own, probed on herdr
     0.9.0), tmux's `session_path`. zellij keeps none;
   - else the deepest common ancestor of every pane's cwd in the workspace, blank cwds ignored;
   - **never `/`, the home folder itself, or a folder above home.** Past that bound the pane route
     falls back to the asking pane's own cwd (today's behaviour), and the workspace route answers
     `no-folder`. A mux folder past the bound (a tmux session started in `~`) falls through to the
     common ancestor rather than ending the search.

   The workspace can also be asked directly: `GET /api/workspace/<id>/changes` takes the same query
   and answers the same shape, `?repo=&path=` included. Both answers carry `root`, `workspaceId` and
   `workspaceLabel`, and the header prints the label and the root's last two segments.

   **Discovery then finds nested repos below the root, bounded by two per-device settings.** The
   repo that contains the root is found by walking up to the nearest `.git`. With "Look for repos
   inside this folder" on (the default), the bridge also walks the root's subtree down to "How deep to look"
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
7. **No diff library; syntax colour by sugar-high, loaded lazily.** The bridge sends git's raw
   unified text; a 60-line parser in the web app reads hunks and line kinds, and the view draws
   monospace rows with two line-number gutters, tinted add and delete rows, and lines that wrap.
   Colour comes from [sugar-high](https://github.com/huozhi/sugar-high) 2.4.1 (MIT), pinned
   exactly. It is the lightest highlighter that covers the language list (TypeScript and
   JavaScript, JSON, CSS, HTML, Markdown, Python, Go, Rust, shell, YAML, TOML, and 14 more), against
   Prism at about 18 KB, highlight.js at about 27 KB and Shiki's fine-grained build at 54 KB base,
   all gzipped. The rules around it:
   - **Nothing of it is in the main bundle.** `lib/diff-highlight.ts` maps a path to a language and
     holds one dynamic import; the engine (`lib/diff-highlight-engine.ts`, with sugar-high's core)
     and each language module are their own chunks, fetched when a diff of that language opens.
     Measured on the build, gzipped: the main chunk grows 0.95 KB (the map, the hook and the
     spans), the CSS 0.16 KB. A TypeScript diff then fetches 5.6 KB (engine 1.36, core 0.86,
     shared 0.43, the JavaScript scanner 2.84, the TypeScript preset 0.12); a Python diff 2.9 KB.
     All 32 chunks together are 15.0 KB.
   - **A hunk is coloured as its two files.** The old side (context and deleted lines) and the new
     side (context and added lines) are each highlighted as one text, so a block comment or a
     template string that spans rows is read whole; a deleted row takes old-side tokens, an added
     row new-side tokens, a context row the side of the nearest changed row above it.
   - **Colour never moves a glyph.** Tokens are React spans around text nodes, never markup, and the
     six `--syntax-*` inks in `index.css` set colour only, no weight and no italic, each at 4.5:1
     or better on the page and on both row tints in both themes. A row whose tokens do not spell its
     text exactly stays plain. The plain rows draw first; colour follows with no layout shift, and
     `e2e/changes.spec.ts` measures every row's height before and after.
   - **A diff over 2000 lines, or of a file with no known language, stays plain**, with no notice.
8. **Not on the poll loop.** The list is read on open and on the refresh button. Both routes are
   reads like `history`, forwarded with `?host=` to the member that owns the pane or the workspace,
   additive-optional on the crew link.

## Consequences

- **Workspace root, 2026-09-23 (operator decision).** The first cut used the pane's own folder. A
  pane sitting in a subfolder (`collie-workspace/experiments/session-stream`) then showed only that
  subfolder's repo, a partial and misleading picture, while the operator thinks in workspaces
  (`collie-workspace`, `klaracase`, `openplate-workspace`). Rule 3 now reads the workspace, and the
  workspace route is shaped so a dashboard entry per workspace can ask for it without a pane. The
  cost: a workspace whose panes spread across unrelated folders under home reads its asking pane's
  folder, as before, rather than a merged view.

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
- **Highlighting, 2026-09-23.** Rule 7 first said "no highlighting". The operator asked for it once
  the view was in use, and it went in as rule 7 now reads: one small library, lazily loaded, and
  held to the view's no-shift and text-node rules.
- **Revisit** if a language the operator reads daily is missing from sugar-high, or a real diff
  shows a wrong colour worse than no colour; or if rule 4 misses a vector: a new git config key that executes during
  status or diff belongs in `bridge/changes.ts`'s `HARDENING` list and in its hostile-repo test.
- **Later, on the same rails:** a Files view (browse the tree, read-only, the same listed-paths
  shape) and review comments on a diff line that attach to the composer as a chip, reusing the
  attachment chip of ADR 0060.
