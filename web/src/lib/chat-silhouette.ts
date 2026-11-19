// THE SILHOUETTE OF A PANE'S CHAT, ON THIS DEVICE: its silhouette, never its words.
//
// While a pane's first Chat page is on its way, the reading area used to draw five short bars at the top
// (components/chat-pending.tsx), and the thread then arrived around them and below, a screen tall. This keeps,
// per pane, what its newest page LOOKED like the last time Chat drew it: the visible rows from the bottom up
// to about two screens, each as a kind, a height and, for text, a line count and the width class of the last
// line. The loading view draws that again, so a pane that is opened a second time shows a ghost of its own
// thread in the first frames, with the newest row where the newest row will be.
//
// WHAT IS STORED IS A FEW SMALL NUMBERS AND ONE WORD OF KIND PER ROW. Never a text, a name, a path, an id or a
// time. {@link parseStored} refuses anything else on the way back in, so a value another build or a tampered
// storage wrote cannot put content on the screen.
//
// KEYED BY THE PANE'S FULL ADDRESS (`paneScopeKey`: machine, session and pane id), like the scroll position and
// the held window. Memory for the page plus sessionStorage, so a reload keeps it and a closed tab does not. At
// most {@link PANES_KEPT} panes: the oldest written is dropped first. Every storage access is behind a
// try/catch: a private-mode browser keeps the memory copy only. It goes with the pairing (lib/wipe.ts).

import type { ChatItem } from "@/lib/chat-items";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJsonObject, type JsonValue } from "@/lib/json";

/** The key prefix. The version is part of it, so a changed silhouette starts empty. */
export const CHAT_SILHOUETTE_PREFIX = "collie:chat-silhouette:v1:";

/** How many panes keep a silhouette. A phone opens a handful in a sitting; forty is more than the switcher lists. */
export const PANES_KEPT = 40;

/** What a row is: the person's message, agent prose, a tool run or lone call's row, a card, anything else (a notice, a rule). */
export type RowKind = "person" | "agent" | "tool" | "card" | "other";

/** How wide a line or a bubble is: 1 narrow, 2 medium, 3 wide. */
export type WidthClass = 1 | 2 | 3;

/** One row, bottom-up slice of a page. `h` is px, rounded to {@link HEIGHT_STEP}. `n` is a text row's line count, `w` its last line's (a person row: its bubble's) width class. */
export interface SilhouetteRow {
  k: RowKind;
  h: number;
  n?: number;
  w?: WidthClass;
}

/** A pane's silhouette. `whole`: the rows are the entire thread, so it starts at the top and does not fill the screen. `rows` run top to bottom, the newest last. */
export interface Silhouette {
  whole: boolean;
  rows: SilhouetteRow[];
}

/** What a stored value holds: the silhouette and a write counter that orders the panes for the cap. */
interface Stored extends Silhouette {
  at: number;
}

/** The only keys a stored value and a stored row may carry. */
const STORED_KEYS: ReadonlySet<string> = new Set(["at", "whole", "rows"]);
const ROW_KEYS: ReadonlySet<string> = new Set(["k", "h", "n", "w"]);

const ROW_KINDS = ["person", "agent", "tool", "card", "other"] as const satisfies readonly RowKind[];

/** Heights are kept in steps of this many px: a ghost does not need the pixel, and equal silhouettes then compare equal. */
export const HEIGHT_STEP = 4;
const MIN_ROW_PX = 8;
const MAX_ROW_PX = 2400;
const MAX_ROWS = 60;
const MAX_LINES = 80;

/** A screen's height when the scroller reports none (a test, a list not laid out yet). */
const FALLBACK_VIEWPORT = 640;

/** How much of the page is kept, in screens of the scroller's height. */
const SCREENS_KEPT = 2;

// ── THE GAPS BETWEEN ROWS ────────────────────────────────────────────────────

