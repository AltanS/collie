# 0150: Files and Changes read under a root the bridge picks, never one the client names

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0065, ADR 0083, ADR 0090, ADR 0112
- **Trail:** discussion 258 with issues 256 and 257 (a diff view; the roads named next: an editor,
  staging and committing from the phone, a full diff library), the counsel of 2026-09-23 on ADR 0065
  (declined: refusing `.git` pointer files, a looser `safe.directory`), issue #509 (root every pane at
  its own folder), the herdr-web-ui file viewer (2026-10-07: any absolute path or `file:///` URI; ADR
  0088). Files: `bridge/changes.ts`, `changes-root.ts`, `read-guard.ts`, `files-view.ts`, `server.ts`

## Context

The Files screen shows what changed under a workspace's folder, reads any file under it, and opens a
path the agent printed. Five records shaped it. Two reads turn a client's value into a file read; the
law in `bridge/journal/files.ts` names Changes and Files among the few such places, each with a bound.

## Decision

1. **Read-only, and no revision from the client.** Nothing stages, commits, edits or writes. Changes
   diffs staged and unstaged work against HEAD; the commit view diffs HEAD against its first parent
   (the empty tree when there is none). A request names a repo, never a revision.
2. **The root is looked up, never sent.** A workspace's root is the multiplexer's folder for it
   (Herdr's worktree checkout, tmux's `session_path`), else the deepest common folder of its panes'
   cwds, each only within the bound: never a filesystem root, home, or a folder above home. A pane
   route uses that root only when the pane's cwd lies inside it (by string, then by real paths), else
   the pane's own cwd, bounded. Only a pane in a workspace with no root at all reads a cwd past the
   bound, and only for a caller with the Files right. A workspace route has no fallback: `no-folder`.
3. **Both views bound the root's real path**: a link to `/`, home or above it is `no-folder` (one
   guard, `bridge/read-guard.ts`). Rule 2's unbounded cwd is the one root that skips it.
4. **Changes serves only what git listed.** The repos are the one holding the root (walk up to the
   nearest `.git`) and, when nested discovery is on, each folder below with a `.git` entry, to depth
   1 to 4 (default 2); the walk asks no git and follows no symlink. Without the Files right the walk
   up stops at the bound, and the work tree that owns a repo's git folder (through a gitfile or a
   `commondir`) must lie in it. Git runs on the git folder discovery checked. A diff needs a repo the
   same discovery returns and a path git listed (in the work tree, or in HEAD for the commit view),
   else `unknown-repo` or `unknown-path`. An untracked file is read as Files reads one, under the repo.
5. **Git runs hardened and offline.** argv only, a timeout and an output cap. Each run switches off
   every repo-driven program (fsmonitor, hooks, external diff, textconv, filter drivers, pager,
   submodule recursion), names `--git-dir` and `--work-tree`, takes paths literally, drops inherited
   `GIT_*` variables and refuses every transport. The operator's global config is trusted.
6. **Files takes one relative path, refused on its shape first.** Absolute, a `.`, `..` or empty
   segment, NUL, a backslash, a `.git` segment, over 4096 bytes; on Windows also a colon, a wildcard,
   a trailing dot or space, a device name and an 8.3 short name. The value is decoded once.
7. **Containment runs on real paths, and again on the opened file.** The target's real path must lie
   inside the root's. The open follows no final link, does not block, and takes only a regular file.
   Before a byte is read, Linux checks the kernel's name for the handle against the root and the deny
   rules; elsewhere the path is resolved again and must be the handle's own device and inode.
8. **Some things are never shown, in either view, to any caller.** A `.git` segment, anything in this
   bridge's state or config folder, and a file whose basename is a state secret's. All are checked on the
   real path, case-folded on every host. Files checks the request too and hides them from listings.
   Changes leaves them out of each list, diff, repo and rename count. A sibling's config `.env` and other
   credential files under a root are not on the deny list; in Files the device gate guards them.
9. **One refusal.** Absent, outside, denied and the wrong kind all answer `404 unknown-path`, and
   the existence check calls them absent.
10. **Text as JSON, a picture by its own read.** A listing holds 2000 entries, sockets and FIFOs left
    out; a read 1 MiB; a NUL in the first 8000 bytes is binary. A raster picture comes from
    `files/image` through the same checks, typed by magic bytes alone (PNG, JPEG, GIF, WebP, AVIF),
    else 415, over 16 MiB 413. An SVG is never served as bytes; the phone draws its text in `<img>`.
11. **Files needs an authorised device.** Files, its existence check and its picture ask `device-read`:
    `read` plus the device header allowlist. Changes asks `read`, and the Files right in rules 2 and 4.
    Every level needs the pairing token (ADR 0086). A crew member decides both by its own allowlist.
12. **A printed path is a link only inside the root, once it exists.** The phone resolves it against
    its copy of the root rule and sends only the root-relative path; no Files route takes an absolute
    path or a `file:` URI. A path stays text until the bridge says something is there.

## Today in the code

- Rule 1: the header of `bridge/changes.ts`; `GIT_OPTIONAL_LOCKS=0` in `gitEnv`; `loadCommit`
  (`cat-file commit`, then `parent ?? emptyTree`); `changesParams` reads no revision.
