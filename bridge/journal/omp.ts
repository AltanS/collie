// OMP's journal adapter.
//
// OMP persists the same version-3 JSONL message grammar as pi, including per-row ids and separate
// toolResult rows. Its only renderable extension is `custom_message`: rows explicitly marked
// `display: true` are notices the operator saw in the TUI and remain notes in their original log
// position. All other OMP bookkeeping is left for the shared v3 parser to ignore.

import { parsePiTranscript, PiTranscriptSource } from "./pi.ts";
import type { JournalAdapter, TranscriptEntry } from "./types.ts";

interface OmpRow {
  type?: unknown;
  id?: unknown;
  timestamp?: unknown;
  display?: unknown;
  content?: unknown;
}

/** Parse OMP v3 JSONL into oldest-first turns. PURE — no fs, no clock. */
export function parseOmpTranscript(text: string): TranscriptEntry[] {
  const lines = text.split("\n");
  const rows: Array<OmpRow | null> = [];
  const ids = new Set<string>();

  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      const row = value !== null && typeof value === "object" ? (value as OmpRow) : null;
      rows.push(row);
      if (row && typeof row.id === "string") ids.add(row.id);
    } catch {
      // A live append or tail window can leave a partial line. Keep it unchanged so the shared
      // parser applies its normal malformed-row handling.
      rows.push(null);
    }
  }

  // Turn visible notices into otherwise ordinary v3 messages before using the established parser.
  // Placeholder ids are checked against every real row id, so no log-controlled id can masquerade
  // as one of our notices when parsed entries are converted back to notes.
  const notes = new Map<string, string>();

  const normalized = lines.map((line, index) => {
    const row = rows[index];
    if (
      row?.type !== "custom_message" ||
      row.display !== true ||
      typeof row.content !== "string" ||
      row.content.trim() === ""
    ) {
      return line;
    }

    let placeholder = `__collie_omp_note__${index}`;
    while (ids.has(placeholder)) placeholder += "_";
    ids.add(placeholder);
    notes.set(placeholder, typeof row.id === "string" ? row.id : `omp-note-${index}`);
    return JSON.stringify({
      type: "message",
      id: placeholder,
      timestamp: typeof row.timestamp === "string" ? row.timestamp : "",
      message: { role: "user", content: [{ type: "text", text: row.content }] },
    });
  });

  return parsePiTranscript(normalized.join("\n")).map((entry): TranscriptEntry => {
    const originalId = notes.get(entry.uuid);
    return originalId === undefined ? entry : { ...entry, uuid: originalId, role: "note" };
  });
}

/** OMP's source layout and session refs are the contained pi v3 layout. */
export function ompJournal(root: string): JournalAdapter {
  return {
    agent: "omp",
    source: new PiTranscriptSource(root),
    parse: parseOmpTranscript,
  };
}