/**
 * The air between the contents of two neighbouring blocks, as the stream's default rhythm gives it
 * (session-stream.tsx `rhythmClass`, the `airy` word): a person's message starts 20px under what is above, an agent
 * block under a person's message 12px, and an agent block under another block of the run 8px.
 */
export function gapBefore(previous: RowKind | undefined, current: RowKind): number {
  if (previous === undefined) return 0;
  if (current === "person") return 20;
  if (previous === "person") return 12;
  return 8;
}

/** The height of rows laid one under the other with the stream's gaps. */
export function silhouetteHeight(rows: readonly SilhouetteRow[]): number {
  let total = 0;
  rows.forEach((row, index) => {
    total += row.h + gapBefore(rows[index - 1]?.k, row.k);
  });
  return total;
}

// ── MEASURING A RENDERED PAGE ────────────────────────────────────────────────

/** One block as measured, before it is turned into a row. Fractions are of the column's width. */
export interface MeasuredBlock {
  kind: RowKind;
  height: number;
  lines?: number;
  lastLine?: number;
  width?: number;
}

function roundStep(px: number): number {
  return Math.min(MAX_ROW_PX, Math.max(MIN_ROW_PX, Math.round(px / HEIGHT_STEP) * HEIGHT_STEP));
}

function lastLineClass(fraction: number): WidthClass {
  if (fraction < 0.34) return 1;
  if (fraction < 0.67) return 2;
  return 3;
}

function bubbleClass(fraction: number): WidthClass {
  if (fraction <= 0.45) return 1;
  if (fraction <= 0.7) return 2;
  return 3;
}

function rowOf(block: MeasuredBlock): SilhouetteRow {
  const h = roundStep(block.height);
  if (block.kind === "agent") {
    const n = Math.min(MAX_LINES, Math.max(1, Math.round(block.lines ?? 1)));
    return { k: "agent", h, n, w: lastLineClass(block.lastLine ?? 0.6) };
  }
  if (block.kind === "person") return { k: "person", h, w: bubbleClass(block.width ?? 0.6) };
  return { k: block.kind, h };
}

/**
 * The silhouette of a page, from its blocks in document order (the newest last): the newest rows up to
 * {@link SCREENS_KEPT} screens of height. `count` is how many blocks the thread has. `whole` is true only when every block of it is in and nothing older
 * exists, which is when the thread starts at the top of the screen and does not fill it.
 */
export function silhouetteOf(blocks: readonly MeasuredBlock[], options: { viewport: number; older: boolean; count: number }): Silhouette {
  const limit = (options.viewport > 0 ? options.viewport : FALLBACK_VIEWPORT) * SCREENS_KEPT;
  const kept: SilhouetteRow[] = [];
  for (let i = blocks.length - 1; i >= 0 && kept.length < MAX_ROWS; i--) {
    kept.unshift(rowOf(blocks[i]!));
    if (silhouetteHeight(kept) >= limit) break;
  }
  return { whole: !options.older && kept.length === options.count, rows: kept };
}

/** The last text node of an element that holds a word, or null. */
function lastTextNode(root: Element): Text | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node instanceof Text && node.data.trim() !== "") last = node;
  }
  return last;
}

/** How wide the last line of an element's text is, as a fraction of `column`; 0.6 where the browser cannot say. */
function lastLineFraction(content: Element, column: number): number {
  const text = lastTextNode(content);
  if (text === null || column <= 0) return 0.6;
  const range = content.ownerDocument.createRange();
  range.selectNodeContents(text);
  if (!("getClientRects" in range)) return 0.6;
  const rects = range.getClientRects();
  const last = rects[rects.length - 1];
  if (last === undefined || last.width <= 0) return 0.6;
  return Math.min(1, last.width / column);
}

function pixels(value: string): number {
  const px = Number.parseFloat(value);
  return Number.isFinite(px) ? px : 0;
}

function lineHeightOf(content: Element): number {
  const view = content.ownerDocument.defaultView;
  const style = view === null ? null : view.getComputedStyle(content);
  const own = style === null ? Number.NaN : Number.parseFloat(style.lineHeight);
  if (Number.isFinite(own) && own > 0) return own;
  const size = style === null ? Number.NaN : Number.parseFloat(style.fontSize);
  return Number.isFinite(size) && size > 0 ? size * 1.5 : 22;
}

