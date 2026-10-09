import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "@/lib/json";
import { isDangerKey, MODIFIER_ORDER, type Modifier } from "@/lib/key-queue";

// THE KEY BOARD (M48 spec 03, ADR 0092). The Keys dock's pad as DATA: a grid of 7 columns where a key
// is anchored at one cell and spans 1 to 3 columns and 1 or 2 rows, kept in this browser. This module
// is pure (no React, no storage, no clock): the shape, the chord grammar, the moves, the five presets,
// and the code that carries a layout to someone else. `lib/key-board-store.ts` keeps the stored copy.
//
// AREAS. A key is stored on the cell where its top-left corner sits (the ANCHOR); the cells it covers
// to the right and below hold `null` in `cells`, and `owners()` says who covers what. An area must lie
// inside the board and must not overlap another key. Every function here that moves or resizes a key
// checks both, and none of them moves a second key to make room: a move that does not fit is refused,
// and the one exception is a drop onto a key of the SAME size, which swaps the two.
//
// WHAT A KEY IS. Two kinds, and only two:
//
//  - a STICKY MODIFIER (`mod`): Shift, Ctrl or Alt. It does not send anything. Tapping it arms the
//    next key (off, once, locked), exactly as the fixed pad's three modifiers always did.
//  - a CHORD KEY (`chord`): one to four STEPS sent in order, each step a chord in the bridge's neutral
//    spelling (`bridge/mux/keys.ts`): up to three modifiers joined to one key. `ctrl+alt+shift+t` is
//    four keys at once; `ctrl+b` then `c` is a two-step sequence (tmux's prefix, then a new window).
//
// A chord key does NOT get a send path of its own. NavTray hands its steps to the same `onSend` the
// fixed keys always used, which is `pressKeys` in composer.tsx: the lock, the offline check, the
// echo, then `api.sendKeys`. This file only decides what the strings ARE.

/** The board is always this many columns wide. */
export const BOARD_COLS = 7;
export const MIN_ROWS = 1;
export const MAX_ROWS = 8;
/** The most cells a board can hold, and so the most keys. */
export const MAX_KEYS = BOARD_COLS * MAX_ROWS;
/** A key sends at most this many steps. */
export const MAX_STEPS = 4;
/** A key's name, in characters. The cell is a seventh of a phone: a longer name is cut anyway. */
export const MAX_LABEL = 12;
/** The longest layout code the importer reads, in characters. The biggest real board is under 2,000. */
export const MAX_CODE_LENGTH = 4096;
/** What a layout code starts with. The `2` is the format version of the code, read before anything else. */
export const CODE_PREFIX = "collie-keys:2:";
/** The prefix of version 1 codes (every key one cell). They are still read. */
const CODE_PREFIX_V1 = "collie-keys:1:";
/** The schema number written into storage and into the code's JSON. Schema 1 (single-cell keys) is still read. */
export const SCHEMA = 2;
/** A key spans at most this many columns and this many rows. */
export const MAX_W = 3;
export const MAX_H = 2;

/** A key's size in cells. Absent means 1. */
export type KeyWidth = 1 | 2 | 3;
export type KeyHeight = 1 | 2;

export interface ModKey {
  readonly kind: "mod";
  readonly mod: Modifier;
  readonly w?: KeyWidth;
  readonly h?: KeyHeight;
}

export interface ChordKey {
  readonly kind: "chord";
  /** Canonical chords, 1 to {@link MAX_STEPS}. */
  readonly steps: readonly string[];
  /** The name on the cell. Absent means the chord's own face (`^B C`), which follows the steps. */
  readonly label?: string;
  readonly w?: KeyWidth;
  readonly h?: KeyHeight;
}

export type BoardKey = ModKey | ChordKey;

export interface KeyBoard {
  readonly rows: number;
  /**
   * `rows * BOARD_COLS` cells, row by row. A key sits on its anchor cell; `null` is an empty cell or a
   * cell that a wider or taller key covers (ask {@link owners}).
   */
  readonly cells: readonly (BoardKey | null)[];
}

// ── The chord grammar ────────────────────────────────────────────────────────────────────────────

/** The named keys a step may end in, in the bridge's spelling (`MUX_NAMED_KEYS`), F keys apart. */
export const NAMED_KEYS = [
  "Escape",
  "Tab",
  "Enter",
  "Space",
  "Backspace",
  "Up",
  "Down",
  "Left",
  "Right",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "Delete",
] as const;

export const F_KEYS = Array.from({ length: 12 }, (_, i) => `F${i + 1}`);

const NAMED_BY_LOWER = new Map<string, string>([...NAMED_KEYS, ...F_KEYS].map((name) => [name.toLowerCase(), name]));
const MODIFIER_NAMES: ReadonlySet<string> = new Set(MODIFIER_ORDER);

