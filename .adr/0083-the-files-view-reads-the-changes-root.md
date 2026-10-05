# 0083 — The Files view reads the Changes root

- **Status:** Accepted
- **Date:** 2026-10-05
- **Shipped in:** pending (1.17.0)
- **Relates to:** [ADR 0065](./0065-the-changes-view-reads-git-read-only.md), whose last bullet named a
  later Files view "on the same rails". Nothing there is retracted.
- **Trail:** `bridge/files-view.ts` · `bridge/server.ts` (`PANE_ROUTE`, `WORKSPACE_FILES_ROUTE`,
  `paneFiles`, `workspaceFiles`, `paneGateLevel`, `guard`) · `bridge/crew/peer-gate.ts` (`GateLevel`,
  `crewGate`) · `bridge/crew/forward.ts` · `bridge/journal/files.ts` (header, `containedRealpath`) ·
  `bridge/changes-root.ts` (`workspaceRoot`, `withinBound`) · `CREW_PROTOCOL.md` §5, §12 ·
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
5. **The deny list, for list and read alike, hidden from listings:** any `.git` segment, and
   anything inside the bridge's state folder or config folder. Both are checked on the requested
   segments and again on the real path, and the deny checks fold case on every host, so `.GIT`, a
   link into `.git`, and a link into the state folder all land on the same refusal. Every other
   dot-file is shown: the operator's own files are the operator's to read.
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
- **Revisit** if Bun exposes `openat2` or an `O_RESOLVE_BENEATH` equivalent (close the race), if an
  operator asks for writes from Files (that is a different ADR, and a write gate), or if a real
  deployment needs a deny entry beyond `.git` and the two private folders.
