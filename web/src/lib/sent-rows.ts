import type { Scope } from "./scope";
import type { SentEntry } from "./types";

// THE ROWS OF THE SENT SHEET, as pure functions (M61 spec 02): how a page is added to a page, how a
// row names its folder, and which machine a write to a row goes to. Nothing here touches the
// network, the document or storage; the sheet (components/sent-sheet.tsx) and its list hook
// (hooks/use-sent-list.ts) call it.

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
