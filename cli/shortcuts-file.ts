// The dropped lines of `shortcuts.toml`, for `collie config check` and `collie doctor` (M108).
//
// The in-app Shortcuts list already names every line Collie dropped. This is the same answer from the
// terminal, built from the same two functions and nothing new: the bridge's `validateOperatorShortcuts`
// (the shape and the caps), then the web app's `buildKeymap` over its own action table (the grammar,
// the browser's reserved chords, the Herdr names). Read-only: it reads one file and writes nothing.

import { join } from "node:path";

import { cleanText } from "../bridge/project-file.ts";
import { validateOperatorShortcuts, type ShortcutsDocument } from "../bridge/operator-shortcuts.ts";
import { ACTIONS } from "../web/src/lib/shortcuts/actions.ts";
import { buildKeymap } from "../web/src/lib/shortcuts/keymap.ts";
import type { Files } from "./sys.ts";

/** A line of the report is cut here, because a binding is file content and may be long. */
const LINE_MAX = 300;

export interface ShortcutsReport {
  readonly path: string;
  /** One line per dropped entry or refused binding, empty for a clean file. */
  readonly lines: readonly string[];
}

/** Where the file lives: next to `keys.toml`, the same folder the bridge reads it from. */
export function shortcutsPath(configDir: string): string {
  return join(configDir, "shortcuts.toml");
}

/** The report for one file's text. Exported for the test, which needs no disk. */
export function shortcutsLines(text: string): string[] {
  const lines: string[] = [];
  let doc: ReturnType<typeof Bun.TOML.parse>;
  try {
    doc = Bun.TOML.parse(text);
  } catch (err) {
    return [cleanText(`could not be parsed (${String(err)})`, LINE_MAX)];
  }
  // SAFETY: `Bun.TOML.parse` answers a plain document object, which is the validator's own input
  // type (bridge/operator-file.ts casts it the same way), and the validator checks every field.
  const [user] = validateOperatorShortcuts(doc as ShortcutsDocument, (message) => lines.push(cleanText(message, LINE_MAX)));
  if (user === undefined) return lines;
  const keymap = buildKeymap({ defaults: ACTIONS, user });
  for (const diagnostic of keymap.diagnostics) lines.push(cleanText(`${diagnostic.code}: ${diagnostic.message}`, LINE_MAX));
  return lines;
}

/** The report for `configDir`'s file, or null when there is no file (the verbs then say nothing). */
export function readShortcutsReport(input: { configDir: string; files: Files }): ShortcutsReport | null {
  const path = shortcutsPath(input.configDir);
  if (!input.files.exists(path)) return null;
  const text = input.files.read(path);
  if (text === null) return { path, lines: ["could not be opened"] };
  return { path, lines: shortcutsLines(text) };
}
