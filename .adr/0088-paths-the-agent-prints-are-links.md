# 0088: Paths the agent prints are links, inside the Changes root only

- **Status:** Accepted
- **Date:** 2026-10-07
- **Shipped in:** pending
- **Relates to:** [ADR 0083](./0083-the-files-view-reads-the-changes-root.md) (the Files view reads
  one root-relative path under the Changes root; nothing there is retracted).
- **Trail:** the herdr-web-ui file viewer, read on 2026-10-07 as the model for this feature, which
  opens any printed absolute path and any `file:///` URI through its server's own file route ·
  `web/src/lib/file-paths.ts` (`findFilePaths`, `codeSpanPath`, `resolveFilePathLink`,
  `paneFilesRoot`) · `web/src/components/file-links.tsx` (`usePaneFileLinks`,
  `useFileLinkExistence`) · `bridge/files-view.ts` (`existingPaths`) · `bridge/server.ts`
  (`filesExist`) ·
  `web/src/routes/detail.tsx` · `web/src/components/markdown-text.tsx` ·
  `web/src/components/chat-cards.tsx` · `web/src/components/ansi-output.tsx` ·
  `web/src/components/raw-mirror.tsx` · `web/src/lib/nav.ts` (`FilesAt.line`) ·
  `web/src/components/file-preview.tsx` (`SourceView`) · `docs/changes.md` → *Paths the agent prints*

## Context

Agents print paths all the time: `saved to docs/demo.mp4`, `src/app.ts:42`, an Edit card's
`/home/me/repo/web/a.ts`. The operator's next move is to read that file. Collie already has a reader,
the Files view, bounded by the Changes root and fed root-relative paths only (ADR 0083).

The obvious port is the other road: hand the printed path to the bridge as it is. That is what the
herdr-web-ui viewer does. It opens any absolute path, and `file:///` URIs, through a server route.
In Collie that would make a fourth place where a client-supplied value becomes a path, one with no
root, and it would undo the bound ADR 0083 drew around Files.

## Decision

**A printed path is tappable only when it resolves, on the phone, to a path inside the pane's Changes
root, and the bridge said a file or a folder is there. Only that root-relative path ever reaches the
bridge, through the Files routes.**

1. **Resolution is client-side.** The phone works out the pane's root from the snapshot the way the
   bridge does (`paneFilesRoot` mirrors `workspaceRoot` and the pane cwd fallback, with the same
   bound below home), takes home from the launchers answer, and resolves `/abs`, `~/`, `./`, `../`
   and bare relative paths against it. Anything that leaves the root, the root itself, or a `.git`
   path is plain text, never a dead link. The bridge checks the path again on the read (ADR 0083).
2. **`~` and absolute paths never reach the bridge.** The link carries `?path=` relative to the root,
   as every Files link does. No route takes an absolute path.
3. **No line suffix reaches the bridge.** `:12`, `:12:5` and `(12,5)` become `&line=` in the app's
   own URL. The Files screen reads it, opens Source and marks that row. The read is the same read.
4. **No `file://` support.** A `file:///` URI names a path on the machine of whoever reads the text,
   with no root, and a phone has none of that machine's files. Collie's file reader lives on the
   bridge, behind a root. A `file:` link would be an absolute path by another name, which point 2
   refuses.

No bridge field is added. The root the phone works out is a hint for which text to underline. The
root the bridge looks up on each read decides what is served.

## Existence

Amended 2026-10-07, before the release. On the dev lane about 20 of 24 tapped links opened "This
file is not available". Agents name files in sibling checkouts, bare names in code spans
(`languages.ts`), and `./x.md` against a cwd the phone does not know. Resolution alone cannot tell
these from real files, and a dead link is worse than none.

So a resolved path is a link only after the bridge said it exists. `POST /api/pane/:id/files/exist`
and `POST /api/workspace/:id/files/exist` take `{ paths }`, at most 64 root-relative paths, and
answer `{ exists }`. They use the Files root, the Files checks and the `device-read` gate (ADR 0083),
then one `lstat` per path. No file is opened and no byte is read. Absent is also the answer for
everything the read would refuse (outside the root, a link that escapes, `.git`, the private
folders, a state secret's name), so the check tells nothing the read would not.

The phone queues the paths a view draws, sends them 150 ms after the last one, each once, and keeps
up to 512 answers per pane view. A path is plain text until the answer says yes, and a drawn link
never turns back into text. Offline, after a failed request, and on a crew member's pane (the route
is not forwarded over the crew link yet), nothing is asked and nothing is a link.

## Consequences

- A pane whose root is out of bounds (parked in home), a machine whose paths are not POSIX, and a
  phone that has not heard the launchers answer yet show no links at all. The text reads as before.
- If the bridge's root rule (`bridge/changes-root.ts`) changes, `paneFilesRoot` must change with it,
  or paths are asked against the wrong root and links vanish where they would work. This ADR is the
  link between the two; the phone's copy names the bridge's rule in its header.
- An absent answer is believed for 30 seconds, then asked again the next time the path is drawn (changed
  2026-10-08: it was kept for the life of the view, so a file the agent wrote after its path was
  printed, a Write waiting on a permission prompt, stayed plain text until the view opened again). A
  present answer is kept for the view's life.
- A path the terminal wrapped onto two rows is not joined. Revisit when a file counterpart of the
  URL repair through `logicalText` is worth its cost.
- Windows paths (`C:\x`) are not found. Revisit with a Windows root rule on the phone.
