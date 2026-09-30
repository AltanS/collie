// The cursor: one opaque token that says where a source got to, in that source's own language.
//
// ── WHY ONE CODEC AND NOT THREE SHAPES ───────────────────────────────────────
// The contract is `readSince(key, cursor)`, and the three storage kinds under it count position
// differently: a byte offset for the four harnesses that write a file, `max(time_updated)` for
// opencode's rows (which it mutates while a reply streams), and `max(id)` for hermes' append-only
// ones. Every one of those is ONE non-negative integer, so the shape they share is worth more than
// the names they don't. A single text token carries it, and the number's MEANING never leaves the
// adapter that wrote it.
//
// ── THE THREE FIELDS ARE THE THREE WAYS A CURSOR IS WRONG ────────────────────
// `<tag>:<position>:<keyHash>`
//
//  - `tag` — which counting this is. A cursor from another storage kind is REFUSED rather than
//    misread. A pane whose agent changed under a window that kept its cursor is what produces one.
//  - `position` — the number. Digits only, so a corrupted or hand-made token can never arrive as a
//    negative (which `Bun.file().slice` reads from the END of the file), a float, or `1e9`.
//  - `keyHash` — which source it was taken on. This is what makes Claude's hand-over free: when a
//    conversation rotates, `resolve` starts answering with a different path, the hash stops
//    matching, and the read resets. No hand-over code lives in the cursor at all. The same field
//    covers an opencode session that moved database.
//
// The key is HASHED, not carried. A cursor is positioning and never authority, so identity is the
// only question asked of this field, and a hash answers it while keeping an operator's home
// directory out of a value the live window may log or put on the wire. Refusing a cursor is always
// the safe direction: the read resets, which shows the operator their session again rather than
// less of it.

/**
 * Where a source got to. OPAQUE above the source that made it: pass it back verbatim, and never
 * read inside it. Only this module and the one adapter that wrote it may.
 */
export type Cursor = string;

/** "I hold nothing yet." Every source answers this with a bounded tail and `reset: true`. */
export const NO_CURSOR: Cursor = "";

/** Which counting a cursor's number is. Named by STORAGE, not by harness: four share `bytes`. */
export type CursorTag = "bytes" | "updated" | "rowid";

/** One source's answer to "what is new". */
export interface ReadSince {
  /** Complete rows in source order, never a fragment. Empty when nothing moved. */
  readonly lines: readonly string[];
  /** Where to resume. */
  readonly cursor: Cursor;
  /**
   * Throw away what you hold: `lines` is the whole truth now, not an append to it.
   *
   * One flag for every reason a read is not an append — a first read, a truncated file, a rewritten
   * database, a cursor left too far behind to catch up on, and Claude's hand-over to a new log.
   */
  readonly reset: boolean;
}

/** Position field: digits only. See "the three ways a cursor is wrong" in this file's header. */
const POSITION = /^\d+$/;

function hashKey(key: string): string {
  return Bun.hash(key).toString(36);
}

export function encodeCursor(tag: CursorTag, key: string, position: number): Cursor {
  return `${tag}:${position}:${hashKey(key)}`;
}

/**
 * The position this cursor holds for `key`, or null when it is absent, foreign or unusable.
 *
 * Null is one answer for all four, on purpose: every one of them means the same thing to a caller,
 * which is "you cannot resume from this, take a fresh tail".
 */
export function decodeCursor(cursor: Cursor, tag: CursorTag, key: string): number | null {
  const fields = cursor.split(":");
  if (fields.length !== 3 || fields[0] !== tag || fields[2] !== hashKey(key)) return null;
  const digits = fields[1] ?? "";
  if (!POSITION.test(digits)) return null;
  const position = Number(digits);
  return Number.isSafeInteger(position) ? position : null;
}