export interface Step {
  /** Canonical order (ctrl, alt, shift), no repeats. */
  readonly mods: readonly Modifier[];
  /** One printable ASCII character, or a named key. */
  readonly base: string;
}

function isModifier(value: string): value is Modifier {
  return MODIFIER_NAMES.has(value);
}

/** One printable ASCII character, space excluded: the part of a step that is typed as itself. */
function isLiteral(base: string): boolean {
  if (base.length !== 1) return false;
  const code = base.charCodeAt(0);
  return code >= 0x21 && code <= 0x7e;
}

/**
 * Read one step, or `null` when it is not one the bridge would accept.
 *
 * Modifiers are ctrl, alt and shift in any order and any case, each at most once. The key is one
 * literal character or a name from {@link NAMED_KEYS} or `F1`..`F12`, matched without regard to case.
 * `ctrl++` is Ctrl plus the plus key. Everything else, `meta`, `cmd`, a bare `ctrl`, two keys, a
 * space, an empty string, is refused here rather than on the wire.
 */
export function parseStep(raw: string): Step | null {
  if (raw === "" || raw.length > 40) return null;
  const plusKey = raw === "+" || raw.endsWith("++");
  const parts = plusKey ? raw.slice(0, -1).split("+").slice(0, -1) : raw.split("+");
  const base = plusKey ? "+" : (parts.pop() ?? "");
  const seen = new Set<Modifier>();
  for (const part of parts) {
    const mod = part.toLowerCase();
    if (!isModifier(mod) || seen.has(mod)) return null;
    seen.add(mod);
  }
  const key = isLiteral(base) ? base : (NAMED_BY_LOWER.get(base.toLowerCase()) ?? null);
  if (key === null) return null;
  return { mods: MODIFIER_ORDER.filter((m) => seen.has(m)), base: key };
}

/** The canonical spelling of a step. `parseStep(formatStep(s))` is `s`. */
export function formatStep(step: Step): string {
  return [...step.mods, step.base].join("+");
}

/** A raw chord in its canonical spelling, or `null`. */
export function canonicalStep(raw: string): string | null {
  const step = parseStep(raw);
  return step === null ? null : formatStep(step);
}

const GLYPH = { ctrl: "^", alt: "⌥", shift: "⇧" } satisfies Record<Modifier, string>;
const WORD = { ctrl: "Ctrl", alt: "Alt", shift: "Shift" } satisfies Record<Modifier, string>;

const SHORT_BASE = new Map<string, string>([
  ["Escape", "Esc"],
  ["Enter", "⏎"],
  ["Backspace", "Bksp"],
  ["PageUp", "PgUp"],
  ["PageDown", "PgDn"],
  ["Insert", "Ins"],
  ["Delete", "Del"],
  ["Up", "↑"],
  ["Down", "↓"],
  ["Left", "←"],
  ["Right", "→"],
]);

/** The short face of a step for a cell: `ctrl+w` is `^W`, `Escape` is `Esc`, `ctrl+alt+shift+t` is `^⌥⇧T`. */
export function stepFace(step: string): string {
  const parsed = parseStep(step);
  if (parsed === null) return step;
  const base = SHORT_BASE.get(parsed.base) ?? (parsed.base.length === 1 ? parsed.base.toUpperCase() : parsed.base);
  return `${parsed.mods.map((m) => GLYPH[m]).join("")}${base}`;
}

/** A step in words, for a screen reader and for the builder's preview: `Ctrl+Alt+Shift+T`, `Esc`, `Up`. */
export function stepWords(step: string): string {
  const parsed = parseStep(step);
  if (parsed === null) return step;
  const base = parsed.base === "Escape" ? "Esc" : parsed.base.length === 1 ? parsed.base.toUpperCase() : parsed.base;
  return [...parsed.mods.map((m) => WORD[m]), base].join("+");
}

/** A whole key in words: `Ctrl+B, then C`. */
export function stepsWords(steps: readonly string[], then: string): string {
  return steps.map(stepWords).join(`, ${then} `);
}

/** What a chord key says when it has no name of its own. Follows the steps. */
export function defaultLabel(steps: readonly string[]): string {
  return steps.map(stepFace).join(" ");
}

/** The name on a key's cell. */
export function keyLabel(key: BoardKey): string {
  if (key.kind === "mod") return key.mod === "shift" ? "⇧" : WORD[key.mod];
  return key.label ?? defaultLabel(key.steps);
}

/**
 * Whether a tap must be confirmed by a second tap before this key goes to the pane.
 *
 * Any step that can stop or suspend a program counts (`isDangerKey`: ctrl+c, ctrl+d, ctrl+z), with ONE
 * exception: a key that is exactly Ctrl+C. The stock `^C` has always fired at one tap, because it is
 * the key a person reaches for in a hurry, and the Presets row treats Ctrl+C the same way. A sequence
 * that holds ctrl+c somewhere is not that key, and asks.
 */
