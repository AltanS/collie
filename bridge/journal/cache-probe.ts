// The shared half of a cache probe: resolve the log, read its last 128 KB, walk the lines newest-first.
// The GRAMMAR stays per harness — claude reads `message.usage`, codex reads
// `payload.info.last_token_usage`, pi reads `message.usage.cacheRead` — and only the walking is shared.
//
// Everything here is read-only and never throws. A missing file, an unreadable one or a containment
// failure all answer null, which the tracker treats as "nothing new to read": the last reading stands
// and ages on the clock, and the next floor tick tries again. Nothing is written back, so the memo a
// successful probe left is the only thing a reader ever sees.
//
// Containment is not re-argued here. `source.resolve(ref)` is the same call the history route makes,
// and it is the one that puts every candidate through `containedRealpath` (files.ts).

import type { JsonObject, JsonValue } from "../json.ts";
import { CACHE_PROBE_BYTES, tailBytes } from "./files.ts";
import type { AgentSessionRef, TranscriptSource } from "./types.ts";

/** A log's tail, in file order, plus the mtime that answers "when was this read". */
export interface ProbeTail {
  readonly path: string;
  /** Every line of the window. A clipped head is dropped, so each one is a whole line. */
  readonly lines: readonly string[];
  /** The file's mtime — a probe's `measuredAt`. */
  readonly mtimeMs: number;
}

/** Resolve a session ref and read its tail, or null when there is nothing readable there. */
export async function probeTail(
  source: TranscriptSource,
  ref: AgentSessionRef,
  bytes: number = CACHE_PROBE_BYTES,
): Promise<ProbeTail | null> {
  let path: string | null;
  try {
    path = await source.resolve(ref);
  } catch {
    return null;
  }
  if (path === null) return null;
  try {
    const read = await tailBytes(path, bytes);
    // Unless the whole file fitted, the first line is a fragment of one. Parsers skip it anyway; it is
    // dropped here so `lines.length` is a count of real lines.
    const lines = read.text.split("\n");
    return { path, lines: read.complete ? lines : lines.slice(1), mtimeMs: read.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Walk a JSONL tail newest-first, handing each parsed line to `take` until it answers something.
 *
 * Newest-first because the only turn that matters is the last one, and a 128 KB tail usually holds
 * several. An unparseable line is skipped rather than fatal: the file belongs to the harness, not to
 * us, and its schema moves between releases.
 */
export function walkBack<T>(
  lines: readonly string[],
  take: (entry: JsonValue) => T | undefined,
): T | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i]?.trim();
    if (raw === undefined || raw === "") continue;
    let entry: JsonValue;
    try {
      // SAFETY: `JSON.parse` output IS a JsonValue by construction — a string, number, boolean, null,
      // or an array/object of those. Every read of it below is guarded by `asRecord`/`asText`.
      entry = JSON.parse(raw) as JsonValue;
    } catch {
      continue;
    }
    const hit = take(entry);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A token count only counts when it is a real number; a missing field is not a zero. */
export function tokenCount(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The object at this position in a third-party document, or null for anything else. */
export function asRecord(value: JsonValue | undefined): JsonObject | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

/** A non-empty string, or undefined. */
export function asText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

// ── A running sum over a whole log ───────────────────────────────────────────
//
// The tail above answers "what did the LAST turn carry". A session's cost is a question about EVERY
// turn, and a 128 KB tail holds a handful of them. So the sum is taken once over the whole file on
// first sight, then only over the bytes appended since: the memo keeps the byte offset (always a row
// boundary, so a torn last line is read again when its newline exists), the running total and how many
// rows contributed. A poll whose file did not grow reads nothing past a 64-byte fingerprint of the head.

/** How much of a log one read takes at once. A first read of a huge log is chunked, never held whole. */
const SUM_CHUNK_BYTES = 4 * 1024 * 1024;

/** The head of the file the memo was taken from: a file replaced under the same name no longer matches. */
const SUM_HEAD_BYTES = 64;

/** How many files a {@link FileSum} remembers before it drops the oldest. */
const SUM_FILES_MAX = 128;

interface SumState {
  /** Bytes consumed, always just past a newline (or 0). */
  offset: number;
  sum: number;
  /** Rows that named a number. */
  rows: number;
  head: string;
}

/**
 * The sum, over every line of a JSONL file, of the number `pick` finds in it. `mentions` is a cheap
 * substring a line must hold before it is parsed, so a log of mostly text rows costs a scan and not a
 * parse per row. Never throws: an unreadable file answers undefined.
 */
export class FileSum {
  private readonly held = new Map<string, SumState>();

  constructor(
    private readonly mentions: string,
    private readonly pick: (row: JsonValue) => number | undefined,
  ) {}

  /** The total so far and how many rows named a number, or undefined when the file cannot be read. */
  async read(path: string): Promise<{ sum: number; rows: number } | undefined> {
    try {
      const file = Bun.file(path);
      const size = file.size;
      const head = new TextDecoder().decode(new Uint8Array(await file.slice(0, Math.min(SUM_HEAD_BYTES, size)).arrayBuffer()));
      let state = this.held.get(path);
      // A file that shrank, or whose first bytes changed, is not the one the memo came from.
      if (state !== undefined && (size < state.offset || !head.startsWith(state.head))) state = undefined;
      const next: SumState = state === undefined ? { offset: 0, sum: 0, rows: 0, head } : { ...state, head: head.length > state.head.length ? head : state.head };
      let chunk = SUM_CHUNK_BYTES;
      while (next.offset < size) {
        const to = Math.min(size, next.offset + chunk);
        const bytes = new Uint8Array(await file.slice(next.offset, to).arrayBuffer());
        const end = bytes.lastIndexOf(0x0a);
        if (end === -1) {
          // No row boundary: either the row is still being written (stop and read it again next time)
          // or it is longer than the chunk (widen the chunk).
          if (to >= size) break;
          chunk *= 2;
          continue;
        }
        for (const line of new TextDecoder().decode(bytes.subarray(0, end)).split("\n")) {
          if (!line.includes(this.mentions)) continue;
          let row: JsonValue;
          try {
            // SAFETY: as in walkBack, JSON.parse output is a JsonValue; `pick` guards every read.
            row = JSON.parse(line) as JsonValue;
          } catch {
            continue;
          }
          const n = this.pick(row);
          if (n === undefined) continue;
          next.sum += n;
          next.rows += 1;
        }
        next.offset += end + 1;
        chunk = SUM_CHUNK_BYTES;
      }
      this.held.delete(path);
      this.held.set(path, next);
      if (this.held.size > SUM_FILES_MAX) {
        const oldest = this.held.keys().next();
        if (!oldest.done) this.held.delete(oldest.value);
      }
      return { sum: next.sum, rows: next.rows };
    } catch {
      return undefined;
    }
  }
}
