import { stat } from "node:fs/promises";

// The disk half shared by every operator-authored TOML file that sits next to their `.env`
// (`commands.toml`, `keys.toml`). One reader shape for all of them, so a second such file cannot
// quietly grow a second caching contract — the grammar is what differs between them, never the
// posture.

/** Kept behind an interface so the caching contract is testable without fs. */
export interface OperatorFileIo {
  /** Modification time in ms, or null when the file is absent/unreadable. */
  mtime(path: string): Promise<number | null>;
  /** The file's text. May throw — the caller treats that exactly like a parse failure. */
  read(path: string): Promise<string>;
}

export const diskIo: OperatorFileIo = {
  async mtime(path) {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return null;
    }
  },
  read: (path) => Bun.file(path).text(),
};

/**
 * A reader for one operator TOML file, re-read at request time behind an mtime check — the same
 * posture as `web/dist` and the build id, so editing the file is live and needs no restart.
 *
 * The path is fixed at startup from the operator's own config dir and is NEVER client-supplied, so
 * the journal's `containedRealpath` rule (which exists for paths derived from a request) has
 * nothing to contain here.
 *
 * Failure is always a HOLD, never a 500: a file that stops parsing keeps serving the last good rows
 * (empty if it never parsed), warned once per change rather than once per request. An operator
 * mid-edit sees their previous rows, not a broken config endpoint.
 *
 * `validate` is the per-file grammar — pure, total and fs-free (operator-commands.ts,
 * operator-keys.ts); this function owns nothing but the cache and the failure posture.
 */
export function createOperatorFileReader<TDoc, TRow>(
  path: string,
  validate: (doc: TDoc | null | undefined, warn: (message: string) => void) => TRow[],
  io: OperatorFileIo,
  warn: (message: string) => void,
): () => Promise<TRow[]> {
  // `seen` is the mtime the current `rows` were derived from — including the mtime of a file that
  // FAILED, which is what stops a broken file re-warning on every request.
  let seen: number | null | undefined;
  let rows: TRow[] = [];
  return async () => {
    const mtime = await io.mtime(path);
    if (mtime === seen) return rows;
    seen = mtime;
    // No file is not an error — it is the ordinary case of an operator who declared nothing.
    if (mtime === null) {
      rows = [];
      return rows;
    }
    try {
      // SAFETY: `Bun.TOML.parse` answers with a parsed document object and `validate` is its only
      // reader — every field it names is typed `unknown` there and checked before it is believed,
      // so this assertion claims nothing beyond "a document came back".
      const doc = Bun.TOML.parse(await io.read(path)) as TDoc;
      rows = validate(doc, warn);
    } catch (err) {
      warn(`${path} could not be parsed (${String(err)}) — keeping the last good rows`);
    }
    return rows;
  };
}
