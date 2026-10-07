# 0083 — The Files view reads the Changes root

- **Status:** Accepted. Amended by [ADR 0086](./0086-reads-need-the-pairing-token.md): reads need the pairing token, so the context's "reads were open" is no longer true.
- **Date:** 2026-10-05
- **Shipped in:** pending (1.17.0)
- **Relates to:** [ADR 0065](./0065-the-changes-view-reads-git-read-only.md), whose last bullet named a
  later Files view "on the same rails". Nothing there is retracted.
- **Trail:** `bridge/files-view.ts` · `bridge/server.ts` (`PANE_ROUTE`, `WORKSPACE_FILES_ROUTE`,
  `paneFiles`, `workspaceFiles`, `paneGateLevel`, `guard`) · `bridge/crew/peer-gate.ts` (`GateLevel`,
  `crewGate`) · `bridge/crew/forward.ts` · `bridge/journal/files.ts` (header, `containedRealpath`) ·
  `bridge/changes-root.ts` (`workspaceRoot`, `withinBound`) · `bridge/acl-policy.ts`
  (`isStateSecretName`) · `bridge/changes.ts` (`runGit`, `gitBinary`, `discoverRepos`) ·
  `web/src/lib/files-filter.ts` · `web/src/lib/files-marks.ts` · `web/src/components/files-view.tsx` ·
  `web/src/routes/changes.tsx` (`ChangesScreen`) · `CREW_PROTOCOL.md` §5, §12 ·
  `docs/changes.md` → *Files* · `docs/security.md`

## Context

The Changes view shows what changed. The next thing an operator asks from the phone is to look at a
file that did not change: the README the agent is following, the config next to the diff, a log the
agent wrote. That is a file browser, and a file browser is the opposite of the listed-paths rule
ADR 0065 rests on. Changes serves a path only when git itself listed it; Files must serve a path
the client names. So this is the third place a client-supplied value becomes a path, and the law in
`bridge/journal/files.ts` says a third place needs an ADR that names its bound.

Facts that shaped it:

- **The root already exists.** `bridge/changes-root.ts` picks a workspace's folder off the live
  snapshot, bounded below home and never `/`. The pane Changes route falls back to the pane's own
  cwd with no bound at all.
- **`containedRealpath` compared with a raw `startsWith(realRoot + sep)`.** That is wrong on a
  case-insensitive Windows path, and a root of `/` could never contain anything (`//`).
- **The bridge's own secrets can sit under a root.** The state folder (`paired-devices.json`,
  `crew-trust.json`, `stt.json`) and the config folder (`.env` with the VAPID private key) are
  `PRIVATE_ROOTS` (`bridge/acl-policy.ts`). A workspace in `~/.config` or a dotfiles repo holding a
  linked `~/.config/collie` would list them.
- **Reads were open to every device that passes the front door.** Pairing and the device header
  guard writes only. Changes is a read, and what it shows is bounded by what git lists as changed.

## Decision

**Files reads one folder or one file, relative to the Changes root, and nothing else.**

1. **The root is looked up, never sent.** `GET /api/pane/:id/files` and
   `GET /api/workspace/:id/files` take the root from `workspaceRoot` over the snapshot. The pane
   route's cwd fallback is allowed only when the cwd passes `withinBound`; else `no-folder`. Unlike
   Changes, a pane parked in `~` gets no Files.
2. **The root's real path is bounded too.** The root is resolved with `realpath`, must be a folder,
   and must pass `withinBound` against home's real path and home as given. A workspace folder that
   is a symlink to `/` or to home is `no-folder`, not the whole disk. (On Fedora Atomic, `/home` is
   itself a link to `/var/home`, which is why both spellings of home are checked.)
3. **The client's path is refused on its shape before any disk call** (`parseRelPath`): absolute, a
   `..` or `.` segment, an empty segment, NUL, a backslash, over 4096 bytes. On Windows also a colon
   (a drive or a stream), a wildcard or other character Windows cannot name, a trailing dot or space
   (Windows strips them, so `.git.` is `.git`), and a device name (`CON`, `NUL.txt`, `COM1`). The
   value is decoded once by `URLSearchParams` and never again, so `%252e%252e` is a file named
   `%2e%2e`.
4. **Containment runs on real paths, through the shared function.** The target is joined onto the
   root's real path and passed to `containedRealpath`, which now compares with `isInside` under the
   host's rules (case-folded on Windows). That is a fix of the shared function, not a copy: the
   journal and the untracked read get it too. A symlink that leads out of the root, a chain that
   ends outside, and a loop are `unknown-path` on read; the listing still shows each as `link`.
