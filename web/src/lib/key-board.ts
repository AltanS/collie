import { asJsonNumber, asJsonObject, asJsonString, parseJson, type JsonValue } from "@/lib/json";
import { isDangerKey, MODIFIER_ORDER, type Modifier } from "@/lib/key-queue";

// THE KEY BOARD (M48 spec 03, ADR 0092). The Keys dock's pad as DATA: a grid of 7 columns where each
// cell holds one key or nothing, saved per device. This module is pure (no React, no storage, no
// clock): the shape, the chord grammar, the moves, the five presets, and the code that carries a
// layout from one device to another. `lib/key-board-store.ts` keeps the device's copy.
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

/** The board is always this many columns wide. A key sits in exactly one cell. */
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
/** What a layout code starts with. The `1` is the format version of the code, read before anything else. */
export const CODE_PREFIX = "collie-keys:1:";
/** The schema number written into storage and into the code's JSON. Unknown numbers are not read. */
export const SCHEMA = 1;

export interface ModKey {
  readonly kind: "mod";
  readonly mod: Modifier;
}

export interface ChordKey {
  readonly kind: "chord";
  /** Canonical chords, 1 to {@link MAX_STEPS}. */
  readonly steps: readonly string[];
  /** The name on the cell. Absent means the chord's own face (`^B C`), which follows the steps. */
  readonly label?: string;
}

export type BoardKey = ModKey | ChordKey;

export interface KeyBoard {
  readonly rows: number;
  /** `rows * BOARD_COLS` cells, row by row. `null` is an empty cell. */
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

const mod = (m: Modifier): ModKey => ({ kind: "mod", mod: m });
const chord = (...steps: string[]): ChordKey => ({ kind: "chord", steps });
const named = (label: string, ...steps: string[]): ChordKey => ({ kind: "chord", steps, label });

/** A board from `[cell, key]` pairs. Cells not named stay empty. */
export function boardOf(rows: number, entries: readonly (readonly [number, BoardKey])[]): KeyBoard {
  const cells: (BoardKey | null)[] = Array.from({ length: rows * BOARD_COLS }, () => null);
  for (const [cell, key] of entries) cells[cell] = key;
  return { rows, cells };
}

/**
 * Today's pad as a board: the Default, and what "Restore default" restores.
 *
 * Row 1 is Esc, Tab, the three modifiers, Up and the quick Ctrl+C. Row 2 is Space, Enter, two empty
 * cells, then the arrows' Left, Down and Right under Up. Each key is one cell now (a tall Enter and a
 * four-wide Space belonged to a fixed grid), and Enter keeps its distance from the arrows: a miss on
 * an arrow is reversible, a miss on Enter confirms a prompt (issue 263).
 */
export const DEFAULT_BOARD: KeyBoard = boardOf(2, [
  [0, chord("Escape")],
  [1, chord("Tab")],
  [2, mod("shift")],
  [3, mod("ctrl")],
  [4, mod("alt")],
  [5, chord("Up")],
  [6, chord("ctrl+c")],
  [7, chord("Space")],
  [8, chord("Enter")],
  [11, chord("Left")],
  [12, chord("Down")],
  [13, chord("Right")],
]);

/** The keys whose loss is worth a word: a phone has no other Esc, Enter or arrows. */
export const CORE_KEYS: readonly { readonly name: string; readonly step: string; readonly home: number }[] = [
  { name: "Esc", step: "Escape", home: 0 },
  { name: "Enter", step: "Enter", home: 8 },
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
    let cell = core.home < next.cells.length && next.cells[core.home] === null ? core.home : next.cells.indexOf(null);
    if (cell < 0) {
      if (next.rows >= MAX_ROWS) continue;
      next = addRow(next);
      cell = next.cells.indexOf(null);
    }
    next = setCell(next, cell, chord(core.step));
  }
  return next;
}

export function setCell(board: KeyBoard, cell: number, key: BoardKey | null): KeyBoard {
  if (cell < 0 || cell >= board.cells.length) return board;
  return { rows: board.rows, cells: board.cells.map((k, i) => (i === cell ? key : k)) };
}