export function needsSecondTap(key: BoardKey): boolean {
  if (key.kind !== "chord") return false;
  if (key.steps.length === 1 && key.steps[0] === "ctrl+c") return false;
  return key.steps.some(isDangerKey);
}

/** Whether the key is exactly the lone Ctrl+C. The builder says so in its status line. */
export function isLoneInterrupt(steps: readonly string[]): boolean {
  return steps.length === 1 && steps[0] === "ctrl+c";
}

/** Build a chord key from raw steps, or `null` when any step is not a chord or the count is wrong. */
export function chordKey(rawSteps: readonly string[], label?: string): ChordKey | null {
  if (rawSteps.length < 1 || rawSteps.length > MAX_STEPS) return null;
  const steps: string[] = [];
  for (const raw of rawSteps) {
    const step = canonicalStep(raw);
    if (step === null) return null;
    steps.push(step);
  }
  const name = label === undefined ? undefined : cleanLabel(label);
  if (label !== undefined && name === null) return null;
  return name === undefined || name === null || name === defaultLabel(steps) ? { kind: "chord", steps } : { kind: "chord", steps, label: name };
}

/** A label trimmed, or `null` when it is empty, too long, or holds a control or line-break character. */
export function cleanLabel(raw: string): string | null {
  const label = raw.trim();
  if (label === "" || [...label].length > MAX_LABEL) return null;
  if (/[\p{C}\p{Zl}\p{Zp}]/u.test(label)) return null;
  return label;
}

// ── Boards ───────────────────────────────────────────────────────────────────────────────────────

/** A sticky modifier key: off, once, locked, as the fixed pad always had. */
export const modKey = (m: Modifier): ModKey => ({ kind: "mod", mod: m });
const mod = modKey;
const chord = (...steps: string[]): ChordKey => ({ kind: "chord", steps });
const named = (label: string, ...steps: string[]): ChordKey => ({ kind: "chord", steps, label });

/** Keys while one is being built, before it is handed out read-only. */
type ModDraft = { -readonly [K in keyof ModKey]: ModKey[K] };
type ChordDraft = { -readonly [K in keyof ChordKey]: ChordKey[K] };

/** The stored width for a number of columns: absent for 1, so a one-cell key stays plain. */
const widthOf = (w: number): KeyWidth | undefined => (w === 2 ? 2 : w >= 3 ? 3 : undefined);
const heightOf = (h: number): KeyHeight | undefined => (h >= 2 ? 2 : undefined);

/** The same key at another size. A size outside 1 to 3 by 1 to 2 is clamped into it. */
export function withSize(key: BoardKey, w: number, h: number): BoardKey {
  const width = widthOf(w);
  const height = heightOf(h);
  if (key.kind === "mod") {
    const next: ModDraft = { kind: "mod", mod: key.mod };
    if (width !== undefined) next.w = width;
    if (height !== undefined) next.h = height;
    return next;
  }
  const next: ChordDraft = { kind: "chord", steps: key.steps };
  if (key.label !== undefined) next.label = key.label;
  if (width !== undefined) next.w = width;
  if (height !== undefined) next.h = height;
  return next;
}

/** A size in cells. */
export interface Span {
  readonly w: number;
  readonly h: number;
}

/** A key as wide and tall as it is, in cells. */
export function spanOf(key: BoardKey): Span {
  return { w: key.w ?? 1, h: key.h ?? 1 };
}

/** Where a key sits on a CSS grid. */
export interface GridArea {
  readonly gridColumn: string;
  readonly gridRow: string;
}

/** The CSS grid placement of a key anchored at `anchor`: its corner's column and row, and its span. */
export function areaCss(anchor: number, key: BoardKey): GridArea {
  const { w, h } = spanOf(key);
  return { gridColumn: `${(anchor % BOARD_COLS) + 1} / span ${w}`, gridRow: `${Math.floor(anchor / BOARD_COLS) + 1} / span ${h}` };
}

/** Whether two keys are the same size, which is when a drop on one swaps with it. */
const sameSize = (a: BoardKey, b: BoardKey): boolean => a.w === b.w && a.h === b.h;

/** A board from `[cell, key]` pairs. Cells not named stay empty. */
export function boardOf(rows: number, entries: readonly (readonly [number, BoardKey])[]): KeyBoard {
  const cells: (BoardKey | null)[] = Array.from({ length: rows * BOARD_COLS }, () => null);
  for (const [cell, key] of entries) cells[cell] = key;
  return { rows, cells };
}

/**
 * For every cell, the anchor of the key that covers it, or -1 when it is free. A key that does not
 * lie inside the board (a hand-built value; a read board never has one) covers what is inside.
 */
