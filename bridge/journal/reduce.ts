// The row reducer: the shape every adapter's parser takes so that a live session which gains one row
// costs one row of work.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// `parse(text)` reads a whole file. On the real sessions measured on 2026-09-29 that is 186.8 MB,
// 89.8 MB and 64.9 MB, and `files.ts`'s `MAX_TRANSCRIPT_BYTES` already clamps a read to the last
// 32 MB — which `TranscriptStore` then re-reads and re-parses on every mtime move. One new row
// therefore costs 32 MB of reading and a full re-parse of it. That is the cost this module removes.
//
// ── THE ONE FACT THE WHOLE DESIGN RESTS ON ───────────────────────────────────
// A raw `\n` byte is always a row boundary, in all six formats. The three file harnesses write JSONL,
// and the two SQLite harnesses serialise their rows through `JSON.stringify`, which escapes a newline
// inside a string value as `\n` (two characters) and never emits a raw one. So a reader may cut the
// byte stream anywhere: a fragment either completes with the next chunk or is a fragment of exactly
// one row. Nothing has to understand JSON to find the boundaries.
//
// ── WHAT A REDUCER REPORTS, AND WHY IT IS TWO LISTS ──────────────────────────
// A tool result lands in a LATER row than its call, and folding it in mutates a part inside a turn
// that was emitted already. Under `parse(text)` that is invisible: the caller only ever sees the
// finished array. Under a tail the caller is holding that turn on a screen, so the reducer has to
// say which of its earlier answers changed. Hence `changed` beside `added`.
//
// It is one `uuid` list rather than a pair of "replace" verbs because a `uuid` is the identity and
// the caller already holds the object. A reducer mutates the part in place, exactly as the whole-file
// loop always did, and names the turn it happened in.
import type { TranscriptEntry, TranscriptPart } from "./types.ts";

/** What one row did to the thread. */
export interface Reduction {
  /** Turns that did not exist before this row, oldest first. */
  readonly added: readonly TranscriptEntry[];
  /** `uuid`s of turns emitted EARLIER that this row changed in place. Never a position. */
  readonly changed: readonly string[];
}

export interface RowReducer {
  /**
   * Fold one row in. Takes a complete line WITHOUT its newline, and tolerates every kind of rubbish
   * a tail read produces: a blank line, a fragment of JSON, a scalar, a row of an unknown shape. A
   * row it cannot use adds nothing and changes nothing; it never throws.
   */
  push(line: string): Reduction;
}

/** The answer for a row that did nothing. Frozen, because it is handed to every caller. */
export const NO_CHANGE: Reduction = Object.freeze({
  added: Object.freeze<TranscriptEntry[]>([]),
  changed: Object.freeze<string[]>([]),
});

/**
 * A tool call waiting for its result, and the turn it has already gone out in.
 *
 * The `uuid` is what makes `changed` possible: without it a reducer can mutate the part and has no
 * way to say where. `""` for a row that carried no id of its own, which is not reportable and is
 * dropped from `changed` rather than sent as an empty name (see {@link reduction}).
 */
export interface PendingTool {
  part: Extract<TranscriptPart, { kind: "tool" }>;
  uuid: string;
}

/**
 * The most tool calls a reducer holds waiting for a result.
 *
 * The bound is the requirement, and the number is deliberately far past anything real: a call and
 * its result are adjacent rows in every format here, so a map this size means thousands of calls in
 * a row went unanswered. Over a whole session with no bound at all the map is the one thing in a
 * reducer that grows for ever, which is the fault this closes. Eviction is oldest-first, since a
 * `Map` keeps insertion order and the oldest waiting call is the one least likely to still be
 * answered.
 */
export const PENDING_MAX = 4096;

/** Remember a call, and forget the oldest one if that would push the map past {@link PENDING_MAX}. */
export function rememberPending<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size <= PENDING_MAX) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

/**
 * Build one row's answer.
 *
 * Two rules live here rather than in six adapters. A `uuid` of `""` is dropped from `changed`,
 * because a turn with no name cannot be addressed by one. And a `uuid` that is in `added` is dropped
 * too: a row that both makes a turn and folds a result into it has not changed anything the caller
 * held, it has simply handed over a finished turn.
 */
export function reduction(added: readonly TranscriptEntry[], changed: ReadonlySet<string>): Reduction {
  if (changed.size === 0) return added.length === 0 ? NO_CHANGE : { added, changed: NO_CHANGE.changed };
  const fresh = new Set(added.map((e) => e.uuid));
  const out = [...changed].filter((uuid) => uuid !== "" && !fresh.has(uuid));
  return { added, changed: out };
}

/**
 * Run a reducer over a whole text and concatenate what it added: the `parse(text)` contract every
 * caller and every existing test already drives, expressed once.
 *
 * `text.split("\n")` is the same cut `parse` always made, including the final fragment a file with
 * no trailing newline ends in. The reducer skips that fragment when it is one, exactly as the loop
 * inside `parse` did, so the two answers are identical by construction rather than by agreement.
 */
export function parseWith(reducer: RowReducer, text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of text.split("\n")) {
    for (const entry of reducer.push(line).added) entries.push(entry);
  }
  return entries;
}

/** Turns arbitrary byte chunks into complete rows. See "the one fact" in this file's header. */
export interface LineFeeder {
  /** The complete rows in these bytes. A trailing fragment is held for the next chunk. */
  push(chunk: string): string[];
  /**
   * The held fragment, as one last row.
   *
   * A reader at the END of its input calls this, and gets the same final row `text.split("\n")`
   * would have produced for a file with no trailing newline. A reader tailing a LIVE file must not:
   * that fragment is a half-written row which the next write completes.
   */
  flush(): string[];
}

export function createLineFeeder(): LineFeeder {
  let carry = "";
  return {
    push(chunk: string): string[] {
      const rows = (carry + chunk).split("\n");
      // The last element is either a fragment or "" when the chunk ended on a newline. Either way it
      // is what the next chunk continues, and "" costs the next `push` nothing.
      carry = rows.pop() ?? "";
      return rows;
    },
    flush(): string[] {
      if (carry === "") return [];
      const last = carry;
      carry = "";
      return [last];
    },
  };
}