/** Swap two cells. Dropping a key on a full cell swaps the two; on an empty cell it moves. */
export function swapCells(board: KeyBoard, a: number, b: number): KeyBoard {
  const n = board.cells.length;
  if (a === b || a < 0 || b < 0 || a >= n || b >= n) return board;
  const cells = [...board.cells];
  [cells[a], cells[b]] = [cells[b] ?? null, cells[a] ?? null];
  return { rows: board.rows, cells };
}

/** The cell one step away in a direction, or -1 at the edge of the board. */
export function neighbour(board: KeyBoard, from: number, dc: number, dr: number): number {
  if (from < 0 || from >= board.cells.length) return -1;
  const col = (from % BOARD_COLS) + dc;
  const row = Math.floor(from / BOARD_COLS) + dr;
  if (col < 0 || col >= BOARD_COLS || row < 0 || row >= board.rows) return -1;
  return row * BOARD_COLS + col;
}

export function addRow(board: KeyBoard): KeyBoard {
  if (board.rows >= MAX_ROWS) return board;
  return { rows: board.rows + 1, cells: [...board.cells, ...Array.from({ length: BOARD_COLS }, () => null)] };
}

/** Whether the last row is empty and there is more than one row: the only row that can go. */
export function canRemoveRow(board: KeyBoard): boolean {
  return board.rows > MIN_ROWS && board.cells.slice(-BOARD_COLS).every((k) => k === null);
}

export function removeRow(board: KeyBoard): KeyBoard {
  if (!canRemoveRow(board)) return board;
  return { rows: board.rows - 1, cells: board.cells.slice(0, -BOARD_COLS) };
}

export function keyCount(board: KeyBoard): number {
  return board.cells.filter((k) => k !== null).length;
}

/** How many rows the pad in use draws: trailing empty rows are not drawn. At least one. */
export function usedRows(board: KeyBoard): number {
  const last = board.cells.findLastIndex((k) => k !== null);
  return Math.max(MIN_ROWS, Math.floor(last / BOARD_COLS) + 1);
}

/** The chords a key sends, in order. A modifier key sends none. */
export function wireKeys(key: BoardKey): readonly string[] {
  return key.kind === "chord" ? key.steps : [];
}

// ── The code: one layout as a short piece of text ────────────────────────────────────────────────

/** `[cell, spec]` or `[cell, spec, label]`. A spec is `@ctrl` for a modifier key, else steps joined by a space. */
type WireKey = [number, string] | [number, string, string];

function specOf(key: BoardKey): string {
  return key.kind === "mod" ? `@${key.mod}` : key.steps.join(" ");
}

function toWire(board: KeyBoard): JsonValue {
  const keys: JsonValue[] = [];
  board.cells.forEach((key, cell) => {
    if (key === null) return;
    const row: WireKey = key.kind === "chord" && key.label !== undefined ? [cell, specOf(key), key.label] : [cell, specOf(key)];
    keys.push(row);
  });
  return { v: SCHEMA, rows: board.rows, keys };
}

/** The compact JSON of a layout. The same text goes to storage, and (base64url) into the code. */
export function serializeBoard(board: KeyBoard): string {
  return JSON.stringify(toWire(board));
}

export type BoardRefusal = "notJson" | "schema" | "rows" | "tooMany" | "noKeys" | "cell" | "key" | "label";

/** A board, or the first reason it is not one. */
export type BoardRead = { readonly ok: true; readonly board: KeyBoard } | { readonly ok: false; readonly reason: BoardRefusal };

const refuse = (reason: BoardRefusal) => ({ ok: false, reason }) as const;

type KeyRead = { readonly ok: true; readonly cell: number; readonly key: BoardKey } | { readonly ok: false; readonly reason: BoardRefusal };

function readKey(raw: JsonValue): KeyRead {
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) return refuse("key");
  const cell = asJsonNumber(raw[0]);
  const spec = asJsonString(raw[1]);
  if (cell === undefined || !Number.isInteger(cell) || cell < 0 || spec === undefined) return refuse("cell");
  if (spec.startsWith("@")) {
    const name = spec.slice(1);
    if (raw.length !== 2 || !isModifier(name)) return refuse("key");
    return { ok: true, cell, key: mod(name) };
  }
  const label = raw.length === 3 ? asJsonString(raw[2]) : undefined;
  if (raw.length === 3 && label === undefined) return refuse("label");
  const key = chordKey(spec.split(" "), label);
  if (key === null) return refuse(label === undefined ? "key" : "label");
  return { ok: true, cell, key };
}