export function owners(board: KeyBoard): readonly number[] {
  const own: number[] = Array.from({ length: board.cells.length }, () => -1);
  board.cells.forEach((key, anchor) => {
    if (key === null) return;
    const { w, h } = spanOf(key);
    const col = anchor % BOARD_COLS;
    const row = Math.floor(anchor / BOARD_COLS);
    for (let r = 0; r < h && row + r < board.rows; r++) {
      for (let c = 0; c < w && col + c < BOARD_COLS; c++) own[anchor + r * BOARD_COLS + c] = anchor;
    }
  });
  return own;
}

/** Whether an area of `w` by `h` anchored at `anchor` lies wholly inside the board. */
export function inBoard(board: KeyBoard, anchor: number, w: number, h: number): boolean {
  if (anchor < 0 || anchor >= board.cells.length) return false;
  return (anchor % BOARD_COLS) + w <= BOARD_COLS && Math.floor(anchor / BOARD_COLS) + h <= board.rows;
}

/** The anchor for an area of `w` by `h` whose corner is at `col`, `row`, pulled back inside the board. Used while dragging. */
export function clampAnchor(board: KeyBoard, col: number, row: number, w: number, h: number): number {
  const c = Math.max(0, Math.min(col, BOARD_COLS - w));
  const r = Math.max(0, Math.min(row, board.rows - h));
  return r * BOARD_COLS + c;
}

/** The anchor of the first key (row by row) that an area would overlap, ignoring `ignore`'s own area. */
function firstBlocker(board: KeyBoard, anchor: number, w: number, h: number, ignore: number): number | null {
  const own = owners(board);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const owner = own[anchor + r * BOARD_COLS + c] ?? -1;
      if (owner >= 0 && owner !== ignore) return owner;
    }
  }
  return null;
}

/** Whether the area is inside the board and free, apart from the key anchored at `ignore`. */
export function areaFits(board: KeyBoard, anchor: number, w: number, h: number, ignore = -1): boolean {
  return inBoard(board, anchor, w, h) && firstBlocker(board, anchor, w, h, ignore) === null;
}

function placed(board: KeyBoard, moves: readonly (readonly [number, number])[]): KeyBoard {
  // `[from, to]` pairs, all lifted first and then put down, so a swap does not trample itself.
  const cells = [...board.cells];
  const lifted = moves.map(([from, to]) => [to, cells[from] ?? null] as const);
  for (const [from] of moves) cells[from] = null;
  for (const [to, key] of lifted) cells[to] = key;
  return { rows: board.rows, cells };
}

/** What a drop (or an arrow step) did: the board after it, where the key now is, and how. */
export type MoveResult =
  | { readonly kind: "move" | "swap"; readonly board: KeyBoard; readonly at: number }
  | { readonly kind: "none" }
  | { readonly kind: "refused"; readonly reason: "edge" }
  | { readonly kind: "refused"; readonly reason: "blocked"; readonly by: number };

/**
 * Drop the key anchored at `from` so that its top-left corner is on `to`. The area at `to` must be
 * inside the board. Then: free (apart from the key itself) moves it; a key of the SAME size under the
 * corner swaps places with it; anything else is refused, and nothing else moves.
 */
export function dropKey(board: KeyBoard, from: number, to: number): MoveResult {
  const key = board.cells[from] ?? null;
  if (key === null || from === to) return { kind: "none" };
  const { w, h } = spanOf(key);
  if (!inBoard(board, to, w, h)) return { kind: "refused", reason: "edge" };
  const hit = owners(board)[to] ?? -1;
  const other = hit >= 0 && hit !== from ? (board.cells[hit] ?? null) : null;
  if (other !== null && sameSize(key, other)) return { kind: "swap", board: placed(board, [[from, hit], [hit, from]]), at: hit };
  const by = firstBlocker(board, to, w, h, from);
  if (by !== null) return { kind: "refused", reason: "blocked", by };
  return { kind: "move", board: placed(board, [[from, to]]), at: to };
}

/**
 * One arrow tap: the key goes to the next position in that direction where it fits (or swaps with a
 * key of its own size), skipping over keys that are in the way. `none` when there is no such position.
 */
export function stepKey(board: KeyBoard, from: number, dc: number, dr: number): MoveResult {
  const key = board.cells[from] ?? null;
  if (key === null || (dc === 0 && dr === 0)) return { kind: "none" };
  const { w, h } = spanOf(key);
  const col = from % BOARD_COLS;
  const row = Math.floor(from / BOARD_COLS);
  for (let k = 1; ; k++) {
    const c = col + dc * k;
    const r = row + dr * k;
    if (c < 0 || r < 0 || c + w > BOARD_COLS || r + h > board.rows) return { kind: "none" };
    const result = dropKey(board, from, r * BOARD_COLS + c);
    if (result.kind === "move" || result.kind === "swap") return result;
  }
}

