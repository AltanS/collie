import { HILL_GROUP_PARTS } from "../../web/src/lib/hill/wire.ts";
import { DECISION_VIEW_LIMITS, DIFF_LIMITS, TABLE_LIMITS, VIEW_LIMITS, type View, type ViewNode } from "../../web/src/lib/tricks/schema.ts";
import { looksBinary } from "../changes.ts";
import { MANIFEST_FILE } from "./paths.ts";
import { HELPER_FILE, shippedHelperVersion } from "./scan.ts";
import type { ProposedFile } from "./propose-wire.ts";
import { bytesOf, cellPath, checked, countCell } from "./version-card.ts";
import { readViewLine, VIEW_GAP_MAX, type ChangedFile, type VersionDiff } from "./version-diff.ts";

// A GROUP OF CARDS (crew slice 8): the code of a trick that does not fit one card, shown whole on up to
// seven more. Card 1 is Collie's facts (proposal-card.ts, version-card.ts); this module lays out cards 2
// to n and the file table card 1 shows.
//
// ── THE ORDER ──────────────────────────────────────────────────────────────────────────────────────
// Whole files, one after another: `trick.toml` first, then the file the manifest's `run` names, then the
// rest by path in byte order. A file longer than the room left on a card goes on on the next one: the
// card ends with "continues on the next card" and the next starts with "continued from the last card".
//
// ── NOTHING IS LEFT OUT ────────────────────────────────────────────────────────────────────────────
// Every line of every file is on a card. A line longer than a diff row ({@link DIFF_LIMITS}.lineChars)
// goes on in the rows after it, each starting with its sign and {@link GROUP_WRAP}. A line the bridge
// masks (a key) or whose characters the view refuses (a `?`) is shown as the mask leaves it, and that
// card says so ({@link GROUP_MASKED_NOTE}); a proposal with such a line is refused before any card is
// made (proposals.ts), so only a version the person made by hand ever shows one.
//
// ── THE CAPACITY ───────────────────────────────────────────────────────────────────────────────────
// At most {@link GROUP_CODE_CARDS} cards of code, each at most {@link GROUP_CARD_CODE_BYTES} bytes of
// code text as the card holds it, and each card under the Decision view's own cap. So a group holds at
// most {@link GROUP_CODE_BYTES} bytes of code (42 KiB), and fewer when it has many small files.
//
// ── COLLIE'S OWN HELPER ────────────────────────────────────────────────────────────────────────────
// A top-level `trick.ts` whose bytes are a helper this Collie ships (scan.ts `shippedHelperVersion`, by
// SHA-256, the rule the scan already keeps) is Collie's own code, not the author's: card 1 names it and
// its version, and no card shows its 42 KB. Any other `trick.ts`, a changed helper included, is the
// author's code and shows line by line.

/** Cards of code in a group: every card but card 1. */
export const GROUP_CODE_CARDS = HILL_GROUP_PARTS.max - 1;
/** Bytes of code text one card holds, as the view's JSON text counts them (a quote or a backslash twice). */
export const GROUP_CARD_CODE_BYTES = 6 * 1024;
/** The most code a group shows: {@link GROUP_CODE_CARDS} cards of {@link GROUP_CARD_CODE_BYTES}, 42 KiB. */
export const GROUP_CODE_BYTES = GROUP_CODE_CARDS * GROUP_CARD_CODE_BYTES;
/** The most files a group shows; each needs its own diff, and card 1 lists them all. */
export const GROUP_FILES_MAX = 64;

/** Card 1's words for Collie's own helper, in the Card column and below the file count. */
export function helperCell(version: number): string {
  return `Collie's helper v${String(version)}`;
}
export function helperNote(version: number): string {
  return `${HELPER_FILE} is the helper Collie ships (v${String(version)}), byte for byte, so no card shows it.`;
}

/** The files of a proposal that are a helper this Collie ships, by path, with the helper's version. */
export function shippedHelpers(files: readonly Pick<ProposedFile, "rel" | "bytes">[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const file of files) {
    if (file.rel !== HELPER_FILE) continue;
    const version = shippedHelperVersion(new TextDecoder().decode(file.bytes));
    if (version !== null) out.set(file.rel, version);
  }
  return out;
}

/** The words at a file's seam between two cards. */
export const GROUP_SEAM_NEXT = "continues on the next card";
export const GROUP_SEAM_LAST = "continued from the last card";
/** The mark at the start of a row that goes on with the line above it. */
export const GROUP_WRAP = "↪";
/** The note on a card that shows a masked line (only a version made by hand). */
export const GROUP_MASKED_NOTE = "Some text on this card is masked: a key, or a hidden character.";

