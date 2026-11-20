# 0160: A repository's own file changes what Collie shows, and nothing else

- **Status:** Accepted (2026-11-19); Superseded in part by [ADR 0164](./0164-a-push-shows-the-project-picture-as-its-icon.md) (rule 3's second and third sentences)
- **Date:** 2026-11-19
- **Trail:** Issue 811 (`@mfrep`): "maybe we add a collie.toml or collie config per repo? this could be
  used to set these workspace icons?", and the operator's answers of 2026-11-19: "we need some attributes
  for collie.toml this could be used for other settings down the line that we're not aware of now", and
  "is the schema really necessary? its a toml file". The road this closes is the one the first answer
  opens: a per-repository file that grows to carry commands, launchers, keys or hooks, the way
  `commands.toml`, `launchers.toml` and `keys.toml` do for the operator. On the picture, the operator:
  "the icon mark, should only be overridable inside a session view, not the workspace", and "push
  pictures would be cool". After a look at the build: "ok project logos are nice, but we dont have to
  replace the collie mark, the project icon + harness logo in one are enough". Roads turned down there:
  an SVG or a GIF, a picture in the Collie mark's place, and a push icon fetched from the bridge.
  Files: `bridge/project-file.ts`, `bridge/project-picture.ts`, `bridge/config.ts`
  (`COLLIE_PROJECT_FILES`), `cli/project-file-finding.ts`, `web/src/lib/project-picture.ts`,
  `web/src/components/agent-tile.tsx`, `web/src/sw.ts`, `docs/configure.md`

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
the logo small in its corner. The operator asked for a file that can take more keys later. A file with room to grow is also a file
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
   its own validator, and it must pass rule 1. `icon` stays a text path for good: growth comes only as
   new keys, never as a new shape of an old one.
4. **The nearest file wins, and a workspace speaks for its members.** From the session's real folder up
   to its repository root, the first `collie.toml` speaks; files are never merged. A linked worktree
   reads its own tree, then the main checkout from the same folder. When the session's repository has no
   file, an ENCLOSING repository's does (a workspace that holds member repositories, or a submodule, as
   folders): from the folder holding the member up to the workspace's root, by the same rules, through
   at most 4 enclosing repositories. The member's own file always wins, even with no icon in it, which is
   how a member opts out of its workspace's picture; an icon stays inside the repository of the file that
   names it. A parent folder is the operator's own ground more than the
   session's folder is, and the file changes display only. So a home folder that is a repository with a
   `collie.toml` gives every session below it that picture, which is what that file says. A folder
   outside any repository reads only its own `collie.toml`. A refused nearest file means no settings,
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
2. **Never the Collie mark's place.** The picture lives only in the tile where Collie draws a
   session's agent logo, with that logo small in its corner, so the agent stays visible. The mark speaks
   for the app's own state (loading, a lost or returning connection, an update, an agent starting), and a
   picture can say none of it.
3. **A push never fetches the picture, and its icon is never a repository's picture.** The icon and the
   badge are always Collie's. The picture goes only in the notification's own picture slot, where the
   system has one, with nothing drawn on top. The operating system decodes it outside the browser's
   sandbox, so the service worker hands it only the PNG copy the page drew itself on a canvas, for that
   pane's machine and version (the owner, 2026-11-19).

The wire carries a version (24 hex of the sha256), never a path, and the read route serves only a
picture the bridge itself resolved. A lead checks a crew member's picture again before the phone sees
it, and the phone reads the header before it decodes.

A repository can show any picture, another project's included, so the picture is never proof of which
project or agent asks. What Collie draws itself says that: the agent's logo in the tile's corner and the
session's name beside the tile.

## Consequences

- A cloned repository can change a picture on the operator's phone without asking. That is the whole of
  its reach, and the per-device switch (Settings, Appearance, "Project pictures") and the operator's
  switch both turn it off. The agent's own logo stays in the tile's corner, drawn by Collie.
- What remains of a stale picture: the push map is keyed by machine and pane id, because a push names
  no session. A reused pane id can show the old pane's picture in a push until the phone's next poll
  rewrites the map.
- The rule is tested at the line that would break it: `project-picture.test.ts` fails when a table named
  in rule 1 enters the fixed list, and `project-file.test.ts` when a key whose validator is not on its
  display list does.
- A setting that would need more than display (a repository's own launcher, say) is a new ADR that
  supersedes this one, not a new key.