/**
 * The stream's blocks as measured, in document order, from the scroller's own children. `kinds` is what each block
 * is, from the items it was built from, in the same order. Null when the scroller does not hold exactly those blocks
 * (a render that is between two states): the caller records nothing then. Only the newest blocks up to about
 * {@link SCREENS_KEPT} screens are read, so a long thread costs a few measurements; the rest of the array is padding
 * the silhouette never looks at.
 */
export function measureBlocks(scroller: HTMLElement, kinds: readonly RowKind[]): MeasuredBlock[] | null {
  const nodes = scroller.querySelectorAll<HTMLElement>(":scope > [data-block]");
  if (nodes.length !== kinds.length) return null;
  const viewport = scroller.clientHeight > 0 ? scroller.clientHeight : FALLBACK_VIEWPORT;
  const out: MeasuredBlock[] = [];
  let total = 0;
  for (let i = nodes.length - 1; i >= 0 && total < viewport * SCREENS_KEPT; i--) {
    const node = nodes[i]!;
    const kind = kinds[i]!;
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const padY = pixels(style.paddingTop) + pixels(style.paddingBottom);
    const padX = pixels(style.paddingLeft) + pixels(style.paddingRight);
    const height = Math.max(0, box.height - padY);
    const column = Math.max(0, box.width - padX);
    const content = node.firstElementChild ?? node;
    const measured: MeasuredBlock = { kind, height };
    if (kind === "agent") {
      measured.lines = Math.max(1, Math.round(height / lineHeightOf(content)));
      measured.lastLine = lastLineFraction(content, column);
    }
    if (kind === "person") measured.width = column > 0 ? content.getBoundingClientRect().width / column : 0.6;
    out.unshift(measured);
    total += height + 12;
  }
  return out;
}

// ── WHAT THE STORE ACCEPTS ───────────────────────────────────────────────────

function widthClassOf(value: JsonValue | undefined): WidthClass | undefined {
  const n = asJsonNumber(value);
  if (n === 1 || n === 2 || n === 3) return n;
  return undefined;
}

/** A whole number from `min` to `max`, or undefined. */
function countOf(value: JsonValue | undefined, min: number, max: number): number | undefined {
  const n = asJsonNumber(value);
  if (n === undefined || !Number.isInteger(n) || n < min || n > max) return undefined;
  return n;
}

function parseRow(value: JsonValue | undefined): SilhouetteRow | null {
  const row = asJsonObject(value);
  if (row === undefined || Object.keys(row).some((key) => !ROW_KEYS.has(key))) return null;
  const k = ROW_KINDS.find((kind) => kind === asJsonString(row.k));
  const h = countOf(row.h, MIN_ROW_PX, MAX_ROW_PX);
  if (k === undefined || h === undefined) return null;
  const out: SilhouetteRow = { k, h };
  if (row.n !== undefined) {
    const n = countOf(row.n, 1, MAX_LINES);
    if (n === undefined) return null;
    out.n = n;
  }
  if (row.w !== undefined) {
    const w = widthClassOf(row.w);
    if (w === undefined) return null;
    out.w = w;
  }
  return out;
}

/** A stored value read back, or null when it is not exactly a silhouette: a wrong key, a string where a number goes, too many rows. */
export function parseStored(raw: string): Stored | null {
  const value = parseJsonObject(raw);
  if (value === undefined || Object.keys(value).some((key) => !STORED_KEYS.has(key))) return null;
  const at = asJsonNumber(value.at);
  const whole = asJsonBoolean(value.whole);
  const rows = value.rows;
  if (at === undefined || !Number.isFinite(at) || whole === undefined || !Array.isArray(rows)) return null;
  if (rows.length === 0 || rows.length > MAX_ROWS) return null;
  const parsed: SilhouetteRow[] = [];
  for (const item of rows) {
    const row = parseRow(item);
    if (row === null) return null;
    parsed.push(row);
  }
  return { at, whole, rows: parsed };
}

