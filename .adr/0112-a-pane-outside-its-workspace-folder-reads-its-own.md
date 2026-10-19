# 0112 — A pane outside its workspace folder reads its own

- **Status:** Proposed
- **Date:** 2026-10-18
- **Amends:** [ADR 0065](./0065-the-changes-view-reads-git-read-only.md) §3 in scope — "every pane
  in one workspace shows the same list" now holds for the panes that sit inside the workspace
  folder. 0065 is not superseded; the workspace root, the bound and nested discovery stand.
- **Trail:** [issue #509](https://github.com/AltanS/collie/issues/509) (argued for the opposite
  road: resolve the root from the pane's own folder always) ·
  `bridge/changes-root.ts` (`rootForPane`) · `bridge/server.ts` (`paneWorkspaceRoot`,
  `paneChanges`, `paneFiles`, `filesSubjectRoot`) · `web/src/lib/file-paths.ts` (`paneFilesRoot`) ·
  `web/src/routes/changes.tsx` (the kept workspace count)

## Context

ADR 0065 made the Changes root the pane's WORKSPACE folder, so a pane parked in a subfolder shows
the whole workspace, not a partial picture. Issue #509 is the same rule one step further out: in a
workspace rooted at a git repo, a new tab that `cd`s to a scratch folder outside the repo and
starts an agent there shows that repo's Files and its 157 changes under the scratch pane's header.
The pane is not in a subfolder of the work; it is not in the work at all, and the list under its
name is another pane's.

Two roads were argued. The issue's: root every pane route at the asking pane's own folder. That
reverses 0065 for the common case — a pane deep in `experiments/session-stream` goes back to
showing that subfolder's repo alone, the partial picture 0065 was written to end. The status quo:
the workspace folder always wins, which is what mislabels the scratch pane.

One fact bounds the shape: a root picked as the common ancestor of the workspace's pane cwds
contains every one of those cwds by construction, so only a root that came from the mux's own
workspace folder (herdr's worktree checkout, tmux's `session_path`) can leave a pane outside it.
And the pane's folder needs no new plumbing: the bridge already resolves the root off the live
snapshot on every read, and on herdr the snapshot's `cwd` is the foreground folder (probed
2026-10-18: `cwd` and `foreground_cwd` agreed on all 11 live panes, the #509 scratch pane
included).

## Decision

**The workspace root applies to a pane only when the pane's own folder sits inside it**
(`rootForPane` in `bridge/changes-root.ts`). A pane outside it reads its own cwd instead, through
the fallbacks the pane routes already had for a workspace with no root: Files bounded, so a pane
parked in `~` or `/` lists nothing; Changes bounded too when a root was discarded this way, so
such a pane answers `no-folder` rather than scanning home — the pre-0065 unbounded fallback
stands only where there was never a workspace root. A folder that holds no repo answers as it
always has, an empty list under its own root; no new reason is invented for it.

The workspace routes are untouched: asked by workspace, with no asking pane, they read the
workspace folder. A cwd that names no absolute folder (a mux that reports none) cannot be shown
to be outside anything, so it keeps the workspace root. Spellings of one folder that differ by a
symlink (`/tmp` vs `/private/tmp`) are re-checked against the disk before a root is discarded, in
`bridge/server.ts`; the pure rule stays string-only and tested without a disk. The web mirror of
the rule (`paneFilesRoot`) follows the same order, so a printed path is linked against the root
the bridge will actually use, and the Changes screen's kept per-workspace count is neither seeded
from nor overwritten by an outside pane's list.

## Consequences

Two panes in one workspace can now show different lists — but only when their folders genuinely
differ, which is the fact the phone should print. Panes inside the workspace folder, subfolder
panes included, are unchanged, and the `paneRepo` mark still names the asking pane's repo in the
shared list. What would justify revisiting: a mux whose reported cwd lags the foreground process
(a pane that `cd`s after launch and is read before the snapshot catches up would keep the root
its old folder earns) — that is a snapshot-freshness problem, and it would be fixed there, not by
weakening this rule.
