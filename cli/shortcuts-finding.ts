// `shortcuts-file` — the lines of the operator's `shortcuts.toml` that Collie dropped (M108).
//
// One warn row, and none at all for a missing file or a clean one, so a machine that never met the
// file reads exactly as before. The row names each dropped entry and the reason, the same words the
// in-app Shortcuts list shows; the rest of the file still loads, so the remedy says to fix the lines.

import { warn, type Finding } from "./finding.ts";
import { readShortcutsReport } from "./shortcuts-file.ts";
import type { Files } from "./sys.ts";

const CHECK = "shortcuts-file";

export function shortcutsFinding(input: { configDir: string; files: Files }): Finding[] {
  const report = readShortcutsReport(input);
  if (report === null || report.lines.length === 0) return [];
  return [warn(CHECK, `${report.path}: ${report.lines.join(" · ")}`, "fix or remove those lines: Collie drops them and keeps the rest of the file")];
}
