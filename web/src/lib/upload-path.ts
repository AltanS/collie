// The path Collie's upload route hands back, and where a harness cuts a paste around it.
//
// One shape, read in two places: the web adapter's `liftedPaste` (which pieces of a send Claude
// takes off as images) and the bridge's Send Protocol `wholePaste` (the same question for a text
// written as one paste). Both must count the same pieces, so the shape lives here, in a module with
// no imports, and neither keeps a copy.

/**
 * The shape of the path Collie's upload route hands back (`bridge/server.ts`): an absolute
 * `<stateDir>/uploads/<pane>-<base36 time>-<8 hex>.<ext>`, with a POSIX or a Windows root. The
 * composer swaps a chip's marker for that path where the marker stood (`composeLine`), so it is the
 * only image path Collie ever sends. A name merely ending `.png` in a sentence is not this shape.
 */
const UPLOAD_PATH_TAIL = String.raw`[\\/]uploads[\\/][A-Za-z0-9_-]+-[0-9a-z]+-[0-9a-f]{8}\.(?:png|jpe?g|gif|webp)`;
const UPLOAD_ROOT = String.raw`(?:/|[A-Za-z]:[\\/])`;
/** A whole piece of a paste that is one upload path; the directories may hold spaces (a Windows
 *  profile name). */
const UPLOAD_PIECE = new RegExp(`^${UPLOAD_ROOT}.*${UPLOAD_PATH_TAIL}$`, "i");
/** Where the harness cuts a paste into pieces: at each newline, and at a space that comes right
 *  before an absolute path. */
const PIECE_CUT = new RegExp(`\\r?\\n| (?=${UPLOAD_ROOT})`);

/** The pieces a harness cuts a paste into: at each newline, and at a space before an absolute path. */
export function pastePieces(text: string): string[] {
  return text.split(PIECE_CUT);
}

/** Whether one piece of a paste, trimmed, is a path in Collie's own upload shape. */
export function isUploadImagePath(piece: string): boolean {
  return UPLOAD_PIECE.test(piece.trim());
}
