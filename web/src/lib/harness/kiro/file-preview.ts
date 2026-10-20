// The pending tool preview Kiro prints above a filesystem approval panel: a `↓ Read` or `↓ Write`
// header and its indented rows. The panel itself names only the path, so the preview is what binds a
// tap to one read range or one diff.

interface FilePreview {
  start: number;
  end: number;
}

const MAX_PREVIEW_ROWS = 30;

/** The rows of the pending tool's preview: a `↓ ` header, its indented rows, and one blank row above the panel. */
function previewAbove(rows: string[], panelTop: number): FilePreview | null {
  if (rows[panelTop - 1] !== "") return null;
  const end = panelTop - 2;
  let start = end;
  while (start >= 0 && !rows[start]?.startsWith("↓ ")) {
    if (end - start >= MAX_PREVIEW_ROWS || !rows[start]?.startsWith("  ")) return null;
    start--;
  }
  if (start < 0 || end - start >= MAX_PREVIEW_ROWS) return null;
  return { start, end };
}

/** Find a complete pending read preview immediately above its approval panel; it must end with the read range. */
export function findReadPreview(rows: string[], panelTop: number): FilePreview | null {
  const found = previewAbove(rows, panelTop);
  if (found === null) return null;
  const preview = rows.slice(found.start, found.end + 1);
  if (!(preview[0] ?? "").startsWith("↓ Read ")) return null;
  if (preview.slice(1).some((row) => !/^ {2}\S/.test(row))) return null;
  if (!/ \(L\d+-\d+\)$/.test(preview.at(-1) ?? "")) return null;
  return found;
}

/** Find a complete pending write or replace preview immediately above its approval panel; it must show every added and removed line. */
export function findWritePreview(rows: string[], panelTop: number): FilePreview | null {
  const found = previewAbove(rows, panelTop);
  if (found === null) return null;
  const preview = rows.slice(found.start, found.end + 1);
  if (!(preview[0] ?? "").startsWith("↓ Write ")) return null;
  const summaryIndex = preview.findIndex((row) => row.startsWith("    added "));
  if (summaryIndex < 1) return null;
  if (preview.slice(1, summaryIndex).some((row) => !/^ {2}\S/.test(row))) return null;
  const summary = /^ {4}added (\d+) lines?(?:, removed (\d+) lines?)? in \S.*$/.exec(preview[summaryIndex] ?? "");
  if (summary === null) return null;
  let added = 0;
  let removed = 0;
  for (const row of preview.slice(summaryIndex + 1)) {
    // A replace shows an unchanged neighbouring line as its bare line number.
    if (/^ {1,5}\d{1,5}$/.test(row) && row.length === 6) continue;
    // The code follows two spaces after the marker and keeps its own indentation; a blank
    // added or removed line is the marker alone once trailing padding is trimmed.
    const diff = /^( {1,5}\d{1,5})([+-])(?: {2}.*)?$/.exec(row);
    // Installed V3 right-aligns line numbers before the fixed marker column, including 10+.
    if (diff === null || diff[1]?.length !== 6) return null;
    if (diff[2] === "+") added++;
    else removed++;
  }
  if (added !== Number(summary[1]) || removed !== Number(summary[2] ?? 0)) return null;
  return found;
}
