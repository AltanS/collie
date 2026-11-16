# 0090: Files shows pictures, as bytes typed by their own content

- **Status:** Superseded by [ADR 0150](./0150-files-and-changes-read-under-a-root-the-bridge-picks.md) (2026-11-16)
- **Decided:** Files shows a raster picture as bytes from its own read, typed by magic bytes alone (PNG, JPEG, GIF, WebP, AVIF), up to 16 MiB, with locked-down headers, and never serves an SVG as bytes.
- **Full text:** `git show 21ab922c7:.adr/0090-files-shows-images.md`
