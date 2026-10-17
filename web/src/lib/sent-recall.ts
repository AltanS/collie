import type { Scope } from "./scope";
import type { SentEntry } from "./types";

// THE PURE HALF OF SENT (M61 spec 02): how the arrow keys step through lines, how a page is added to
// a page, and how a row names its folder and its machine. Nothing here touches the network, the
// document or storage; the sheet (components/sent-sheet.tsx) and the composer hook
// (hooks/use-sent-recall.ts) call it.

/** The lines an ArrowUp walks, newest first: this folder's, then the rest of this machine's. */
export function recallLines(folder: readonly SentEntry[], machine: readonly SentEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...folder, ...machine]) {
    if (seen.has(entry.line)) continue;
    seen.add(entry.line);
    out.push(entry.line);
  }
  return out;
}

/** Where the walk stands: a position in the lines, or `EMPTY_DRAFT` for the empty box before it began. */
export const EMPTY_DRAFT = -1;

/** One key. ArrowUp goes to an older line, ArrowDown to a newer one. */
export type RecallKey = "ArrowUp" | "ArrowDown";

/**
 * The next position. ArrowUp from the empty box lands on the newest line and stops at the oldest;
 * ArrowDown steps back toward the empty box and stops there. No lines: the box stays empty.
 */
export function stepRecall(position: number, key: RecallKey, count: number): number {
  if (count <= 0) return EMPTY_DRAFT;
  if (key === "ArrowUp") return Math.min(position + 1, count - 1);
  return Math.max(position - 1, EMPTY_DRAFT);
}

/** What the box shows at a position: the line, or nothing at the empty box. */
export function recallText(lines: readonly string[], position: number): string {
  return lines[position] ?? "";
}

/** A row's identity: a line id is stable per machine, and two machines may share one. */
export function sentKey(entry: Pick<SentEntry, "host" | "id">): string {
  return `${entry.host}\u0000${entry.id}`;
}

/**
 * A page after the one on screen. The bridge cuts a page by record time and merges repeats within
 * the page, so a line seen again on a later page is an OLDER run of a line already shown. The row
 * on screen already carries its newest time, and stays.
 */
export function appendPage(shown: readonly SentEntry[], page: readonly SentEntry[]): SentEntry[] {
  const keys = new Set(shown.map(sentKey));
  return [...shown, ...page.filter((entry) => !keys.has(sentKey(entry)))];
}

/** The rows left after one line is forgotten on one machine. */
export function withoutEntry(shown: readonly SentEntry[], gone: Pick<SentEntry, "host" | "id">): SentEntry[] {
  const key = sentKey(gone);
  return shown.filter((entry) => sentKey(entry) !== key);
}

/** What a row prints for its folder, and the whole path to show on hover when the print is shortened. */
export interface FolderLabel {
  text: string;
  title: string | undefined;
}

/**
 * A folder for a row's second line. Home (`null`) is `~`. A deep path keeps its last two folders,
 * the part a person recognises, behind an ellipsis; `title` holds the whole path.
 */
export function folderLabel(cwd: string | null): FolderLabel {
  if (cwd === null) return { text: "~", title: undefined };
  const parts = cwd.split("/").filter((part) => part !== "");
  if (parts.length <= 2) return { text: cwd, title: undefined };
  return { text: `…/${parts.slice(-2).join("/")}`, title: cwd };
}

/**
 * The scope a write to one row's machine carries. The row's `host` is a machine id the crew uses; the
 * lead is addressed by no `host` at all, and a solo bridge (no lead named) likewise. Only a member
 * gets one.
 */
export function scopeOfHost(host: string, lead: string | undefined): Scope | undefined {
  return lead === undefined || host === lead ? undefined : { host };
}
