import type { JsonObject } from "./json.ts";
import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";
import type { SessionEntry } from "./types.ts";

// The operator's own names for their sessions, read from `sessions.toml` next to their `.env` — the
// seventh file on the operator-file contract (operator-file.ts owns the discovery rule, the mtime
// cache and the hold-the-last-good-rows failure posture).
//
// WHY THIS FILE EXISTS. A session is named by its endpoint's directory (`sessionNameFor`,
// bridge/sessions.ts), so a bridge fronting twenty Herdr sessions shows twenty directory names in the
// switcher: `project-yt`, `ai-system-setup`, a hash. The operator knows them by other words, often in
// another language, and had no way to say so.
//
// A LABEL IS DISPLAY-ONLY. The registry name stays the identity everywhere it already is: `?session=`
// on the wire, `?s=` in the browser URL, the notification tag, the crew wire, the walky address. This
// module never renames a session; it adds one optional `label` field to the snapshot's summary, and
// the phone prints it in place of the name. A label for a session that does not exist is simply
// never looked up.

/** The longest label kept, in code points. A switcher row is one line on a phone; the rest is noise. */
export const MAX_SESSION_LABEL = 48;

/** A parsed `sessions.toml` document, before a byte of it is believed. */
interface SessionLabelsDocument {
  labels?: unknown;
}

/** One `[labels]` row: the registry name and the label the phone prints for it. */
export interface SessionLabelRow {
  name: string;
  label: string;
}

// Controls (C0 and C1, newline and tab included) and format characters (Cf: the bidirectional
// overrides and isolates, the LRM/RLM marks, zero-width spaces and joiners, the BOM, the soft
// hyphen), plus the two Unicode line separators. The same class pairing.ts and claude-commands.ts
// strip from a label. A control in a one-line label is a typo or an attempt to make the row read as
// something else, and a format character alone would print an invisible label.
const CONTROLS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;

/**
 * A label as the phone may print it: controls become spaces, runs of white space become one, the
 * ends are trimmed, and anything past {@link MAX_SESSION_LABEL} code points is cut. Pure.
 */
export function cleanSessionLabel(raw: string): string {
  return cut(flatten(raw));
}

/** One line of text: controls become spaces, white space runs become one, the ends are trimmed. */
function flatten(raw: string): string {
  return raw.replace(CONTROLS, " ").replace(/\s+/gu, " ").trim();
}

/** The first {@link MAX_SESSION_LABEL} code points of an already flat label. */
function cut(flat: string): string {
  const points = Array.from(flat);
  return points.length > MAX_SESSION_LABEL ? points.slice(0, MAX_SESSION_LABEL).join("").trimEnd() : flat;
}

/**
 * Turn a parsed TOML document into label rows, dropping anything malformed with one warning line.
 *
 * Pure and total: it never throws and never reads a file. Every rejection is a DROP of the offending
 * row, never of the file, so one typo costs the operator one label and not the rest.
 *
 * ```toml
 * [labels]
 * "project-yt" = "УТ ОП"
 * default = "Home"
 * ```
 */
export function validateSessionLabels(
  doc: SessionLabelsDocument | null | undefined,
  warn = defaultWarn,
): SessionLabelRow[] {
  const table = doc?.labels;
  if (table === undefined || table === null) return [];
  if (typeof table !== "object" || Array.isArray(table)) {
    warn("`labels` must be a table of \"session name\" = \"label\" rows — ignoring the file's rows");
    return [];
  }
  // SAFETY: a TOML table parses to a plain object; every value is checked below before it is believed.
  const rows = table as JsonObject;
  const out: SessionLabelRow[] = [];
  for (const [rawName, value] of Object.entries(rows)) {
    const name = rawName.trim();
    if (name === "") {
      warn("ignoring a label with an empty session name");
      continue;
    }
    if (typeof value !== "string") {
      warn(`ignoring the label for "${name}" — it must be a string`);
      continue;
    }
    const flat = flatten(value);
    if (flat === "") {
      warn(`ignoring the label for "${name}" — it is blank`);
      continue;
    }
    const label = cut(flat);
    if (label !== flat) {
      warn(`the label for "${name}" is longer than ${String(MAX_SESSION_LABEL)} characters — it is cut`);
    }
    out.push({ name, label });
  }
  return out;
}

function defaultWarn(message: string): void {
  console.warn(`[sessions] ${message}`);
}

/** The operator's labels as the snapshot reads them: a synchronous lookup, refreshed off the hot path. */
export interface SessionLabels {
  /** Re-read the file if its mtime moved. Never throws; a broken file keeps the last good labels. */
  refresh(): Promise<void>;
  /** The label for a registry name, or undefined when the operator gave it none. */
  labelOf(name: string): string | undefined;
}

/**
 * A reader for the operator's `sessions.toml`. The snapshot is assembled synchronously, so the rows
 * are held here and {@link SessionLabels.refresh} is awaited where a request can wait (the browser's
 * snapshot poll) — the same mtime check every other operator file takes per request.
 */
export function createSessionLabels(path: string | null, io: OperatorFileIo = diskIo, warn = defaultWarn): SessionLabels {
  let labels = new Map<string, string>();
  // No path is no file: nothing to read, ever, and every name prints as itself.
  if (path === null) return { refresh: async () => {}, labelOf: (name) => labels.get(name) };
  const read = createOperatorFileReader(path, validateSessionLabels, io, warn);
  return {
    async refresh() {
      const rows = await read();
      // A later row for the same name wins, as TOML itself would refuse the duplicate key anyway.
      labels = new Map(rows.map((row) => [row.name, row.label]));
    },
    labelOf: (name) => labels.get(name),
  };
}

/**
 * The snapshot's `sessions` with each labelled entry carrying its `label`. An entry the operator gave
 * no label is passed through as the same object, so an install with no `sessions.toml` sends the
 * bytes it always sent (solo-baseline.test.ts).
 */
export function withSessionLabels(
  entries: readonly SessionEntry[],
  labelOf: (name: string) => string | undefined,
): SessionEntry[] {
  return entries.map((entry) => {
    const label = labelOf(entry.name);
    return label === undefined ? entry : { ...entry, label };
  });
}