/**
 * Card 1's sentence for a file with masked lines (only a version made by hand): how many lines, and the
 * file, so the person knows what the masked text on the code cards is and where.
 */
export function maskedLinesNote(rel: string, count: number): string {
  const lines = count === 1 ? "1 line" : `${String(count)} lines`;
  const rest = count === 1 ? "as it is (a key, or a hidden character), so it shows masked." : "as they are (a key, or a hidden character), so they show masked.";
  return `Collie could not show ${lines} of ${cellPath(rel)} ${rest}`;
}

/** The capacity in words, for `collie trick guide` and `collie trick check`. */
export const GROUP_CAPACITY_WORDS = `A proposal shows on at most ${String(GROUP_CODE_CARDS + 1)} cards: card 1 holds the facts, and ${String(GROUP_CODE_CARDS)} cards hold every line of the code, about ${String(GROUP_CARD_CODE_BYTES / 1024)} KB each (${String(GROUP_CODE_BYTES / 1024)} KB in all, ${String(GROUP_FILES_MAX)} files at most). A larger trick, a file that is not text, a line with a key or a hidden character, or a run of more than ${String(VIEW_GAP_MAX)} spaces cannot be proposed.`;

/** The refusals of a proposal whose code no group can show as it is. */
export const GROUP_TOO_LARGE = "This trick is too large to show on the phone, so it was not proposed. Ask your person to add it on the machine.";
export const GROUP_MASKED = "This trick holds text that a card cannot show as it is (a key, or a hidden character), so it was not proposed. Ask your person to add it on the machine.";
export const GROUP_NOT_TEXT = "This trick holds a file that a card cannot show as text, so it was not proposed. Ask your person to add it on the machine.";
/**
 * The refusal of a proposal whose only text a card cannot show is a carriage return inside a line: a file
 * saved with old or mixed line ends. A file with plain Windows line ends (CRLF) is proposed: the CR of a
 * CRLF line end is the line's end, and it hides nothing (version-diff.ts `readViewLine`).
 */
export function groupLineEnds(rel: string): string {
  return `This trick holds a file with old or mixed line ends (${cellPath(rel)}), so it was not proposed. Save it with Unix line ends, or ask your person to add it on the machine.`;
}
export const GROUP_WIDE_GAP = `This trick holds a line with a run of more than ${String(VIEW_GAP_MAX)} spaces, which pushes code out of sight on a phone, so it was not proposed. Shorten the run, or ask your person to add it on the machine.`;

/** One file's rows for the cards: diff lines with their sign, and whether any was masked. */
export interface GroupFile {
  rel: string;
  rows: string[];
  masked: boolean;
}

/** Where each file shows: the first and last card, counting card 1. */
export type GroupPlaces = ReadonlyMap<string, { first: number; last: number }>;

export type GroupCode = { ok: true; cards: View[]; places: GroupPlaces } | { ok: false; why: "too_large" };

/** A file as a new proposal adds it: every line as a `+` row, masked as the diff masks, or null for a file that is not UTF-8 text. */
export function addedFile(file: Pick<ProposedFile, "rel" | "bytes">): ChangedFile {
  const none: ChangedFile = { rel: file.rel, change: "added", plus: null, minus: 0, hunk: null };
  if (looksBinary(file.bytes)) return none;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    return none;
  }
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const read = lines.map((line) => readViewLine(line));
  const hunk = [`@@ -0,0 +1,${String(read.length)} @@`, ...read.map((line) => `+${line.line}`)];
  const changed: ChangedFile = { rel: file.rel, change: "added", plus: read.length, minus: 0, hunk };
  const masked = read.filter((line) => line.masked);
  if (masked.length > 0) {
    changed.cut = true;
    changed.masked = masked.length;
  }
  if (masked.length > 0 && masked.every((line) => line.strayCr)) changed.strayCr = true;
  if (read.some((line) => line.gap)) changed.gap = true;
  return changed;
}

/** The diff of a new proposal, from its files' bytes: no git, every file added. */
export function addedDiff(files: readonly Pick<ProposedFile, "rel" | "bytes">[]): VersionDiff {
  return { files: files.map((file) => addedFile(file)), counted: true };
}

