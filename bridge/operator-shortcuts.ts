import type { JsonValue } from "./json.ts";
import { createOperatorFileReader, diskIo, type OperatorFileIo } from "./operator-file.ts";
import type { OperatorShortcuts } from "./types.ts";

// The operator's own keyboard shortcuts, read from `shortcuts.toml` next to their `.env`, the sibling
// of `keys.toml` and the rest, down to the discovery rule and the mtime-checked live reload
// (operator-file.ts owns both).
//
// THE BRIDGE DOES NOT KNOW THE GRAMMAR. A binding is a string like `prefix+c` or `ctrl+alt+c`, and
// the web app is the one place that parses it, merges it with its own default table and words the
// diagnostics (web/src/lib/shortcuts/). This module only decides the SHAPE of the file: a `[keys]`
// table whose names look like action names and whose values are a string or a list of strings. It
// holds no action list either, so a name the app does not know travels to the app, which reports it.
//
// The table is named `[keys]` on purpose: it is the name Herdr's own config uses, so a person can
// copy a block from their Herdr file. It has nothing to do with `keys.toml`'s `[[keys]]` rows.

/** A parsed `shortcuts.toml` document, before a byte of it is believed. */
interface ShortcutsDocument {
  keys?: JsonValue;
}

/** An action name: lower-case words joined by `_` (`new_tab`, `focus_pane_left`, `prefix`). */
const ACTION_NAME = /^[a-z_]+$/;

/**
 * Turn a parsed TOML document into the operator's bindings, or null when the file holds no `[keys]`
 * table (the wire then carries no field at all, so an instance without the file is unchanged).
 *
 * Pure and total: it never throws and never reads a file. Every rejection is a DROP of the one
 * entry, never of the file, so a typo on one line does not cost the operator the rest of their
 * bindings. A string becomes a one-item list, and `""` becomes `[]`, which the app reads as
 * "unbound".
 *
 * ```toml
 * [keys]
 * prefix = "ctrl+b"                       # a string, or a list
 * new_tab = ["prefix+c", "ctrl+alt+c"]
 * zen_mode = ""                               # unbind
 * ```
 *
 * The list is returned as a one-element array so it can ride the shared reader, which holds rows.
 */
export function validateOperatorShortcuts(
  doc: ShortcutsDocument | null | undefined,
  warn = defaultWarn,
): OperatorShortcuts[] {
  const table = doc?.keys;
  if (table === undefined || table === null) return [];
  if (typeof table !== "object" || Array.isArray(table)) {
    warn("`keys` must be a [keys] table, ignoring the file's bindings");
    return [];
  }
  const entries = new Map<string, string[]>();
  for (const [name, value] of Object.entries(table)) {
    if (!ACTION_NAME.test(name)) {
      warn(`ignoring "${name}", an action name is lower-case letters and underscores`);
      continue;
    }
    const bindings = readBindings(value);
    if (bindings === null) {
      warn(`ignoring "${name}", its value must be a string or a list of strings`);
      continue;
    }
    entries.set(name, bindings);
  }
  // `fromEntries` defines own properties, so a name like `__proto__` stays plain data.
  return [Object.fromEntries(entries)];
}

/** A string becomes a one-item list (`""` becomes `[]`); a list of strings is kept; else null. */
function readBindings(value: JsonValue | undefined): string[] | null {
  if (typeof value === "string") return value === "" ? [] : [value];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    out.push(entry);
  }
  return out;
}

function defaultWarn(message: string): void {
  console.warn(`[shortcuts] ${message}`);
}

/**
 * A reader for the operator's `shortcuts.toml`: the same mtime cache, the same "no file is not an
 * error" rule and the same hold-the-last-good-bindings failure posture the other files get, because
 * it is literally the same reader (operator-file.ts). It answers null when there is no `[keys]`
 * table to send.
 */
export function createOperatorShortcuts(
  path: string,
  io: OperatorFileIo = diskIo,
  warn = defaultWarn,
): () => Promise<OperatorShortcuts | null> {
  const read = createOperatorFileReader(path, validateOperatorShortcuts, io, warn);
  return async () => (await read())[0] ?? null;
}
