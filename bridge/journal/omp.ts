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
  message?: unknown;
}

function ompRow(value: unknown): OmpRow | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    type: "type" in value ? value.type : undefined,
    id: "id" in value ? value.id : undefined,
    timestamp: "timestamp" in value ? value.timestamp : undefined,
    display: "display" in value ? value.display : undefined,
    content: "content" in value ? value.content : undefined,
    message: "message" in value ? value.message : undefined,
  };
}

/** Parse OMP v3 JSONL into oldest-first turns. PURE — no fs, no clock. */
export function parseOmpTranscript(text: string): TranscriptEntry[] {
  const lines = text.split("\n");
  const rows: Array<OmpRow | null> = [];
  const idCounts = new Map<string, number>();

  for (const line of lines) {
    try {
      const value = JSON.parse(line) as unknown;
      const row = ompRow(value);
      rows.push(row);
      if (row && typeof row.id === "string") idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
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
    if (row?.type === "message") {
      const message = row.message;
      if (
        message === null ||
        typeof message !== "object" ||
        Array.isArray(message) ||
        !("role" in message)
      ) return "";
      const role = message.role;
      if (role !== "user" && role !== "assistant" && role !== "toolResult") return "";
    }

    if (
      row?.type !== "custom_message" ||
      row.display !== true ||
      typeof row.content !== "string" ||
      row.content.trim() === "" ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      row.id.length > 100 ||
      idCounts.get(row.id) !== 1
    ) {
      return line;
    }

    let placeholder = `__collie_omp_note__${index}`;
    while (idCounts.has(placeholder)) placeholder += "_";
    idCounts.set(placeholder, 1);
    notes.set(placeholder, row.id);
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
