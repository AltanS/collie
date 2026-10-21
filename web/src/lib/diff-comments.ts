import { loadDraftEntry, saveDraft } from "./drafts";
import type { Scope } from "./scope";
import type { DiffRow } from "./unified-diff";

export type DiffCodeRow = Extract<DiffRow, { kind: "context" | "add" | "del" }>;

export interface DiffComment {
  id: number;
  /** The open diff key (`changes\n<repo>\n<path>` or `commit\n<repo>\n<path>`) where this comment was created. */
  fileKey?: string;
  repo: string;
  path: string;
  /** Stable coordinate keys (`diffCommentRowKey`) that this comment covers, in file order. */
  rowKeys: readonly string[];
  /** Human-readable line range, e.g. "+12", "+12–15", "-3, +3–4", or "+2, +10". */
  lineLabel: string;
  /** The quoted diff lines with their +/-/space prefix captured at selection time. */
  linesText: readonly string[];
  /** The operator's comment text. */
  note: string;
}

/**
 * A row key anchored to the line's coordinates (`kind`, `oldNo`, `newNo`) and text, so a 5-second
 * diff poll that inserts identical lines (such as `}`) earlier in the file never shifts a selection
 * or an inline comment onto a different line.
 */
export function diffCommentRowKey(row: DiffCodeRow): string {
  return `${row.kind}:${row.oldNo ?? ""}:${row.newNo ?? ""}:${row.text}`;
}

export function displayDiffPath(repo: string, path: string): string {
  return repo !== "" && repo !== "." ? `${repo.replace(/\/+$/, "")}/${path}` : path;
}

export function formatDiffLineLabel(rows: readonly DiffCodeRow[]): string {
  const ranges: { sign: "+" | "-"; start: number; end: number }[] = [];
  for (const row of rows) {
    const sign: "+" | "-" = row.newNo !== null ? "+" : "-";
    const no = row.newNo ?? row.oldNo ?? 1;
    const prev = ranges.at(-1);
    if (prev !== undefined && prev.sign === sign && no === prev.end + 1) {
      prev.end = no;
    } else {
      ranges.push({ sign, start: no, end: no });
    }
  }
  return ranges
    .map((r) => (r.start === r.end ? `${r.sign}${r.start}` : `${r.sign}${r.start}–${r.end}`))
    .join(", ");
}

export function captureDiffLines(rows: readonly DiffCodeRow[]): string[] {
  return rows.map((row) => {
    const sign = row.kind === "add" ? "+" : row.kind === "del" ? "-" : " ";
    return `${sign}${row.text}`;
  });
}

export function formatDiffComment(
  comment: Pick<DiffComment, "repo" | "path" | "lineLabel" | "linesText" | "note">,
): string {
  const displayPath = displayDiffPath(comment.repo, comment.path);
  const codeQuote = comment.linesText
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
  return `> \`${displayPath}\` (${comment.lineLabel})\n${codeQuote}\n\n${comment.note.trim()}`;
}

export function formatDiffCommentBatch(
  comments: readonly Pick<DiffComment, "repo" | "path" | "lineLabel" | "linesText" | "note">[],
): string {
  return comments.map((c) => formatDiffComment(c)).join("\n\n");
}

export function stageDiffCommentsToDraft(
  scope: Scope | undefined,
  paneId: string,
  comments: readonly DiffComment[],
): void {
  if (comments.length === 0) return;
  const existing = loadDraftEntry(scope, paneId);
  const formatted = formatDiffCommentBatch(comments);
  const head = (existing?.text ?? "").trimEnd();
  const nextText = `${head === "" ? "" : `${head}\n\n`}${formatted}\n\n`;
  saveDraft(scope, paneId, nextText, existing?.attachments ?? [], existing?.next ?? 1);
}
