# 0160: A repository's own file changes what Collie shows, and nothing else

- **Status:** Accepted
- **Date:** 2026-11-19
- **Trail:** Issue 811 (`@mfrep`): "maybe we add a collie.toml or collie config per repo? this could be
  used to set these workspace icons?", and the operator's answers of 2026-11-19: "we need some attributes
  for collie.toml this could be used for other settings down the line that we're not aware of now", and
  "is the schema really necessary? its a toml file". The road this closes is the one the first answer
  opens: a per-repository file that grows to carry commands, launchers, keys or hooks, the way
  `commands.toml`, `launchers.toml` and `keys.toml` do for the operator. On the picture, the operator:
  "the icon mark, should only be overridable inside a session view, not the workspace", and "push
  pictures would be cool". Roads turned down there: an SVG or a GIF, a picture in place of the mark on
  every screen, and a push icon fetched from the bridge.
  Files: `bridge/project-file.ts`, `bridge/project-picture.ts`, `bridge/config.ts`
  (`COLLIE_PROJECT_FILES`), `cli/project-file-finding.ts`, `web/src/lib/project-picture.ts`,
  `web/src/components/collie-home.tsx`, `web/src/sw.ts`, `docs/configure.md`

## Context

The operator's own files (`commands.toml`, `keys.toml`, `quick-replies.toml`, `launchers.toml`,
`theme.toml`) live in Collie's config folder. Only the operator writes there, so a row in them may define
what a tap types, which pane a launch opens, which keys a tray offers ([ADR 0018](./0018-operator-command-rows-replace-the-catalog.md),
[ADR 0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md)).

A file inside a repository is a different class. A cloned repository wrote it, and so can the agent that
works in that checkout, which writes files all day. Collie already treats agent output as untrusted:
the mirror renders text nodes only, a beacon names what Collie shows and never an action. A repository
file is that class of input with a longer life, and it reaches every session opened in the tree.

The first key is a picture (`[project] icon`): it stands in for the agent logo on a session's tile, with
the logo small in its corner, and for the resting mark in a session view. The
operator asked for a file that can take more keys later. A file with room to grow is also a file
someone will propose to grow into the operator's files.

## Decision

1. **A repository's `collie.toml` changes what Collie shows and nothing else.** It never defines a
   command, a launcher, a key, a hook, a trick, or anything that types into a session, starts a process,
   opens a port or reaches the network. The table names `commands`, `launch`, `keys` and `hooks` are never
   read from this file, by this release or a later one. A need of that kind is the operator's, in the
   operator's own files.
2. **Every byte is untrusted input**, the same class as agent output. The file is at most 16 KB, opened
   without following a link and without blocking (a FIFO, a device, a folder or a link named
   `collie.toml` is refused, not opened), and must be UTF-8 TOML.
3. **One fixed list, no free-form part, no version field.** The reader knows a fixed list of tables and
   keys (`PROJECT_KEYS`), each key with its own validator. Keys are only ever added. An unknown table or
   key is ignored, never an error, and `collie doctor` lists it by name. A known key with a bad value is
   refused alone; the rest of the file still counts. A later key (`name`, `color`) is one more entry with
   its own validator, and it must pass rule 1.
4. **The nearest file wins, never above the repository.** From the session's real folder up to its
   repository root, the first `collie.toml` speaks; files are never merged. A folder outside any
   repository reads only its own `collie.toml`. A linked worktree reads its own tree, then the main
   checkout from the same folder. A submodule is its own tree. A refused nearest file means no settings,
   never a reach further up.
5. **The operator's switch wins.** `COLLIE_PROJECT_FILES=0` in the instance's `.env` turns every
   repository's file off on that machine: nothing is read, nothing is served. On by default.
6. **Reading never blocks a poll.** The snapshot answers from memory; the disk is read in the background
   on stamp-keyed clocks with a bounded table and no watcher (the shape of `bridge/git-head.ts`).

## The picture: three roads closed

The picture comes from a file anyone with write access to the repository can change, so it can
imitate a logo or a warning sign. Three options it closes:

1. **Only a still raster picture: never an SVG, a GIF or an animated PNG or WebP.** PNG, JPEG or WebP,
   typed by its first bytes, at most 256 KB, each side 64 to 1024 px. A drawing format is markup, and
   a moving picture can mimic a live state.
2. **Never the mark's place outside a session view, and never while the mark has something to say.**
   The dashboard, a Space and the large-screen sidebar keep the Collie mark. In a session the picture
   shows only while the mark rests: loading, a lost or returning connection, an update and an agent
   starting bring the mark back.
3. **A push never fetches the picture.** The operating system decodes a notification's icon outside the
   browser's sandbox, so the service worker shows only the PNG copy the page drew itself on a canvas, or
   the Collie icon. The badge stays Collie's.

The wire carries a version (12 hex of the sha256), never a path, and the read route serves only a
picture the bridge itself resolved.

## Consequences

- A cloned repository can change a picture on the operator's phone without asking. That is the whole of
  its reach, and the per-device switch (Settings, Appearance, "Project pictures") and the operator's
  switch both turn it off. The agent's own logo stays in the tile's corner, drawn by Collie.
- The rule is tested at the line that would break it: `project-file.test.ts` fails when a table named in
  rule 1 enters the fixed list.
- A setting that would need more than display (a repository's own launcher, say) is a new ADR that
  supersedes this one, not a new key.