// ── THE STORE ────────────────────────────────────────────────────────────────

const memory = new Map<string, Stored>();
let lastAt = 0;

function storage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function keyOf(address: string): string {
  return `${CHAT_SILHOUETTE_PREFIX}${address}`;
}

/** The silhouette kept for a pane, or undefined when this device never drew it (or the page was reloaded with storage locked). */
export function recallSilhouette(address: string): Silhouette | undefined {
  const held = memory.get(address);
  if (held !== undefined) return held;
  try {
    const raw = storage()?.getItem(keyOf(address)) ?? null;
    if (raw === null) return undefined;
    const stored = parseStored(raw);
    if (stored === null) return undefined;
    memory.set(address, stored);
    return stored;
  } catch {
    return undefined;
  }
}

function sameRows(a: Silhouette, b: Silhouette): boolean {
  return a.whole === b.whole && a.rows.length === b.rows.length && a.rows.every((row, i) => {
    const other = b.rows[i]!;
    return row.k === other.k && row.h === other.h && row.n === other.n && row.w === other.w;
  });
}

/** Drop the oldest written panes past {@link PANES_KEPT}, from the memory copies and from storage. */
function trim(): void {
  const known = new Map<string, number>();
  for (const [address, held] of memory) known.set(address, held.at);
  const store = storage();
  try {
    if (store !== null) {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key === null || !key.startsWith(CHAT_SILHOUETTE_PREFIX)) continue;
        const address = key.slice(CHAT_SILHOUETTE_PREFIX.length);
        if (known.has(address)) continue;
        const raw = store.getItem(key);
        known.set(address, (raw === null ? null : parseStored(raw))?.at ?? 0);
      }
    }
  } catch {
    // Locked-down storage: the memory copies are all there is.
  }
  if (known.size <= PANES_KEPT) return;
  const oldest = [...known].toSorted((a, b) => a[1] - b[1]).slice(0, known.size - PANES_KEPT);
  for (const [address] of oldest) {
    memory.delete(address);
    try {
      store?.removeItem(keyOf(address));
    } catch {
      // Nothing more to do for a key that cannot be removed.
    }
  }
}

/** Chat drew this pane's newest page: keep its silhouette. A silhouette equal to the kept one writes nothing. */
export function rememberSilhouette(address: string, silhouette: Silhouette): void {
  if (silhouette.rows.length === 0) return;
  const before = recallSilhouette(address);
  if (before !== undefined && sameRows(before, silhouette)) return;
  lastAt = Math.max(Date.now(), lastAt + 1);
  const stored: Stored = { at: lastAt, whole: silhouette.whole, rows: silhouette.rows };
  memory.set(address, stored);
  try {
    storage()?.setItem(keyOf(address), JSON.stringify(stored));
  } catch {
    // Quota or private mode: the memory copy still holds for this page.
  }
  if (before === undefined) trim();
}

/** Drop one pane's silhouette, memory and storage (a password prompt's wipe of that one pane). */
export function forgetChatSilhouette(address: string): void {
  memory.delete(address);
  try {
    storage()?.removeItem(keyOf(address));
  } catch {
    // Locked-down storage kept nothing.
  }
}

/** Drop every silhouette, memory and storage (the wipe at the end of a pairing runs it). */
export function forgetAllChatSilhouettes(): void {
  memory.clear();
  try {
    const store = storage();
    if (store === null) return;
    const held: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key !== null && key.startsWith(CHAT_SILHOUETTE_PREFIX)) held.push(key);
    }
    for (const key of held) store.removeItem(key);
  } catch {
    // Locked-down storage kept nothing.
  }
}

/** Test seam: forget the memory copies, as a reload does, and leave sessionStorage as it is. */
export function __forgetChatSilhouetteMemory(): void {
  memory.clear();
  lastAt = 0;
}