- Rules 2 and 3: `withinBound`, `workspaceRoot`, `rootForPane` (`changes-root.ts`); `paneWorkspaceRoot`,
  `paneChanges` (`unbounded`), `changesScope`, `paneFilesRootOf`, `filesSubjectRoot` (`server.ts`);
  `resolveReadRoot`, `isBoundedReal` (`read-guard.ts`) in `changesRoot` and `resolveRoot`.
- Rule 4: `discoverRepos` (it also skips dot-folders and `SKIP_DIRS`, and stops at `MAX_REPOS` 20 or
  `MAX_WALK_ENTRIES` 5000); `discoverUnder` (`upTo`, `repoAllowed`), `gitDirBounded`, `realGitDir`,
  `realCommonDir`; `fileDiff`, `readCommit`, `commitFileDiff`; `readUntracked` with `readHeadUnder`.
- Rule 5: `runGit`, `HARDENING`, `gitEnv`, `filterOverrides` (a driver name it cannot spell makes the
  repo unreadable), `GIT_TIMEOUT_MS`. The header of `bridge/changes.ts` lists each vector and why.
- Rule 6: `parseRelPath`, `MAX_REL_PATH_BYTES`, `WINDOWS_DEVICE`, `WINDOWS_SHORT_NAME`, `filesQuery`.
- Rule 7: `containedRealpath` with `isInside` (`bridge/journal/files.ts`, `bridge/host.ts`);
  `checkedTarget`, `OPEN_FLAGS`, `NODE_FILES_FS.readHead`, `openedFileAllowed`, `kernelPathOf`.
- Rule 8: `isDeniedPath`, `deniedFolders`, `foldingHost` (`read-guard.ts`); `keep` in `listFolder`;
  `shownEntry`, `shownCounts`, `visibleEntries`; `isStateSecretName`, `filesPrivateFolders`.
- Rule 9: `UNKNOWN_PATH`, `unknownPath`, `filesImageResponse`, `existingPaths` (a link swapped in
  since the check is absent too); the phone tells an older member's 404 by the word (`api.ts`).
- Rule 10: `MAX_FILES_ENTRIES`, `MAX_FILES_READ_BYTES`, `readImage`, `MAX_IMAGE_READ_BYTES`,
  `sniffImageType`; `FILES_IMAGE_HEADERS` (`no-store`, `default-src 'none'; sandbox`, `inline`) with
  `nosniff` from `secure`, also on `forwardedFilesImage`; `SvgPreview`, `HtmlPreview` (`sandbox=""`).
  `COLLIE_REDACT` (on by default) masks diff and file text (`maskDiff`, `maskFileBody`).
- Rule 11: `paneGateLevel`, `guard`, `deviceAuth`, `caller.gate("device-read")` on the Files routes and
  in `changesScope`; `crewGate`; `FORWARDABLE` skips `files/exist`, so a member's pane shows no links.
- Rule 12: `paneFilesRoot`, `resolveFilePathLink` (`web/src/lib/file-paths.ts`); `MAX_EXIST_PATHS`
  64; `FILE_EXIST_ABSENT_TTL_MS` 30 s, `FILE_EXIST_CACHE_MAX` 512 (`file-links.tsx`).
- Code and `docs/changes.md` hold the rest: `SharedReads` (1.5 s, keyed by scope), `CHANGES_POLL_MS`
  5 s, `gitIgnoredNames` (a filter, not a gate), lazy sugar-high, `file-image-cache.ts` (memory only).
  `bridge/folder-browse.ts` and `bridge/tricks/inputs.ts` (`readFileBytes`) reuse this bound.

## Recorded, not found in the code

- 0083: reads were open, and with nothing paired any device used Files. Since 0086 every read needs
  the token; `device-read` adds only `COLLIE_DEVICE_HEADER`. Its "race this accepts" is closed.
- 0065 rule 3: "every pane in one workspace shows the same list"; only inside the folder (#509).
  Rule 7's syntax inks at 4.5:1 are a look that no check in code holds.

## Consequences

- A tmux session in `/etc` lists `/etc`; a folder linked to a second disk reads. A pane in home with
  no workspace root gets Changes of home only on a device with the Files right.
- A repo whose only changes are hidden reads as clean. A hard link inside the root reads (pnpm makes
  them). A `.git` pointer file is followed, as git reads it. LFS may read modified.
- A paired device reads every file under the root, `.env` files included. Pairing is the guard.
- Revisit on `openat2(RESOLVE_BENEATH)` in Bun, or a request to write from Files (a new record). A
  git key that runs a program goes into `HARDENING`; a root rule change goes into `paneFilesRoot`.

## What we tried before

- 0065, 0112: Changes reads git against HEAD, rules 3, 7 and 9 rewritten in place; then #509.
- 0083, 0090: Files under the Changes root, four addenda on the screen; pictures typed by bytes.
- 0088: printed paths are links inside the root; it stays live for the absolute-path road.
- Since 1.28.5 the Changes view reads under the same guard as Files.
