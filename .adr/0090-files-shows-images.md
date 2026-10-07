# 0090: Files shows pictures, as bytes typed by their own content

- **Status:** Accepted
- **Date:** 2026-10-07
- **Shipped in:** pending
- **Relates to:** [ADR 0083](./0083-the-files-view-reads-the-changes-root.md) (the Files view reads
  one root-relative path under the Changes root, as JSON; this adds a second answer for one kind of
  file and retracts nothing) · [ADR 0086](./0086-reads-need-the-pairing-token.md) (reads need the
  pairing token, so a picture is fetched, never linked) · [ADR 0088](./0088-paths-the-agent-prints-are-links.md)
  (the same rule decides which Markdown image paths stay inside the root).
- **Trail:** `bridge/files-view.ts` (`readImage`, `sniffImageType`, `MAX_IMAGE_READ_BYTES`) ·
  `bridge/server.ts` (`PANE_FILES_IMAGE_ROUTE`, `WORKSPACE_FILES_IMAGE_ROUTE`, `filesImage`,
  `filesImageResponse`, `forwardedFilesImage`, `filesSubjectRoot`) · `bridge/crew/forward.ts`
  (`FORWARDABLE`) · `CREW_PROTOCOL.md` §5 · `web/src/lib/api.ts` (`filesImagePath`,
  `fetchFileImage`) · `web/src/components/file-preview.tsx` (`FileImages`, `ImagePreview`,
  `SvgPreview`, `MarkdownImage`, `useObjectUrl`) · `web/src/components/ui/image-frame.tsx` ·
  `web/src/lib/files-view.ts` (`isRasterImagePath`, `imageCaption`, the `svg` preview kind) ·
  `web/src/lib/files-link.ts` (`resolveImageSrc`) · `web/src/lib/markdown.ts` (the `image` span,
  `MAX_DOCUMENT_IMAGES`) · `web/src/routes/changes.tsx` (`fileImages`) · `docs/changes.md` → *Files*

## Context

The Files view answered a picture with "Binary file, 51 KB". Agents write pictures all the time:
screenshots, rendered charts, a logo they just drew. A README shows its screenshots by relative
path. The operator opened the file to look at it, and got its size.

ADR 0083 serves file bytes as JSON only, never as a document, and the text read carries text. A
picture does not fit in it: base64 inside JSON costs a third more bytes and a parse, and a 1 MiB
cap is small for a photo. Reads also need the pairing token (ADR 0086), so a plain
`<img src="/api/...">` cannot load either.

## Decision

**A raster picture is served by its own read, `GET /api/pane/:id/files/image?path=` and
`GET /api/workspace/:id/files/image?path=`, as its bytes, with the type read off those bytes. An SVG
is not served there: it is text, and the phone draws it from the text read.**