5. **The deny list, for list and read alike, hidden from listings:** any `.git` segment, anything
   inside the bridge's state folder or config folder, and any file whose basename is a state
   secret's, wherever it sits. All are checked on the requested segments and again on the real
   path, and the deny checks fold case on every host, so `.GIT`, a link into `.git`, a link into the
   state folder, and a link named `notes` that leads to a `crew-trust.json` all land on the same
   refusal. Every other dot-file is shown: the operator's own files are the operator's to read.
   See *The sibling instance* below for what the basename rule covers.
6. **One refusal.** Absent, outside, denied, a folder read as a file and a file listed as a folder
   are all `404 { "error": "unknown-path" }`. The `error` is the machine word, as Changes'
   `reason: "unknown-path"` is, and it is what the web tells an older member's 404 apart by. It
   carries no catalogue code for that reason.
7. **Caps, and no walk.** 2000 entries per folder (`truncated`), counted after hidden entries, read
   with one streamed directory read that stops at the cap, then one `lstat` per kept entry. Sockets,
   FIFOs and devices are left out. 1 MiB per file (`MAX_FILE_READ_BYTES`, the untracked read's cap),
   cut on a character boundary; a NUL in the first 8000 bytes is `binary` with no text. No polling
   contract: the web asks on open.
8. **JSON only, never a document.** File bytes travel as a string inside a JSON body with
   `application/json` and `nosniff`, so a browser never renders a file the agent wrote as HTML or
   SVG under Collie's origin. A preview that renders is the web's job, inside a sandbox it owns.
9. **The gate: a read that needs an authorised device.** `files` asks its caller's gate at a third
   level, `device-read`. In the browser's `guard` it is checked for access as a read, so the
   `Origin` rule for writes does not apply (a browser sends no `Origin` on a same-origin GET, and a
   cross-site page cannot read the answer), and then it needs the same device factors as a write:
   the device header allowlist AND pairing. On a crew member, `crewGate` takes its write branch for
   it: the member's own allowlist decides. It is still a read everywhere else: forwarded on the read
   budget, attempted against a stale member, and audited on neither side.
10. **Crew.** Both routes are in `FORWARDABLE`, mirrored to the `server.ts` grammar, and in
    `CREW_PROTOCOL.md` §5 as additive-optional rows. The member reads its own disk under its own
    state and config folders. A member that predates it answers 404, which the phone reads as
    "update this member". The protocol version stays 2.

11. **A listing says which entries git ignores, and the web hides them by default.** A listing row
    may carry `ignored: true`. It is additive and optional: absent means not ignored or not known. The
    web hides flagged rows until the operator asks (a per-device `filesShowIgnored` pref: an eye
    toggle in the header, the same toggle with its state in words in the Filter row, and a quiet
    "{count} ignored hidden" line). This is a
    **view filter and not a gate**: `?path=` is unchanged, an ignored file reads like any other, and
    nothing here widens or narrows what Files can reach. See *Ignored entries* below.

### Ignored entries

When the listed folder lies inside a git work tree, `listFolder` runs **one**
`git check-ignore --stdin -z` for that listing, over the entries it kept (after the deny filter and
the 2000 cap), and sets `ignored: true` on the rows git names. Why it is acceptable, and how it is
bounded:

- **A child process in a read-only view is acceptable here** because Changes already runs git over
  this same root, through the same hardened runner (`runGit` in `bridge/changes.ts`: argv only, no
  shell, no inherited `GIT_*`, no hook, fsmonitor and pager off, no network, a timeout, an output
  cap). Files adds one verb to it, a read that writes nothing. The one new knob is that
  `check-ignore` refuses `--literal-pathspecs`, so the runner leaves that flag off for it and the
  caller spells every path `./name`, which no pathspec magic (`:(top)`, `:!`) can start with.
- **Names travel on stdin only.** The paths go in NUL-separated (`-z` in and out), never in argv, so a
  name with a newline, a leading dash or a colon is one literal path and cannot become a flag or a
  pathspec. The answer is read back by exact string.
- **One run per listing, no walk.** The run is killed at 2 seconds (Changes' runs get 5). On a
  timeout, a non-0/1 exit, a capped output, no git binary, or no repository above the folder, the
  listing answers with **no flags at all** and no error. A listing never fails for this.
- **The repository is the nearest `.git` above the listed folder's real path** (`discoverRepos`,
  the walk Changes uses for the repo that contains a folder). A folder inside a nested clone is
  therefore asked of that clone, with its own rules, and a folder outside any repository gets no
  flags. A dotfiles repository at home that ignores everything makes everything under it ignored,
  which is what git itself says.
- **No `--no-index`.** A tracked file that matches an ignore rule is not ignored, which is git's own
  answer. Directories go in without a trailing slash: git looks the path up on disk, so a `build/`
  rule hits a directory and not a file of that name, and a symlink to a folder is a file to git.
  Everything inside an ignored folder is reported ignored by git, so a listing opened inside
  `node_modules` comes back whole.
- **Crew.** The member runs it on its own disk. A member that predates the field sends none, and the
  phone then hides nothing for it.

### Why the device gate, and not the plain read gate

Changes shows what git lists as changed under the root. Files shows every file under it: `.env`
files, keys an agent wrote, a database dump. That is a different amount of the disk, and a
read-only device (a shared tablet, a phone not yet paired) was never meant to see it. The device
gate is what Collie already has for "this device is the operator's", and it composes cleanly
through both callers: the browser's `guard` and the crew's `crewGate` each take a level, and
`device-read` is one more value of that type, with no second gate expression. With no device
paired and no device header, every device is authorised, exactly as for writes, so a fresh install
loses nothing; pairing the phone closes it. No audit line is written per read: the audit log
records what reaches a terminal, and a log line per folder tap would bury the lines that matter.

### The sibling instance

The private folders are THIS bridge's. A second Collie on the same machine (the dev lane beside the
release lane, or `collie-next` beside `collie`) keeps its state in a sibling folder such as
`~/.local/state/collie-next`, and a workspace opened in `~/.local/state`, or in a dotfiles repo
that holds a linked state folder, would list the sibling's pairing records and crew trust.