export type ResizeResult =
  | { readonly ok: true; readonly board: KeyBoard }
  | { readonly ok: false; readonly reason: "edge" }
  | { readonly ok: false; readonly reason: "blocked"; readonly by: number };

/** Change the size of the key anchored at `anchor`. It grows right and down, and nothing else moves. */
export function resizeKey(board: KeyBoard, anchor: number, w: number, h: number): ResizeResult {
  const key = board.cells[anchor] ?? null;
  if (key === null || w < 1 || w > MAX_W || h < 1 || h > MAX_H) return { ok: false, reason: "edge" };
  if (!inBoard(board, anchor, w, h)) return { ok: false, reason: "edge" };
  const by = firstBlocker(board, anchor, w, h, anchor);
  if (by !== null) return { ok: false, reason: "blocked", by };
  return { ok: true, board: { rows: board.rows, cells: board.cells.map((k, i) => (i === anchor ? withSize(key, w, h) : k)) } };
}

/**
 * Today's pad as a board: the Default, and what "Restore default" restores.
 *
 * Row 1 is Esc, Tab, the three modifiers, Up and the quick Ctrl+C, as before. Row 2 is Enter, a Space
 * three cells wide, then Left, Down and Right under Up. The old pad set a tall Enter apart on an
 * eighth column; seven columns have no room for that without moving a key of row 1, so Enter takes
 * the far left of row 2, with the wide Space between it and the arrows: a miss on an arrow is
 * reversible, a miss on Enter confirms a prompt (issue 263).
 *
 *     Esc  Tab  Shift Ctrl Alt  Up   ^C
 *     Enter  Space (3 wide)    Left Down Right
 */
export const DEFAULT_BOARD: KeyBoard = boardOf(2, [
  [0, chord("Escape")],
  [1, chord("Tab")],
  [2, mod("shift")],
  [3, mod("ctrl")],
  [4, mod("alt")],
  [5, chord("Up")],
  [6, chord("ctrl+c")],
  [7, chord("Enter")],
  [8, { ...chord("Space"), w: 3 }],
  [11, chord("Left")],
  [12, chord("Down")],
  [13, chord("Right")],
]);

/** The keys whose loss is worth a word: a phone has no other Esc, Enter or arrows. */
export const CORE_KEYS: readonly { readonly name: string; readonly step: string; readonly home: number }[] = [
  { name: "Esc", step: "Escape", home: 0 },
  { name: "Enter", step: "Enter", home: 7 },
  { name: "Up", step: "Up", home: 5 },
  { name: "Left", step: "Left", home: 11 },
  { name: "Down", step: "Down", home: 12 },
  { name: "Right", step: "Right", home: 13 },
];

const holdsStep = (board: KeyBoard, step: string): boolean =>
  board.cells.some((k) => k !== null && k.kind === "chord" && k.steps.length === 1 && k.steps[0] === step);

/** The names of the core keys the board does not carry. Empty is the usual answer. */
export function missingCore(board: KeyBoard): string[] {
  return CORE_KEYS.filter((c) => !holdsStep(board, c.step)).map((c) => c.name);
}

/** Put the missing core keys back: each in its Default cell when that is free, else in the first free cell. */
export function putBackCore(board: KeyBoard): KeyBoard {
  let next = board;
  for (const core of CORE_KEYS) {
    if (holdsStep(next, core.step)) continue;
    let own = owners(next);
    let cell = core.home < own.length && own[core.home] === -1 ? core.home : own.indexOf(-1);
    if (cell < 0) {
      if (next.rows >= MAX_ROWS) continue;
      next = addRow(next);
      own = owners(next);
      cell = own.indexOf(-1);
    }
    next = setCell(next, cell, chord(core.step));
  }
  return next;
}

/**
 * Put a key on a cell, or take it away with `null`. A key goes where its whole area fits (apart from
 * the key already anchored there, which it replaces); a cell another key covers is left alone.
 */
export function setCell(board: KeyBoard, cell: number, key: BoardKey | null): KeyBoard {
  if (cell < 0 || cell >= board.cells.length) return board;
  if (key !== null) {
    const { w, h } = spanOf(key);
    if (!areaFits(board, cell, w, h, cell)) return board;
  } else if (board.cells[cell] === null) {
    return board;
  }
  return { rows: board.rows, cells: board.cells.map((k, i) => (i === cell ? key : k)) };
}

export function addRow(board: KeyBoard): KeyBoard {
  if (board.rows >= MAX_ROWS) return board;
  return { rows: board.rows + 1, cells: [...board.cells, ...Array.from({ length: BOARD_COLS }, () => null)] };
}

