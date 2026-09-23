// A unified diff, read into rows the Changes view draws (ADR 0065). Hand-rolled on purpose: the view
// shows plain monospace rows with two line-number gutters, so it needs hunk headers and line kinds
// and nothing a diff library would add. The bridge sends git's raw text; this is the whole parser.
//
// File header lines (`diff --git`, `index`, `---`, `+++`, `rename from`, `new file mode` …) are
// skipped: the view already names the file above the diff. A row is only ever rendered as text,
// never as markup.

export type DiffRow =
  | { kind: "hunk"; header: string; oldStart: number; newStart: number }
  | { kind: "context" | "add" | "del"; oldNo: number | null; newNo: number | null; text: string }
  /** `\ No newline at end of file`, attached to the row above it. */
  | { kind: "note"; text: string };

export interface ParsedDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** The highest line number in either gutter, so the view can size both gutters once. */
  maxLineNo: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

export function parseUnifiedDiff(text: string): ParsedDiff {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let maxLineNo = 0;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;

  const lines = text.split("\n");
  // A trailing newline leaves one empty string that is not a row.
  if (lines.at(-1) === "") lines.pop();

  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", header: line, oldStart: oldNo, newStart: newNo });
      continue;
    }
    // A new file section ends the hunk; its header lines are not rows.
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    const sign = line[0];
    const body = line.slice(1);
    if (sign === "+") {
      rows.push({ kind: "add", oldNo: null, newNo, text: body });
      maxLineNo = Math.max(maxLineNo, newNo);
      newNo++;
      added++;
    } else if (sign === "-") {
      rows.push({ kind: "del", oldNo, newNo: null, text: body });
      maxLineNo = Math.max(maxLineNo, oldNo);
      oldNo++;
      removed++;
    } else if (sign === "\\") {
      rows.push({ kind: "note", text: line.slice(2) });
    } else {
      // A context line starts with a space; an empty line inside a hunk is a blank context line
      // whose leading space an editor or a transport trimmed.
      rows.push({ kind: "context", oldNo, newNo, text: sign === " " ? body : line });
      maxLineNo = Math.max(maxLineNo, oldNo, newNo);
      oldNo++;
      newNo++;
    }
  }
  return { rows, added, removed, maxLineNo };
}