So a file is also refused and hidden when its basename is one of the state folder's secrets, the
`state` entry of `PRIVATE_ROOTS` (`crew-trust.json`, `paired-devices.json`,
`pairing-pending.json`, `push-subscriptions.json`, `standby-devices.json`, `stt.json`), plus
`pack-trust.json`, the trust store's 1.7.0 name, alone or followed by one of Collie's own
temporary or rotation suffixes (`crew-trust.json.tmp`). One function decides it,
`isStateSecretName` in `bridge/acl-policy.ts`, and it reads that list, so a new state secret is
covered the day it is named there. The rule is checked on the real path's basename, so a link with
another name that leads to one of these files is refused as well.

It does not cover a sibling's CONFIG folder. `.env` and `config.toml` are common names for a file
the operator owns, and hiding every `.env` under a root would hide the operator's own. A sibling's
`~/.config/herdr/plugins/config/herdr.collie-next/.env`, with its VAPID private key, is readable
when the root contains it. So is every other credential file under a legal root: a workspace opened
in `~/.claude`, `~/.codex`, `~/.config/gh` or `~/.ssh` shows what is there. The device gate is the
guard for those, and pairing is what closes it.

### The race this accepts

Between the containment check and the read, a component of the path can be swapped for a symlink.
The final component is opened with `O_NOFOLLOW` (POSIX), so swapping the file itself for a link
fails the open; `O_NONBLOCK`, so a FIFO swapped in cannot hang the request; and the opened handle
must be a regular file. A swap of a folder ABOVE the file is not closed: that needs
`openat2(RESOLVE_BENEATH)`, which Bun does not expose. The only party who can win that race is
someone who can write inside the root, which is the agent running as the operator's own user, and
that agent can already read every file the bridge can. ADR 0065 accepted the same race for the
untracked read, for the same reason. On Windows neither flag exists; the regular-file check stays.

## Consequences

- **The law now names three places.** `CLAUDE.md` and the `bridge/journal/files.ts` header say so,
  and name this bound. A fourth place still needs its own ADR.
- **A tmux session started in `/etc` lists `/etc`.** The bound is the Changes bound: never `/`, home,
  or above home. A folder outside home is the operator's choice of workspace, and Files shows what
  the bridge user can read there, which is what the agent in that pane can read.
- **A read-only device sees Changes but not Files.** The web shows the refusal; the fix is pairing.
- **A hard link inside the root to a file outside it reads.** Containment is by path, and a hard
  link is a path inside the root. Making one needs write access inside the root and read access to
  the file, which is the same user again.
- **Names Collie cannot ask for still list.** A Linux file with a backslash or a NUL-free but
  non-UTF-8 name shows in the list and answers `unknown-path` when opened.