/** Whether the last row is free (no key sits in it or reaches into it) and there is more than one row. */
export function canRemoveRow(board: KeyBoard): boolean {
  return board.rows > MIN_ROWS && owners(board).slice(-BOARD_COLS).every((o) => o === -1);
}

export function removeRow(board: KeyBoard): KeyBoard {
  if (!canRemoveRow(board)) return board;
  return { rows: board.rows - 1, cells: board.cells.slice(0, -BOARD_COLS) };
}

export function keyCount(board: KeyBoard): number {
  return board.cells.filter((k) => k !== null).length;
}

/** How many rows the pad in use draws: trailing free rows are not drawn. At least one. */
export function usedRows(board: KeyBoard): number {
  const last = owners(board).findLastIndex((o) => o >= 0);
  return Math.max(MIN_ROWS, Math.floor(last / BOARD_COLS) + 1);
}

/** The chords a key sends, in order. A modifier key sends none. */
export function wireKeys(key: BoardKey): readonly string[] {
  return key.kind === "chord" ? key.steps : [];
}

// ── The code: one layout as a short piece of text ────────────────────────────────────────────────

/**
 * `[cell, spec]`, `[cell, spec, label]` or `[cell, spec, label | null, w, h]`. A spec is `@ctrl` for a
 * modifier key, else steps joined by a space. Schema 1 had no size: its keys are one cell each.
 */
type WireKey = [number, string] | [number, string, string] | [number, string, string | null, number, number];

function specOf(key: BoardKey): string {
  return key.kind === "mod" ? `@${key.mod}` : key.steps.join(" ");
}

function toWire(board: KeyBoard): JsonValue {
  const keys: JsonValue[] = [];
  board.cells.forEach((key, cell) => {
    if (key === null) return;
    const label = key.kind === "chord" ? (key.label ?? null) : null;
    const { w, h } = spanOf(key);
    const row: WireKey =
      w !== 1 || h !== 1 ? [cell, specOf(key), label, w, h] : label === null ? [cell, specOf(key)] : [cell, specOf(key), label];
    keys.push(row);
  });
  return { v: SCHEMA, rows: board.rows, keys };
}

/** The compact JSON of a layout. The same text goes to storage, and (base64url) into the code. */
export function serializeBoard(board: KeyBoard): string {
  return JSON.stringify(toWire(board));
}

export type BoardRefusal = "notJson" | "schema" | "rows" | "tooMany" | "noKeys" | "cell" | "key" | "label" | "area";

/** A board, or the first reason it is not one. */
export type BoardRead = { readonly ok: true; readonly board: KeyBoard } | { readonly ok: false; readonly reason: BoardRefusal };

const refuse = (reason: BoardRefusal) => ({ ok: false, reason }) as const;

type KeyRead =
  | { readonly ok: true; readonly cell: number; readonly key: BoardKey }
  | { readonly ok: false; readonly reason: BoardRefusal };

/** A whole number in a range, or undefined. */
function sizeIn(raw: JsonValue | undefined, max: number): number | undefined {
  const n = asJsonNumber(raw);
  return n !== undefined && Number.isInteger(n) && n >= 1 && n <= max ? n : undefined;
}

function readKey(raw: JsonValue, schema: number): KeyRead {
  const maxLength = schema === 1 ? 3 : 5;
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > maxLength || raw.length === 4) return refuse("key");
  const cell = asJsonNumber(raw[0]);
  const spec = asJsonString(raw[1]);
  if (cell === undefined || !Number.isInteger(cell) || cell < 0 || spec === undefined) return refuse("cell");
  let w = 1;
  let h = 1;
  if (raw.length === 5) {
    const sw = sizeIn(raw[3], MAX_W);
    const sh = sizeIn(raw[4], MAX_H);
    if (sw === undefined || sh === undefined) return refuse("key");
    w = sw;
    h = sh;
  }
  const rawLabel = raw.length >= 3 ? raw[2] : undefined;
  const label = rawLabel === null || rawLabel === undefined ? undefined : asJsonString(rawLabel);
  if (rawLabel !== null && rawLabel !== undefined && label === undefined) return refuse("label");
  if (spec.startsWith("@")) {
    const name = spec.slice(1);
    if (label !== undefined || !isModifier(name)) return refuse("key");
    return { ok: true, cell, key: withSize(mod(name), w, h) };
  }
  const key = chordKey(spec.split(" "), label);
  if (key === null) return refuse(label === undefined ? "key" : "label");
  return { ok: true, cell, key: withSize(key, w, h) };
}

