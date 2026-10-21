// The pending tool preview Kiro prints above an approval panel: a `↓ Shell`, `↓ Read` or `↓ Write`
// header and its indented rows. A file panel names only the path and a shell panel only the command,
// so the preview is what binds a tap to one read range, one diff, or one set of shell arguments. A
// preview binds only when it names the panel's own path or command: a preview of another call
// directly above the panel would otherwise show one request while Allow approves the other.
//
// How kiro-cli 2.32.0 prints a shell call, from the `kiro--v3-{approval,shell}-*` captures:
// - The panel body row 0 is ` shell → printf collie_args_probe &`, the command alone. A long
//   command word-wraps onto further body rows that start with one space (`shell-wrapped-*`).
// - The preview header is `↓ Shell printf collie_args_probe &`, the same command, wrapping onto rows
//   indented by two spaces. Below it, `    ╰ description=…, cwd=sub, run_in_background=true,
//   timeout=5000` lists every other argument the call set, wrapping onto rows indented by six. Two
//   calls that differ only in `cwd` or `timeout` draw the same panel, so the preview is the only
//   place the phone can show and bind them (`shell-args-*`).
//
// How kiro-cli 2.32.0 prints the path, from the `kiro--v3-{read,write,replace}-*` captures:
// - The panel body row 0 is ` fs_read → read-once.txt` or ` fs_write → replace.txt`: the path as
//   the tool named it, relative to the cwd. A long path word-wraps onto further body rows that
//   start with one space (`read-wrapped-*-w60`).
// - The preview header is `↓ Read /workspace/…/files-v3/read-once.txt (L1-1)` or
//   `↓ Write /workspace/…/files-v3/replace.txt`: the absolute path, so it ends with `/` and the
//   panel's path. It wraps onto rows indented by two spaces, between words or inside an overlong
//   word (`demo-se` / `ssion-fixture` at 60 columns).
// - The write summary row is `    added 1 line, removed 1 line in replace.txt`: the panel's path.
// A wrapped row loses its trailing space once padding is trimmed, so a wrap boundary on either
// side matches one space or none on the other side. Every other character must match.

interface ToolPreview {
  start: number;
  end: number;
}

const MAX_PREVIEW_ROWS = 30;
const WRAP = "\n";

/** What a panel names, a command or a path: body row 0 after `shell → `, `fs_read → ` or `fs_write → `, with its wrapped rows. */
export function panelSubject(body: string[]): string | null {
  const first = /^ (?:shell|fs_read|fs_write) → (\S.*)$/.exec(body[0] ?? "")?.[1];
  if (first === undefined) return null;
  return [first, ...body.slice(1).map((row) => row.slice(1))].join(WRAP);
}

/**
 * Whether `outer` ends with `inner` (whole, or after a `/` when `afterSlash`), where each holds its
 * wrap boundaries as `\n`. A boundary never touches a space on its own side (rows are trimmed and
 * start with a visible character), so walking from the end it either takes the other side's
 * space or nothing, with no choice to make.
 */
function sameWrappedText(outer: string, inner: string, afterSlash: boolean): boolean {
  let i = outer.length - 1;
  let j = inner.length - 1;
  while (j >= 0) {
    if (i < 0) return false;
    const a = outer[i];
    const b = inner[j];
    if (a === WRAP && b === WRAP) {
      i--;
      j--;
    } else if (a === WRAP) {
      if (b === " ") j--;
      i--;
    } else if (b === WRAP) {
      if (a === " ") i--;
      j--;
    } else if (a === b) {
      i--;
      j--;
    } else return false;
  }
  while (outer[i] === WRAP) i--;
  return i < 0 || (afterSlash && outer[i] === "/");
}

/** The command or path a preview header names: the header row after its `↓ ` lead, and the two-space continuation rows. */
function headerText(header: string[], lead: string): string {
  return [header[0]?.slice(lead.length) ?? "", ...header.slice(1).map((row) => row.slice(2))].join(WRAP);
}

/** The rows of the pending tool's preview: a `↓ ` header, its indented rows, and one blank row above the panel. */
function previewAbove(rows: string[], panelTop: number): ToolPreview | null {
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

/** Find a complete pending read preview immediately above its approval panel; it must end with the read range and name `path`. */
export function findReadPreview(rows: string[], panelTop: number, path: string): ToolPreview | null {
  const found = previewAbove(rows, panelTop);
  if (found === null) return null;
  const preview = rows.slice(found.start, found.end + 1);
  if (!(preview[0] ?? "").startsWith("↓ Read ")) return null;
  if (preview.slice(1).some((row) => !/^ {2}\S/.test(row))) return null;
  if (!/ \(L\d+-\d+\)$/.test(preview.at(-1) ?? "")) return null;
  const header = headerText(preview, "↓ Read ").replace(/ \(L\d+-\d+\)$/, "");
  if (!sameWrappedText(header, path, true)) return null;
  return found;
}

/** Find a complete pending write or replace preview immediately above its approval panel; it must show every added and removed line and name `path`. */
export function findWritePreview(rows: string[], panelTop: number, path: string): ToolPreview | null {
  const found = previewAbove(rows, panelTop);
  if (found === null) return null;
  const preview = rows.slice(found.start, found.end + 1);
  if (!(preview[0] ?? "").startsWith("↓ Write ")) return null;
  const summaryIndex = preview.findIndex((row) => row.startsWith("    added "));
  if (summaryIndex < 1) return null;
  if (preview.slice(1, summaryIndex).some((row) => !/^ {2}\S/.test(row))) return null;
  const summary = /^ {4}added (\d+) lines?(?:, removed (\d+) lines?)? in (\S.*)$/.exec(preview[summaryIndex] ?? "");
  if (summary === null) return null;
  if (!sameWrappedText(headerText(preview.slice(0, summaryIndex), "↓ Write "), path, true)) return null;
  if (!sameWrappedText(summary[3] ?? "", path, false)) return null;
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

/** Find a complete pending shell preview immediately above its approval panel; its header must name `command`. */
export function findShellPreview(rows: string[], panelTop: number, command: string): ToolPreview | null {
  const found = previewAbove(rows, panelTop);
  if (found === null) return null;
  const preview = rows.slice(found.start, found.end + 1);
  if (!(preview[0] ?? "").startsWith("↓ Shell ")) return null;
  let argsIndex = 1;
  while (argsIndex < preview.length && /^ {2}\S/.test(preview[argsIndex] ?? "")) argsIndex++;
  if (!sameWrappedText(headerText(preview.slice(0, argsIndex), "↓ Shell "), command, false)) return null;
  // Every captured call has the arguments row: Kiro fills in `run_in_background=false` when the
  // model leaves it out (`shell-bare-allow-w120`).
  const args = preview.slice(argsIndex);
  if (!/^ {4}╰ \S/.test(args[0] ?? "") || args.slice(1).some((row) => !/^ {6}\S/.test(row))) return null;
  return found;
}
