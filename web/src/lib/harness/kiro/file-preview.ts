interface FilePreview {
  start: number;
  end: number;
}

const MAX_PREVIEW_ROWS = 30;

/** Find a complete pending file-tool preview immediately above its approval panel. A read keeps its range; an edit must show every added and removed line. */
export function readFilePreview(rows: string[], panelTop: number, capability: string): FilePreview | null {
  if (rows[panelTop - 1] !== "") return null;
  const end = panelTop - 2;
  let start = end;
  while (start >= 0 && !rows[start]?.startsWith("↓ ")) {
    if (end - start >= MAX_PREVIEW_ROWS || !rows[start]?.startsWith("  ")) return null;
    start--;
  }
  if (start < 0 || end - start >= MAX_PREVIEW_ROWS) return null;
  const preview = rows.slice(start, end + 1);
  const first = preview[0] ?? "";
  if (capability === "fs_read") {
    if (!first.startsWith("↓ Read ")) return null;
    if (preview.slice(1).some((row) => !/^ {2}\S/.test(row))) return null;
    if (!/ \(L\d+-\d+\)$/.test(preview.at(-1) ?? "")) return null;
    return { start, end };
  }

  if (capability !== "fs_write" || !first.startsWith("↓ Write ")) return null;
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
  return { start, end };
}