1. **The same read, another answer.** The image read runs the Files read's code: the same root
   lookup, the same `parseRelPath`, the same `checkedTarget` (real paths inside the root, `.git`,
   the private folders and a state secret's name denied), the same `O_NOFOLLOW` open of a regular
   file. There is no second resolver. A refused path is the same `404 { "error": "unknown-path" }`.
   The gate is the same `device-read`. Over a crew link it is forwarded exactly as the Files read
   is, and a member that predates it answers 404.
2. **The type comes from magic bytes only.** PNG (the full eight-byte signature), JPEG (`FF D8 FF`),
   GIF (`GIF87a` or `GIF89a`), WebP (`RIFF` at 0 and `WEBP` at 8), AVIF (an `ftyp` box that names
   `avif` or `avis`). Anything else is `415`, whatever its name. The extension is the agent's word, or
   a stranger's, and a type taken from it would hand the browser bytes under a label they do not
   match. The phone uses the extension only to decide whether to ask.
3. **16 MiB, then 413.** The blob route's ceiling, for the blob route's reason: a phone on a cellular
   link is the reader. The file is sized before it is opened and again on the open handle.
4. **The answer is locked down.** `Cache-Control: no-store`, because the browser's cache outlives a
   pairing and the phone holds the bytes in memory anyway. `Content-Security-Policy: default-src
   'none'; sandbox` and `X-Content-Type-Options: nosniff`, so the bytes opened as a page are an
   opaque, script-less document of the sniffed type. `Content-Disposition: inline`. A forwarded
   answer gets the same headers from the lead, because the proxy keeps only a few of the member's.
5. **No SVG on this route.** An SVG is a document that can carry script. Served as `image/svg+xml`
   from the app's origin it would be one navigation away from running there. It is also already
   text, so the text read returns it. The phone gives `.svg` a Source | Preview control, as Markdown,
   JSON and HTML have, and opens on Preview the same way. Preview wraps the text in a Blob typed
   `image/svg+xml` and draws it in an `<img>`, where an SVG runs no script and loads nothing.
6. **Object URLs are made per view and revoked.** The phone fetches the bytes with the token
   (`fetchAuthedBytes`), makes an object URL, and revokes it when the screen goes or the file
   changes. It does not use `lib/authed-url.ts`'s table, which keeps one URL per path for the life of
   the page: right for a content-addressed blob, wrong for a file whose bytes change under one name.
7. **A Markdown preview draws its relative pictures.** `![alt](src)` with no scheme, not starting
   with `/`, `~` or `//`, resolves against the file's folder. If it stays inside the root and is
   not under `.git`, it loads through the image read (raster) or the text read (an `.svg`). The first
   20 pictures of a document are asked for; the rest, a remote picture, and one that fails stay their
   alt text, as every image did before. The transcript's Markdown is unchanged: it never asks for
   image spans.
8. **A failure is the old line plus a reason.** A 413, a 415, a failed read, or bytes the browser
   cannot draw show "Binary file, N KB" with one line saying why.

## Consequences

- HEIC, BMP, TIFF and ICO are not drawn. They answer 415 and show the binary line. Adding one is a
  row in `sniffImageType` and an extension in `isRasterImagePath`, once a browser draws it.
- An SVG over the text read's 1 MiB cap is cut, and the cut file does not draw. It falls back to the
  "cannot draw" line, with the truncation note under it.
- The text read runs first for every file, so a picture costs two requests: the text read (which
  says `binary` and gives the size) and the image read. That keeps one path through the screen. The
  first is small for a binary file, since it carries no text.
- A 16 MiB picture over a slow link can outlast the phone's 10 s read timeout and show the "did not
  load" line. The blob route has the same limit.

## Amended 2026-10-07: held in memory

Opening the same picture twice downloaded it twice, since the answer is `no-store` and each view
revoked its URL. The phone now holds the bytes of the pictures it drew, in memory only: a module
table of Blobs (`web/src/lib/file-image-cache.ts`), at most 32 pictures and 64 MiB, the oldest used
dropped first. Nothing goes to IndexedDB, Cache Storage, localStorage or the service worker, so a
reload, a closed tab and the wipe routine all empty it, and so does a new token (ADR 0086, M46).

**The key is the file's version.** A picture changes under one path, so the key is machine and
session, pane or workspace, the root-relative path, and `size:mtimeMs`. The Files read answers an
optional `mtimeMs` beside `size`, taken from the same open handle, never a second path lookup. The
screen reads that answer before it draws a picture, so the version is known before the image fetch.
The image read answers the same two numbers as `X-Collie-File-Size` and `X-Collie-File-Mtime`. When
they disagree with the version the screen asked for, the file changed between the two reads, and the
bytes are drawn but not held under the older key. A bridge or member that sends no `mtimeMs` is not
held at all. A lead relays both headers for a member's picture, as plain data, and sets the picture's
security and cache headers itself. A failed read, a 413, a 415 and a body that is not an image are
never held.

**A Markdown picture has no read of its own**, so it is held under its Markdown file's version and
its path. Change the Markdown file, or tap refresh, and its pictures are asked for again; change only
the picture, and the old one stays on that Markdown page until then. That is the price of asking for
nothing, and the refresh button is the way out. The refresh button drops everything the pane or
workspace holds before it reads.

**Object URLs stay per view (point 6 stands).** The table holds the Blob, and each view makes its own
URL from it and revokes it on unmount. A URL held in the table would have to be revoked at eviction
while a screen might still draw it, and a second view could be handed one the first had revoked.