/** The file the manifest's `run` names, if it is one of `rels`. */
function runFile(run: string, rels: ReadonlySet<string>): string | null {
  for (const word of run.split(/\s+/u)) {
    const rel = word.replace(/^\.\//u, "");
    if (rels.has(rel)) return rel;
  }
  return null;
}

/**
 * The files in a group's order: `lead` first (an agent view's rules on a version card), then the manifest,
 * the run file, then by path in byte order.
 */
export function groupOrder<T extends { rel: string }>(files: readonly T[], run: string | null, lead: readonly string[] = []): T[] {
  const rels = new Set(files.map((file) => file.rel));
  const first = [...lead, MANIFEST_FILE, run === null ? null : runFile(run, rels)];
  const rank = (rel: string): number => {
    const at = first.indexOf(rel);
    return at < 0 ? first.length : at;
  };
  return files.toSorted((a, b) => rank(a.rel) - rank(b.rel) || (a.rel === b.rel ? 0 : a.rel < b.rel ? -1 : 1));
}

/** A row longer than a diff row, as rows: the first as it starts, the rest with its sign and {@link GROUP_WRAP}. */
export function wrapRow(row: string): string[] {
  const chars = [...row];
  if (chars.length <= DIFF_LIMITS.lineChars) return [row];
  const sign = chars[0] ?? " ";
  const rows = [chars.slice(0, DIFF_LIMITS.lineChars).join("")];
  const room = DIFF_LIMITS.lineChars - 2;
  for (let at = DIFF_LIMITS.lineChars; at < chars.length; at += room) rows.push(`${sign}${GROUP_WRAP}${chars.slice(at, at + room).join("")}`);
  return rows;
}

/** A changed file's rows for the cards, or null when it has none to show (not text, not read). */
export function groupFile(file: ChangedFile): GroupFile | null {
  if (file.hunk === null) return null;
  return { rel: file.rel, rows: file.hunk.flatMap((row) => wrapRow(row)), masked: file.cut === true };
}

/** The bytes of code text one row takes on a card, as the JSON text holds it. */
function rowBytes(row: string): number {
  return new TextEncoder().encode(JSON.stringify(row)).byteLength - 1;
}

const note = (text: string): ViewNode => ({ kind: "line", text, attrs: { role: "note" } });

/** Whether a view is within a card's root count and byte cap. */
function fits(view: View): boolean {
  return view.length <= VIEW_LIMITS.root.max && bytesOf(view) <= DECISION_VIEW_LIMITS.bytes;
}

/**
 * Lay the files out on cards 2 to n, in order, every row on a card. Too large when they need more than
 * {@link GROUP_CODE_CARDS} cards.
 */
export function packCode(files: readonly GroupFile[]): GroupCode {
  const cards: View[] = [];
  const places = new Map<string, { first: number; last: number }>();
  let card: ViewNode[] = [];
  let code = 0;
  let masked = false;
  // The card in hand, as it would close: a masked card says so first.
  const closing = (extra: readonly ViewNode[]): View => [...(masked ? [note(GROUP_MASKED_NOTE)] : []), ...card, ...extra];
  const close = (extra: readonly ViewNode[]): boolean => {
    const view = checked(closing(extra));
    if (view === undefined) return false;
    cards.push(view);
    card = [];
    code = 0;
    masked = false;
    return cards.length <= GROUP_CODE_CARDS;
  };
  for (const file of files) {
    let rows: string[] = [];
    const diff = (lines: readonly string[]): ViewNode => ({ kind: "diff", text: lines.join("\n"), attrs: { file: cellPath(file.rel) } });
    const flush = (): void => {
      if (rows.length > 0) card.push(diff(rows));
      rows = [];
    };
    for (const row of file.rows) {
      if (rows.length >= DIFF_LIMITS.lines) flush();
      const size = rowBytes(row) + 1;
      if (code + size > GROUP_CARD_CODE_BYTES || !fits([...closing([]), diff([...rows, row]), note(GROUP_SEAM_NEXT)])) {
        // The card is full. A file already on it goes on on the next one, and both cards say so.
        const seam = places.get(file.rel)?.last === cards.length + 2;
        flush();
        if (!close(seam ? [note(GROUP_SEAM_NEXT)] : [])) return { ok: false, why: "too_large" };
        if (seam) card.push(note(GROUP_SEAM_LAST));
      }
      rows.push(row);
      code += size;
      masked ||= file.masked;
      const number = cards.length + 2;
      places.set(file.rel, { first: places.get(file.rel)?.first ?? number, last: number });
    }
    flush();
  }
  if (card.length > 0 && !close([])) return { ok: false, why: "too_large" };
  return cards.length <= GROUP_CODE_CARDS ? { ok: true, cards, places } : { ok: false, why: "too_large" };
}

/** "card 2" or "cards 2 to 4". */
export function cardsWords(place: { first: number; last: number }): string {
  return place.first === place.last ? `card ${String(place.first)}` : `cards ${String(place.first)} to ${String(place.last)}`;
}

/** "812 B", "1.2 KB", "14 KB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  return kb < 10 ? `${kb.toFixed(1)} KB` : `${String(Math.round(kb))} KB`;
}

/** The file tables of card 1: File, a size or change column or two, and Card; 12 rows a table. */
export function placesTables(rows: readonly { rel: string; cells: readonly string[] }[], heads: readonly string[], places: GroupPlaces, helpers: ReadonlyMap<string, number> = new Map()): ViewNode[] {
  const tables: ViewNode[] = [];
  for (let at = 0; at < rows.length; at += TABLE_LIMITS.rows.max) {
    const kids: ViewNode[] = [{ kind: "col", text: "File" }, ...heads.map((head): ViewNode => ({ kind: "col", text: head })), { kind: "col", text: "Card" }];
    for (const row of rows.slice(at, at + TABLE_LIMITS.rows.max)) {
      const place = places.get(row.rel);
      const helper = helpers.get(row.rel);
      const where = helper !== undefined ? helperCell(helper) : place === undefined ? "" : place.first === place.last ? String(place.first) : `${String(place.first)} to ${String(place.last)}`;
      kids.push({ kind: "cell", text: cellPath(row.rel) }, ...row.cells.map((cell): ViewNode => ({ kind: "cell", text: cell })), { kind: "cell", text: where });
    }
    tables.push({ kind: "table", kids });
  }
  return tables;
}

/** "7 files, on cards 2 to 4." */
export function filesOnCards(count: number, cards: number): string {
  const files = count === 1 ? "1 file" : `${String(count)} files`;
  return cards === 1 ? `${files}, on card 2.` : `${files}, on cards 2 to ${String(cards + 1)}.`;
}

/** The Change cell: "changed", or "changed +x" when the file also became executable (review 7). */
export function changeWord(file: ChangedFile): string {
  return file.mode === undefined ? file.change : `${file.change} ${file.mode}`;
}

/** A row of the version table: the change and its line counts. */
export function changeCells(file: ChangedFile): string[] {
  return [changeWord(file), [countCell(file.plus, "+"), countCell(file.minus, "−")].filter((cell) => cell !== "").join(" ")];
}

/** Why a proposal's code cannot show as a group: a refusal code of the propose wire and its words. */
export interface GroupRefusal {
  code: "too_large" | "cannot_show";
  error: string;
}

/**
 * The code cards of a group for `files` in the group's order, or why there can be none. `masked`:
 * "refuse" for a proposal (a masked line is not the code as it is), "show" for a version the person
 * made by hand, whose cards then say so. `helpers`: the files that are Collie's own helper, left off.
 */
export function codeGroup(files: readonly ChangedFile[], run: string | null, masked: "refuse" | "show", helpers: ReadonlyMap<string, number> = new Map(), lead: readonly string[] = []): ({ ok: true } & Extract<GroupCode, { ok: true }>) | ({ ok: false } & GroupRefusal) {
  if (files.length > GROUP_FILES_MAX) return { ok: false, code: "too_large", error: GROUP_TOO_LARGE };
  // Collie's own helper is named on card 1, never laid out.
  const ordered = groupOrder(files, run, lead).filter((file) => !helpers.has(file.rel));
  const read: GroupFile[] = [];
  for (const file of ordered) {
    const one = groupFile(file);
    if (one === null) return { ok: false, code: "cannot_show", error: GROUP_NOT_TEXT };
    read.push(one);
  }
  // Too large first: a cut git output is far past the capacity, and is no masked line.
  if (read.reduce((sum, file) => sum + file.rows.reduce((bytes, row) => bytes + rowBytes(row) + 1, 0), 0) > GROUP_CODE_BYTES) return { ok: false, code: "too_large", error: GROUP_TOO_LARGE };
  if (masked === "refuse" && read.some((file) => file.masked)) {
    // Line ends alone get their own words and the file; a key or any other hidden character the general ones.
    const cut = ordered.filter((file) => file.cut === true);
    const lineEnds = cut.length > 0 && cut.every((file) => file.strayCr === true);
    return { ok: false, code: "cannot_show", error: lineEnds ? groupLineEnds(cut[0]?.rel ?? "") : GROUP_MASKED };
  }
  const packed = packCode(read);
  return packed.ok ? packed : { ok: false, code: "too_large", error: GROUP_TOO_LARGE };
}