/** Read the wire form. Total: every failure is a named refusal, never a throw. */
export function readBoard(value: JsonValue | undefined): BoardRead {
  const doc = asJsonObject(value);
  if (doc === undefined) return refuse("notJson");
  if (asJsonNumber(doc.v) !== SCHEMA) return refuse("schema");
  const rows = asJsonNumber(doc.rows);
  if (rows === undefined || !Number.isInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) return refuse("rows");
  const list = doc.keys;
  if (!Array.isArray(list)) return refuse("key");
  if (list.length > MAX_KEYS) return refuse("tooMany");
  if (list.length === 0) return refuse("noKeys");
  const cells: (BoardKey | null)[] = Array.from({ length: rows * BOARD_COLS }, () => null);
  for (const raw of list) {
    const read = readKey(raw);
    if (!read.ok) return read;
    if (read.cell >= cells.length || cells[read.cell] !== null) return refuse("cell");
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
 * then the prefix, the base64url alphabet, UTF-8, JSON, the schema number, the key count, and every
 * chord and label through the same readers storage uses. A refusal names the first thing that failed.
 */
export function decodeBoard(input: string): Decoded {
  const text = input.trim();
  if (text === "") return { ok: false, reason: "empty" };
  if (text.length > MAX_CODE_LENGTH) return { ok: false, reason: "tooLong" };
  if (!text.startsWith(CODE_PREFIX)) return { ok: false, reason: "notCode" };
  const json = fromBase64Url(text.slice(CODE_PREFIX.length));
  if (json === null) return { ok: false, reason: "damaged" };
  return parseBoard(json);
}

// ── The five presets ─────────────────────────────────────────────────────────────────────────────

export interface BoardPreset {
  readonly id: "default" | "claude" | "tmux" | "vim" | "navigation";
  readonly board: KeyBoard;
}

// Every preset keeps Esc, Enter and the four arrows (a person should never need Restore after
// choosing one), with Down under Up as on the Default, and Enter away from the arrows. The rest is
// spent on the tool the preset is named for. Each binding was checked against that tool's own
// documentation; the notes say which keys a multiplexer may refuse. No preset uses Ctrl+D or Ctrl+Z
// outside a sequence, because those two ask for a second tap and a scroll key must not.

/**
 * Claude Code (checked against its interactive-mode reference). Shift+Tab cycles the permission mode.
 * Esc stops the turn; Esc twice clears a draft, or opens the rewind menu on an empty prompt. `/` opens the slash-command menu. Ctrl+O shows the full transcript, Ctrl+T the task
 * list, Ctrl+R searches the prompt history, Ctrl+B sends a running command to the background (inside tmux, tap it twice), Ctrl+G
 * opens the draft in your editor, Alt+P switches the model.
 */
const CLAUDE: KeyBoard = boardOf(3, [
  [0, chord("Escape")],
  [1, chord("Escape", "Escape")],
  [2, chord("shift+Tab")],
  [3, chord("Tab")],
  [4, chord("/")],
  [5, chord("Up")],
  [6, chord("ctrl+c")],
  [7, chord("Space")],
  [8, chord("Enter")],
  [9, chord("ctrl+o")],
  [10, chord("ctrl+t")],
  [11, chord("Left")],
  [12, chord("Down")],
  [13, chord("Right")],
  [14, chord("ctrl+r")],
  [15, chord("ctrl+b")],
  [16, chord("ctrl+g")],
  [17, chord("alt+p")],
  [18, mod("shift")],
  [19, mod("ctrl")],
  [20, mod("alt")],
]);

/**
 * tmux with its default prefix, Ctrl+B. Each `Ctrl+B, x` key is a two-step sequence sent in order:
 * c new window, n and p next and previous window, % and " split side by side and stacked, o next
 * pane, z zoom, [ copy mode, w window tree, x close the pane (tmux asks you to confirm). These are
 * for a tmux running INSIDE the pane, for example over ssh: a tmux mirror sends keys straight to the
 * pane's program, so it never reads its own prefix.
 */
const TMUX: KeyBoard = boardOf(3, [
  [0, chord("Escape")],
  [1, named("Prefix", "ctrl+b")],
  [2, named("New win", "ctrl+b", "c")],
  [3, named("Next", "ctrl+b", "n")],
  [4, named("Prev", "ctrl+b", "p")],
  [5, chord("Up")],
  [6, chord("ctrl+c")],
  [7, named("Split |", "ctrl+b", "%")],
  [8, named("Split -", "ctrl+b", '"')],
  [9, named("Pane", "ctrl+b", "o")],
  [10, named("Zoom", "ctrl+b", "z")],
  [11, chord("Left")],
  [12, chord("Down")],
  [13, chord("Right")],
  [14, named("Copy", "ctrl+b", "[")],
  [15, named("Tree", "ctrl+b", "w")],
  [16, named("Close", "ctrl+b", "x")],
  [17, chord("Enter")],
  [18, mod("shift")],
  [19, mod("ctrl")],
  [20, mod("alt")],
]);

/**
 * Vim. Esc leaves insert mode, `i` enters it. `:` starts a command, `/` a search, `u` undoes and
 * Ctrl+R redoes. `:w` saves and `:wq` saves and quits, each ending in Enter. Ctrl+F and Ctrl+B page
 * down and up, Ctrl+V starts a block selection, `gg` and `G` jump to the top and the bottom, `dd`
 * deletes a line, `yy` copies it and `p` pastes.
 */
const VIM: KeyBoard = boardOf(3, [
  [0, chord("Escape")],
  [1, chord("i")],
  [2, chord(":")],
  [3, chord("/")],
  [4, chord("u")],
  [5, chord("Up")],
  [6, chord("p")],
  [7, named(":w", ":", "w", "Enter")],
  [8, chord("Enter")],
  [9, named(":wq", ":", "w", "q", "Enter")],
  [10, chord("ctrl+r")],
  [11, chord("Left")],
  [12, chord("Down")],
  [13, chord("Right")],
  [14, chord("ctrl+f")],
  [15, chord("ctrl+b")],
  [16, chord("ctrl+v")],
  [17, named("gg", "g", "g")],
  [18, chord("G")],
  [19, named("dd", "d", "d")],
  [20, named("yy", "y", "y")],
]);

/**
 * Navigation. Home, End, PageUp and PageDown for a long file or list, and the readline moves that
 * work in any shell: Ctrl+A and Ctrl+E jump to the line's start and end, Alt+B and Alt+F move by a
 * word, Ctrl+U clears the line, Ctrl+W deletes a word. Herdr refuses Home, End, PageUp, PageDown
 * and Delete (its `send_keys` has no such names), so on a Herdr pane those five stay grey and the
 * readline keys do the same work; tmux and zellij send all of them.
 */
const NAVIGATION: KeyBoard = boardOf(3, [
  [0, chord("Escape")],
  [1, chord("Home")],
  [2, chord("PageUp")],
  [3, chord("Up")],
  [4, chord("PageDown")],
  [5, chord("End")],
  [6, chord("Enter")],
  [7, chord("ctrl+a")],
  [8, chord("ctrl+e")],
  [9, chord("Left")],
  [10, chord("Down")],
  [11, chord("Right")],
  [12, chord("alt+b")],
  [13, chord("alt+f")],
  [14, chord("ctrl+u")],
  [15, chord("ctrl+w")],
  [16, chord("Backspace")],
  [17, chord("Delete")],
  [18, chord("Tab")],
  [19, chord("shift+Tab")],
  [20, chord("Space")],
]);

export const PRESETS: readonly BoardPreset[] = [
  { id: "default", board: DEFAULT_BOARD },
  { id: "claude", board: CLAUDE },
  { id: "tmux", board: TMUX },
  { id: "vim", board: VIM },
  { id: "navigation", board: NAVIGATION },
];

/** Whether two boards hold the same keys in the same cells. */
export function sameBoard(a: KeyBoard, b: KeyBoard): boolean {
  return serializeBoard(a) === serializeBoard(b);
}
