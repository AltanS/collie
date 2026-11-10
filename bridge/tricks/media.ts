// A trick's pictures (M94 review 11): the files of a trick's own `media/` folder, served to the phone
// for an `image` node.
//
//   GET /api/tricks/<host>/<id>/media/<file>     → the bytes, or 404 "no such image"
//
// THE SAME HARDENING AS A HILL IMAGE. A trick folder is code the person approved, but its `media/`
// folder is outside the code hash (a program writes its pictures there between runs), so what the
// route serves is checked as strictly as a file an agent names for the hill (bridge/hill/media.ts,
// `readPostedImage`), in this order:
//
//   1. The trick is this bridge's, known, and switched on: a trick never switched on gets nothing served.
//   2. The file is `media/` and a relative path the schema's image `src` rule takes (`isImageSrc`): no
//      `.` or `..` step, no hidden name, a `.png`, `.jpg`, `.jpeg` or `.webp`, at most 256 characters.
//   3. The path is built under the trick folder's REAL path, and from there on `readPostedImage` holds
//      every check: `lstat` (not a symlink, a regular file, at most 2 MB), its real path is the path as
//      built (so no folder below the trick folder, `media/` included, is a symlink), not under a `.git`
//      folder nor a secret's name, opened with O_NOFOLLOW and O_NONBLOCK, the same inode, the kernel's
//      own name for it, and the leading bytes decide the type: PNG, JPEG or WebP, never SVG, GIF or HTML.
//
// Every miss is the same 404, so the route tells nothing about what the folder holds. The headers are
// the hill image's (`HILL_MEDIA_HEADERS`: no-store, a sandboxed CSP, inline) plus `nosniff`.

import { realpathSync } from "node:fs";
import { join } from "node:path";

import { isImageSrc, TRICK_MEDIA_DIR } from "../../web/src/lib/tricks/schema.ts";
import type { HillMediaMime } from "../../web/src/lib/hill/wire.ts";
import { readPostedImage } from "../hill/media.ts";

/** One picture of a trick, read and checked. */
export interface TrickMediaFile {
  readonly mime: HillMediaMime;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/**
 * The bytes of `rel` in the trick folder `dir`, or null. `rel` must be a path the image `src` rule takes,
 * which starts with `media/`. Total: no input makes it throw.
 */
export function readTrickMedia(dir: string, rel: string): TrickMediaFile | null {
  if (!isImageSrc(rel) || !rel.startsWith(`${TRICK_MEDIA_DIR}/`)) return null;
  let root: string;
  try {
    root = realpathSync(dir);
  } catch {
    return null;
  }
  // `readPostedImage` refuses a path whose real path differs from it, so building on the folder's real
  // path leaves no room for a symlink below it. No denied folders: the trick folder sits inside the
  // config folder by design, and the rule above keeps the read inside its `media/`.
  const read = readPostedImage(join(root, rel), []);
  return read.ok ? { mime: read.mime, bytes: new Uint8Array(read.bytes) } : null;
}
