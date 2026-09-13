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