/** Read the wire form. Total: every failure is a named refusal, never a throw. */
export function readBoard(value: JsonValue | undefined): BoardRead {
  const doc = asJsonObject(value);
  if (doc === undefined) return refuse("notJson");
  const schema = asJsonNumber(doc.v);
  if (schema !== 1 && schema !== SCHEMA) return refuse("schema");
  const rows = asJsonNumber(doc.rows);
  if (rows === undefined || !Number.isInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) return refuse("rows");
  const list = doc.keys;
  if (!Array.isArray(list)) return refuse("key");
  if (list.length > MAX_KEYS) return refuse("tooMany");
  if (list.length === 0) return refuse("noKeys");
  const cells: (BoardKey | null)[] = Array.from({ length: rows * BOARD_COLS }, () => null);
  const claimed: boolean[] = Array.from({ length: rows * BOARD_COLS }, () => false);
  for (const raw of list) {
    const read = readKey(raw, schema);
    if (!read.ok) return read;
    if (read.cell >= cells.length) return refuse("cell");
    const { w, h } = spanOf(read.key);
    if ((read.cell % BOARD_COLS) + w > BOARD_COLS || Math.floor(read.cell / BOARD_COLS) + h > rows) return refuse("area");
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const at = read.cell + r * BOARD_COLS + c;
        if (claimed[at] === true) return refuse(r === 0 && c === 0 ? "cell" : "area");
        claimed[at] = true;
      }
    }
    cells[read.cell] = read.key;
  }
  return { ok: true, board: { rows, cells } };
}

/** Read a stored or pasted JSON text into a board, or a refusal. */
export function parseBoard(text: string): BoardRead {
  const value = parseJson(text);
  return value === undefined ? refuse("notJson") : readBoard(value);
}

