# 0088: Paths the agent prints are links, inside the Changes root only

- **Status:** Accepted
- **Date:** 2026-10-07
- **Shipped in:** pending
- **Relates to:** [ADR 0083](./0083-the-files-view-reads-the-changes-root.md) (the Files view reads
  one root-relative path under the Changes root; nothing there is retracted).
- **Trail:** the herdr-web-ui file viewer, read on 2026-10-07 as the model for this feature, which
  opens any printed absolute path and any `file:///` URI through its server's own file route ·
  `web/src/lib/file-paths.ts` (`findFilePaths`, `codeSpanPath`, `resolveFilePathLink`,
  `paneFilesRoot`) · `web/src/components/file-links.tsx` (`usePaneFileLinks`) ·
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
root. Only that root-relative path ever reaches the bridge, through the Files route that exists.**

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

## Consequences

- A pane whose root is out of bounds (parked in home), a machine whose paths are not POSIX, and a
  phone that has not heard the launchers answer yet show no links at all. The text reads as before.
- If the bridge's root rule (`bridge/changes-root.ts`) changes, `paneFilesRoot` must change with it,
  or links appear that open to "not available", or vanish where they would work. This ADR is the
  link between the two; the phone's copy names the bridge's rule in its header.
- A path the terminal wrapped onto two rows is not joined. Revisit when a file counterpart of the
  URL repair through `logicalText` is worth its cost.
- Windows paths (`C:\x`) are not found. Revisit with a Windows root rule on the phone.