- **macOS folds case on disk but `Host` does not.** Containment on macOS compares the real paths
  exactly; a request spelled in another case either resolves to the same real path or is refused.
  The deny checks fold case on every host, so they err towards refusing.
- **A listing may start one git process.** The cost is bounded (one run, 2 seconds, no flags on
  failure), and Changes already pays more on the same root.
- **An ignored file is still one tap, or one `?path=`, away.** Hiding is for the operator's eyes and
  is not a security property. A file an operator must not read belongs behind the device gate or out
  of the root.
- **Revisit** if Bun exposes `openat2` or an `O_RESOLVE_BENEATH` equivalent (close the race), if an
  operator asks for writes from Files (that is a different ADR, and a write gate), or if a real
  deployment needs a deny entry beyond `.git`, the two private folders and the state secret names.

## Amended 2026-10-06: one screen, Changes and Files merged

The web side only; the bridge and its bound are unchanged. The operator could not find Files behind
a tab, and a changed file meant two places to look. So the Changes screen has no Changes | Files
switch any more. Its body is the folder tree of the Changes root, and the change set marks it:

- A changed file wears its status letter, and its icon switches to that status's shape (a pen, a
  plus, a minus, an arrow in) in that status's ink. Untracked counts as changed and takes the added
  ink, letter, icon and dot, because a file the agent just wrote is the change looked for first.
  Everything inside an untracked folder is marked new. A folder shows a dot and the
  count of changed paths below it. A row git ignores is never marked.
- A deleted file is not on disk, so the tree adds it from the change set, struck through, with `D`.
  A folder that holds only deleted files is added the same way.
- The join is by the path from the root (`web/src/lib/files-marks.ts`, `rootPathOf`), from the list
  the screen already polls every 5 s. A folder outside every repo has no marks. The folder itself is
  still never polled (rule 6 above).
- A **Changes only** toggle in the header, the same in every folder and on a file, carries the
  count of changed paths and shows the list as it
  was. It is off by default, and a per-device pref beside `filesShowIgnored`. Refresh reads both.
- A file of the tree opens on **Diff | Source | Preview**. Diff only for a changed file, and it is
  the default there. Preview only for the types rule 9 names. A deleted file has Diff alone. The
  Preview button in a diff opens this same screen on Preview.
- Back still goes up one level: a file to its folder, a folder to its parent, and the root, now the
  Changes screen itself (`…/changes`), to where Changes went before. `…/changes/files` with no query
  is the root under its old address.
- The List | Tree choice of the list became one icon toggle, so the header keeps room for the
  workspace's name at 375 px with Changes only and Refresh beside it.
- A device the read gate admits and the device gate refuses (consequence 3) still sees the change
  set: the root offers Changes only in the tree's place. So does a pane whose folder Files does not
  reach but Changes does.

## Amended 2026-10-06 (later): the screen is Files, and the mode is a segment

The web side only, by the operator's call. The merged screen is called **Files**, in its header on
every level (root, a folder, a file), on a pane's route and on a space's. The **Changes only**
icon toggle and the Ignored eye leave the header. A two-segment control directly under it, **All
files | Changes**, drawn by the file screen's own `Segmented`, writes the same `changesOnly` pref;
the Changes segment carries the changed-file count as the small amber badge the toggle drew. The
list's head line names the root at the left and the `+added −removed` totals at the right, which
left the header's second line. The header keeps Filter, the Tree toggle (Changes only) and Refresh.
The "{count} ignored hidden" footer is the only switch for ignored rows: once they are shown it
reads "{count} ignored shown" and offers **Hide**. Read "Changes only" above as the Changes segment.

## Amended 2026-10-08: the opened file is checked too

The race above is now closed on the handle, before any byte is read, for the text read and the image
read alike (`openedFileAllowed` and `kernelPathOf`, `bridge/files-view.ts`). On Linux the kernel's
own name for the open file, read from `/proc/self/fd/<fd>`, must lie inside the root's real path and
pass the deny rules. Where there is no `/proc`, the path is resolved and checked again, and its
`lstat` must be the handle's own file (device and inode). A folder swapped for a link out between the
check and the open now answers `unknown-path`. `openat2(RESOLVE_BENEATH)` would still be the cleaner
tool. The hard-link consequence above stands: a hard link is the same inode under a name inside the
root, so both checks pass it, and a file with more than one link is not refused, because package
managers such as pnpm hard-link ordinary files.