function toBase64Url(text: string): string {
  let bin = "";
  for (const byte of new TextEncoder().encode(text)) bin += String.fromCharCode(byte);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** A layout as one line of text: the prefix, then base64url of {@link serializeBoard}. */
export function encodeBoard(board: KeyBoard): string {
  return CODE_PREFIX + toBase64Url(serializeBoard(board));
}

export type DecodeRefusal = "empty" | "notCode" | "tooLong" | "damaged" | BoardRefusal;

export type Decoded = { readonly ok: true; readonly board: KeyBoard } | { readonly ok: false; readonly reason: DecodeRefusal };

/**
 * Read a pasted layout code. Nothing is believed before it is checked: the length cap comes first,
 * then the prefix (version 2, or version 1 from an older Collie), the base64url alphabet, UTF-8, JSON,
 * the schema number, the key count, every chord and label through the same readers storage uses, and
 * that every key's area lies inside the board and overlaps no other. A refusal names the first thing
 * that failed.
 */
export function decodeBoard(input: string): Decoded {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (text.length > MAX_CODE_LENGTH) return { ok: false, reason: "tooLong" };
  const prefix = [CODE_PREFIX, CODE_PREFIX_V1].find((p) => text.startsWith(p));
  if (prefix === undefined) return { ok: false, reason: "notCode" };
  const json = fromBase64Url(text.slice(prefix.length));
  if (json === null) return { ok: false, reason: "damaged" };
  return parseBoard(json);
}

// ── The five presets ─────────────────────────────────────────────────────────────────────────────

export interface BoardPreset {
  readonly id: "default" | "claude" | "prefix" | "vim" | "navigation";
  readonly board: KeyBoard;
}

// Every preset keeps Esc, Enter and the four arrows (a person should never need Restore after
// choosing one), with Down under Up as on the Default, and Space three cells wide between Enter and
// the arrows, as the Default has it. The rest is spent on the tool the preset is named for. Each binding
// was checked against that tool's own documentation; the notes say which keys a multiplexer may
// refuse. No preset uses Ctrl+D or Ctrl+Z outside a sequence, because those two ask for a second tap
// and a scroll key must not. A wide Space costs two cells, so the presets that name more keys than fit
// in three rows leave the sticky modifiers to the Default, or take a fourth row.
//
// Rows 1 and 2 are the same shape in all five, so the arrows never move when you change presets:
//
//     R1  Esc  k  k  k  k  Up  k           (k is a key the preset chooses)
//     R2  Enter  Space (3 wide)  Left Down Right

/** Rows 1 and 2 of every preset: the six core keys, Space, and the five cells (1 to 4 and 6) a preset chooses for row 1. */
function frame(row1: readonly [BoardKey, BoardKey, BoardKey, BoardKey, BoardKey]): readonly (readonly [number, BoardKey])[] {
  return [
    [0, chord("Escape")],
    [1, row1[0]],
    [2, row1[1]],
    [3, row1[2]],
    [4, row1[3]],
    [5, chord("Up")],
    [6, row1[4]],
    [7, chord("Enter")],
    [8, { ...chord("Space"), w: 3 }],
    [11, chord("Left")],
    [12, chord("Down")],
    [13, chord("Right")],
  ];
}

/** Row 3 and below: keys placed from the first cell of row 3, in order. */
function below(keys: readonly BoardKey[]): readonly (readonly [number, BoardKey])[] {
  return keys.map((key, i) => [14 + i, key] as const);
}

/**
 * Claude Code (checked against its interactive-mode reference). Shift+Tab cycles the permission mode.
 * Esc stops the turn; Esc twice clears a draft, or opens the rewind menu on an empty prompt. `/` opens the slash-command menu. Ctrl+O shows the full transcript, Ctrl+T the task
 * list, Ctrl+R searches the prompt history, Ctrl+B sends a running command to the background (inside tmux, tap it twice), Ctrl+G
 * opens the draft in your editor, Alt+P switches the model. The Ctrl modifier is the one sticky key
 * kept, for anything else.
 */
const CLAUDE: KeyBoard = boardOf(3, [
  ...frame([chord("Escape", "Escape"), chord("shift+Tab"), chord("Tab"), chord("/"), chord("ctrl+c")]),
  ...below([chord("ctrl+o"), chord("ctrl+t"), chord("ctrl+r"), chord("ctrl+b"), chord("ctrl+g"), chord("alt+p"), mod("ctrl")]),
]);

/**
 * tmux with its default prefix, Ctrl+B. Each `Ctrl+B, x` key is a two-step sequence sent in order:
 * c new window, n and p next and previous window, % and " split side by side and stacked, o next
 * pane, z zoom, [ copy mode, w window tree, x close the pane (tmux asks you to confirm). These are
 * for a tmux running INSIDE the pane, for example over ssh: a tmux mirror sends keys straight to the
 * pane's program, so it never reads its own prefix.
 */
const PREFIX: KeyBoard = boardOf(3, [
  ...frame([named("Prefix", "ctrl+b"), named("New win", "ctrl+b", "c"), named("Next", "ctrl+b", "n"), named("Prev", "ctrl+b", "p"), chord("ctrl+c")]),
  ...below([
    named("Split |", "ctrl+b", "%"),
    named("Split -", "ctrl+b", '"'),
    named("Pane", "ctrl+b", "o"),
    named("Zoom", "ctrl+b", "z"),
    named("Copy", "ctrl+b", "["),
    named("Tree", "ctrl+b", "w"),
    named("Close", "ctrl+b", "x"),
  ]),
]);

/**
 * Vim. Esc leaves insert mode, `i` enters it. `:` starts a command, `/` a search, `u` undoes and
 * Ctrl+R redoes. `:w` saves and `:wq` saves and quits, each ending in Enter. Ctrl+F and Ctrl+B page
 * down and up, Ctrl+V starts a block selection, `gg` and `G` jump to the top and the bottom, `dd`
 * deletes a line, `yy` copies it and `p` pastes. Four rows.
 */
const VIM: KeyBoard = boardOf(4, [
  ...frame([chord("i"), chord(":"), chord("/"), chord("u"), chord("p")]),
  ...below([
    named(":w", ":", "w", "Enter"),
    named(":wq", ":", "w", "q", "Enter"),
    chord("ctrl+r"),
    chord("ctrl+f"),
    chord("ctrl+b"),
    chord("ctrl+v"),
    named("gg", "g", "g"),
    chord("G"),
    named("dd", "d", "d"),
    named("yy", "y", "y"),
  ]),
]);

/**
 * Navigation. Home, End, PageUp and PageDown for a long file or list, and the readline moves that
 * work in any shell: Ctrl+A and Ctrl+E jump to the line's start and end, Alt+B and Alt+F move by a
 * word, Ctrl+U clears the line, Ctrl+W deletes a word. Herdr refuses Home, End, PageUp, PageDown
 * and Delete (its `send_keys` has no such names), so on a Herdr pane those five stay grey and the
 * readline keys do the same work; tmux and zellij send all of them. Four rows.
 */
const NAVIGATION: KeyBoard = boardOf(4, [
  ...frame([chord("Home"), chord("PageUp"), chord("PageDown"), chord("End"), chord("Delete")]),
  ...below([
    chord("ctrl+a"),
    chord("ctrl+e"),
    chord("alt+b"),
    chord("alt+f"),
    chord("ctrl+u"),
    chord("ctrl+w"),
    chord("Backspace"),
    chord("Tab"),
    chord("shift+Tab"),
  ]),
]);

export const PRESETS: readonly BoardPreset[] = [
  { id: "default", board: DEFAULT_BOARD },
  { id: "claude", board: CLAUDE },
  { id: "prefix", board: PREFIX },
  { id: "vim", board: VIM },
  { id: "navigation", board: NAVIGATION },
];

/** Whether two boards hold the same keys in the same cells. */
export function sameBoard(a: KeyBoard, b: KeyBoard): boolean {
  return serializeBoard(a) === serializeBoard(b);
}