// ── WHAT A BLOCK IS ──────────────────────────────────────────────────────────

/**
 * What a block of the stream is, for its silhouette. A person's turn, agent prose, a folded run of steps (or any
 * step while tool calls are off) is a tool row, a lone call's card, a picture and a plan are cards, and a thinking
 * fold, a notice or a compaction mark is the rest.
 */
export function kindOfBlock(group: readonly ChatItem[], drawnSingle: boolean): RowKind {
  const first = group[0];
  if (first === undefined || !drawnSingle) return "tool";
  switch (first.kind) {
    case "user":
      return "person";
    case "reply":
      return "agent";
    case "tool":
    case "image":
      return "card";
    case "thinking":
    case "notice":
    case "compacted":
      return "other";
  }
}

// ── WHAT THE LOADING VIEW DRAWS ──────────────────────────────────────────────

/**
 * The thread of a typical session, top to bottom. The lowest 220px of it hold a bubble, a tool
 * well and text lines, so a screen with the soft keyboard open still reads as a thread and not as bars of lines.
 */
const GENERIC: readonly SilhouetteRow[] = [
  { k: "agent", h: 110, n: 5, w: 2 },
  { k: "person", h: 48, w: 2 },
  { k: "tool", h: 44 },
  { k: "agent", h: 66, n: 3, w: 1 },
];

/** At most this many repeats of {@link GENERIC}: a viewport of a tall tablet is a few screens at most. */
const MAX_REPEATS = 12;

/** What the loading view draws: the rows top to bottom, and whether they stand from the top of the list (a short whole thread) or the bottom. */
export interface LoadingRows {
  rows: SilhouetteRow[];
  top: boolean;
}

/** Whether a set of rows is a mix: a person's bubble and a tool well or a card, not bars of text alone. */
export function isMixed(rows: readonly SilhouetteRow[]): boolean {
  return rows.some((row) => row.k === "person") && rows.some((row) => row.k === "tool" || row.k === "card");
}

/** `base` with the typical thread above it where it falls short of the screen, cut to the newest rows that cover the screen plus the one crossing its top edge. */
function bottomAnchored(base: readonly SilhouetteRow[], viewport: number): SilhouetteRow[] {
  const rows = [...base];
  for (let repeats = 0; repeats < MAX_REPEATS && (rows.length === 0 || silhouetteHeight(rows) < viewport); repeats++) {
    rows.unshift(...GENERIC);
  }
  if (viewport <= 0) return rows;
  const kept: SilhouetteRow[] = [];
  for (let i = rows.length - 1; i >= 0; i--) {
    kept.unshift(rows[i]!);
    if (silhouetteHeight(kept) >= viewport) break;
  }
  return kept;
}

/**
 * The rows the loading view draws, top to bottom, and where they stand. Always a mix of a bubble, a tool well or card
 * and text. With a silhouette kept: its rows, and where it falls short of the screen, the typical thread above them,
 * when that is a mix; a silhouette of text alone gives the typical thread instead. Without: the typical thread,
 * repeated up the screen. Never more than the screen plus the one row that crosses its top edge, because the list is
 * pinned to its bottom and what is above would only be scrollback of a placeholder. A WHOLE thread that is shorter
 * than the screen and holds a person's message is drawn from the top and fills nothing, which is what the thread will
 * do when it arrives. For a screen below 220px or not measured yet no mix is promised.
 */
export function loadingRows(silhouette: Silhouette | undefined, viewport: number): LoadingRows {
  const base = silhouette?.rows ?? [];
  if (silhouette?.whole === true && viewport > 0 && silhouetteHeight(base) < viewport) {
    if (base.some((row) => row.k === "person")) return { rows: [...base], top: true };
    return { rows: bottomAnchored([], viewport), top: false };
  }
  const kept = bottomAnchored(base, viewport);
  if (base.length === 0 || isMixed(kept)) return { rows: kept, top: false };
  return { rows: bottomAnchored([], viewport), top: false };
}
