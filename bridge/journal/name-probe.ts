// The shared half of a name probe (JournalAdapter.nameProbe): read a bounded window of a log and walk
// its rows. The GRAMMAR stays per harness, in each adapter: which row names the session, and whether
// a person or the agent set it. Only the reading is shared, and it is the cache probe's own reading
// (cache-probe.ts), so a name costs no new kind of disk access.
//
// Read-only and never throws. Containment is not re-argued here: `source.resolve(ref)` puts every
// candidate through `containedRealpath` (files.ts), as it does for the history route.

import type { JsonObject, JsonValue } from "../json.ts";
import { asRecord, walkBack } from "./cache-probe.ts";
import type { AgentSessionRef, TranscriptSource } from "./types.ts";

/** How much of a log's head a name probe reads: the first row, where Oh My Pi keeps its title. */
export const NAME_HEAD_BYTES = 4096;

/** The first whole line of a log, or null when there is nothing readable there. */
export async function probeHeadLine(source: TranscriptSource, ref: AgentSessionRef): Promise<string | null> {
  let path: string | null;
  try {
    path = await source.resolve(ref);
  } catch {
    return null;
  }
  if (path === null) return null;
  try {
    const head = await Bun.file(path).slice(0, NAME_HEAD_BYTES).text();
    const newline = head.indexOf("\n");
    // A first row longer than the window is a fragment, and a fragment is no row.
    return newline === -1 ? null : head.slice(0, newline);
  } catch {
    return null;
  }
}

/** One JSONL line as an object, or null for anything else. */
export function rowOf(line: string | null): JsonObject | null {
  if (line === null || line.trim() === "") return null;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction; every read below goes through `asRecord`.
    return asRecord(JSON.parse(line) as JsonValue);
  } catch {
    return null;
  }
}

/** The newest row of a window that `pick` answers for, read newest first. */
export function newestOf<T>(lines: readonly string[], pick: (row: JsonObject) => T | undefined): T | undefined {
  return walkBack(lines, (entry) => {
    const row = asRecord(entry);
    return row === null ? undefined : pick(row);
  });
}

/** A string field, as written (empty included), or undefined when it is not a string. */
export function stringField(row: JsonObject, key: string): string | undefined {
  const value = row[key];
  return typeof value === "string" ? value : undefined;
}
