# 0161: A project picture replaces the agent logo, and the mark only at rest in a session

- **Status:** Proposed
- **Date:** 2026-11-19
- **Trail:** Issue 811 (`@mfrep`): a picture per repository, to "override the claude icon for example".
  The operator, 2026-11-19: "we need to check what images to support, so the client is not reading sth
  malicious", "the icon mark, should only be overridable inside a session view, not the workspace", "we'd
  need a image transition animation for this too", "yes default with switch", the small agent logo in the
  corner ("2 yes good idea"), and "push pictures would be cool, do it in the same step". Roads turned down:
  an SVG or a GIF, a picture in place of the mark on every screen, and a push icon fetched from the bridge.
  Files: `bridge/project-picture.ts`, `bridge/server.ts` (`PROJECT_PICTURE_ROUTE`),
  `bridge/crew/forward.ts`, `web/src/lib/project-picture.ts`, `web/src/components/agent-tile.tsx`,
  `web/src/components/collie-home.tsx`, `web/src/components/ui/crossfade-image.tsx`, `web/src/sw.ts`

## Context

A repository's `collie.toml` may name a picture (`[project] icon`, [ADR 0160](./0160-a-repository-file-changes-what-collie-shows-and-nothing-else.md)).
The person and the agent both see it on every row of that project's sessions. The picture comes from a
file anyone with write access to the repository can change, so it can imitate another agent's logo or a
warning sign, and it can change while the person watches.

## Decision

1. **Only a still raster picture.** PNG, JPEG or WebP, typed by its first bytes; SVG, GIF, HTML and every
   other type refused; an animated PNG (`acTL`) or WebP (the VP8X flag, `ANIM`, `ANMF`) refused. At most
   256 KB, each side 64 to 1024 px from the header, with no decoding on the bridge. The path stays below
   the repository root on real paths with no link at any step, and never under `.git`. The hill's reader
   (`readPostedImage`) holds the disk checks; there is no second image reader.
2. **The wire carries a version, the client names no file.** A pane's view gains `picture`, the first 12
   hex of the sha256 of the bytes. `GET /api/project-picture/<version>` is read-gated, serves only a
   picture the bridge itself resolved, and only while its bytes still hash to that version. A member's
   picture crosses the crew link like a blob; an older member sends no field and the phone shows the
   agent logo.
3. **In a row, the picture replaces the logo and the logo stays in the corner.** The tile keeps its size,
   so nothing moves; a small agent logo sits on the picture's corner so the harness is always visible.
4. **The header mark becomes the picture only in a session view and only at rest.** Loading, a lost or
   returning connection, an update and an agent starting bring the Collie mark back, because a picture
   cannot say any of them. The dashboard, a Space and every other screen keep the mark, and so does the
   large-screen sidebar's logo row. A device that picked another character keeps it wherever the mark
   shows.
5. **A change fades, never flashes.** Opacity only, 200 ms, between the mark and a picture and between
   two pictures; none under reduced motion; another pane in the same place swaps at once, as a name does
   (`CrossfadeText`'s rules). The bridge names a new version at most once per 5 s however often the file
   changes.
6. **The phone draws the repository's bytes once.** It decodes them into a canvas and keeps its own PNG
   copies by version: a small one for the first frame, a larger one for push. The service worker shows
   only that copy as a notification's icon, with no fetch at push time, because the operating system
   decodes that icon outside the browser's sandbox. No copy means the Collie icon; the small Android
   badge stays Collie's.
7. **Per device, on by default.** Settings, Appearance, "Project pictures". Off shows the agent logo and
   the Collie mark everywhere, sends no push picture, and drops the copies.

## Consequences

- What remains of imitation: a picture can look like another agent's logo, but the corner logo is the
  harness's own, drawn by Collie. A picture can look like a warning sign, but it never replaces the mark
  while the mark has something to say, and it never moves.
- An agent can rewrite its own picture, like its own title. It fades, at the poll's pace or slower.
- A hostile repository costs a bounded walk and two small reads per file per 5 s: a FIFO, a device, a
  2 GB file or a link is refused before a read, and a file that changes type between the check and the
  read fails the inode check.
- A picture from a repository is a drawing on the phone, unlike a theme ([ADR 0148](./0148-a-theme-names-words-never-drawings-and-the-device-choice-wins.md)):
  it is pixels in an `img`, never markup, never a mark, and the device's switch wins as 0148 says.
