import {
  addRow,
  BOARD_COLS,
  boardOf,
  canonicalStep,
  canRemoveRow,
  chordKey,
  CODE_PREFIX,
  CORE_KEYS,
  DEFAULT_BOARD,
  decodeBoard,
  defaultLabel,
  encodeBoard,
  keyCount,
  keyLabel,
  MAX_CODE_LENGTH,
  MAX_KEYS,
  MAX_ROWS,
  missingCore,
  needsSecondTap,
  neighbour,
  parseBoard,
  parseStep,
  PRESETS,
  putBackCore,
  removeRow,
  sameBoard,
  serializeBoard,
  setCell,
  stepFace,
  stepsWords,
  stepWords,
  swapCells,
  usedRows,
  type BoardKey,
  type KeyBoard,
} from "./key-board";
import type { JsonValue } from "./json";
import { keysSendable } from "./mux-capability";

const HERDR_REFUSES = ["PageUp", "PageDown", "Home", "End", "Insert", "Delete"];

function key(...steps: string[]): BoardKey {
  const made = chordKey(steps);
  if (made === null) throw new Error(`not a key: ${steps.join(" ")}`);
  return made;
}

const b64 = (text: string) => btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const codeOf = (doc: JsonValue) => CODE_PREFIX + b64(JSON.stringify(doc));

describe("the chord grammar", () => {
  it("reads up to three modifiers and one key, in any order and case, and writes one spelling", () => {
    // A literal character keeps its case: it IS the character typed.
    expect(canonicalStep("Shift+Alt+CTRL+T")).toBe("ctrl+alt+shift+T");
    expect(canonicalStep("ctrl+alt+shift+t")).toBe("ctrl+alt+shift+t");
    expect(canonicalStep("shift+tab")).toBe("shift+Tab");
    expect(canonicalStep("escape")).toBe("Escape");
    expect(canonicalStep("f7")).toBe("F7");
    expect(canonicalStep("ctrl++")).toBe("ctrl++");
    expect(canonicalStep("%")).toBe("%");
    expect(canonicalStep('"')).toBe('"');
    expect(parseStep("ctrl+alt+shift+t")).toEqual({ mods: ["ctrl", "alt", "shift"], base: "t" });
  });

  it.each([
    "",
    "ctrl",
    "ctrl+",
    "ctrl+ctrl+c",
    "meta+c",
    "cmd+c",
    "ctrl+ab",
    "ctrl+F13",
    "ctrl+ ",
    " ",
    "é",
    "ctrl+c+d",
    "a".repeat(80),
    "ctrl+\n",
  ])("refuses %j", (raw) => {
    expect(parseStep(raw)).toBeNull();
  });

  it("gives a face for the cell and words for the screen reader", () => {
    expect(stepFace("ctrl+w")).toBe("^W");
    expect(stepFace("Escape")).toBe("Esc");
    expect(stepFace("ctrl+alt+shift+t")).toBe("^⌥⇧T");
    expect(stepFace("PageDown")).toBe("PgDn");
    expect(stepWords("ctrl+alt+shift+t")).toBe("Ctrl+Alt+Shift+T");
    expect(stepWords("Escape")).toBe("Esc");
    expect(stepsWords(["ctrl+b", "c"], "then")).toBe("Ctrl+B, then C");
    expect(defaultLabel(["ctrl+b", "c"])).toBe("^B C");
  });
});

describe("a chord key", () => {
  it("holds one to four steps and drops a name equal to its own face", () => {
    expect(chordKey([])).toBeNull();
    expect(chordKey(["a", "b", "c", "d"])).not.toBeNull();
    expect(chordKey(["a", "b", "c", "d", "e"])).toBeNull();
    expect(chordKey(["ctrl+nope"])).toBeNull();
    expect(chordKey(["ctrl+w"], "^W")).toEqual({ kind: "chord", steps: ["ctrl+w"] });
    expect(chordKey(["ctrl+w"], "Word")).toEqual({ kind: "chord", steps: ["ctrl+w"], label: "Word" });
  });

  it("refuses a name with a control character, a line break, or too many characters", () => {
    expect(chordKey(["a"], "bad\nname")).toBeNull();
    expect(chordKey(["a"], "bad\u0000")).toBeNull();
    expect(chordKey(["a"], "bad x")).toBeNull();
    expect(chordKey(["a"], "bad‮x")).toBeNull();
    expect(chordKey(["a"], "   ")).toBeNull();
    expect(chordKey(["a"], "x".repeat(13))).toBeNull();
    expect(chordKey(["a"], "x".repeat(12))).not.toBeNull();
  });

  it("asks a second tap for a danger step, except the lone Ctrl+C", () => {
    expect(needsSecondTap(key("ctrl+d"))).toBe(true);
    expect(needsSecondTap(key("ctrl+z"))).toBe(true);
    expect(needsSecondTap(key("ctrl+c"))).toBe(false);
    expect(needsSecondTap(key("ctrl+b", "ctrl+c"))).toBe(true);
    expect(needsSecondTap(key("ctrl+b", "c"))).toBe(false);
    expect(needsSecondTap({ kind: "mod", mod: "ctrl" })).toBe(false);
  });

  it("labels itself from its steps unless it was named", () => {
    expect(keyLabel(key("ctrl+b", "c"))).toBe("^B C");
    expect(keyLabel({ kind: "mod", mod: "shift" })).toBe("⇧");
    expect(keyLabel({ kind: "chord", steps: ["a"], label: "Mine" })).toBe("Mine");
  });
});

describe("the default board", () => {
  it("is today's pad in 7 columns, each key one cell", () => {
    const at = (i: number) => DEFAULT_BOARD.cells[i];
    expect(DEFAULT_BOARD.rows).toBe(2);
    expect(DEFAULT_BOARD.cells).toHaveLength(14);
    expect(at(0)).toEqual(key("Escape"));
    expect(at(2)).toEqual({ kind: "mod", mod: "shift" });
    expect(at(6)).toEqual(key("ctrl+c"));
    expect(at(8)).toEqual(key("Enter"));
    // Down sits under Up; Enter is two empty cells from Left.
    expect((DEFAULT_BOARD.cells.findIndex((k) => k?.kind === "chord" && k.steps[0] === "Up")) % BOARD_COLS).toBe(
      DEFAULT_BOARD.cells.findIndex((k) => k?.kind === "chord" && k.steps[0] === "Down") % BOARD_COLS,
    );
    expect(at(9)).toBeNull();
    expect(at(10)).toBeNull();
    expect(keyCount(DEFAULT_BOARD)).toBe(12);
    expect(missingCore(DEFAULT_BOARD)).toEqual([]);
  });
});

describe("moving keys", () => {
  it("swaps two full cells, moves into an empty one, and ignores a bad index", () => {
    const swapped = swapCells(DEFAULT_BOARD, 0, 1);
    expect(swapped.cells[0]).toEqual(key("Tab"));
    expect(swapped.cells[1]).toEqual(key("Escape"));
    const moved = swapCells(DEFAULT_BOARD, 0, 9);
    expect(moved.cells[0]).toBeNull();
    expect(moved.cells[9]).toEqual(key("Escape"));
    expect(swapCells(DEFAULT_BOARD, 0, 99)).toBe(DEFAULT_BOARD);
    expect(swapCells(DEFAULT_BOARD, 3, 3)).toBe(DEFAULT_BOARD);
  });

  it("finds a neighbour one cell away and stops at the edges", () => {
    expect(neighbour(DEFAULT_BOARD, 0, 1, 0)).toBe(1);
    expect(neighbour(DEFAULT_BOARD, 0, 0, 1)).toBe(7);
    expect(neighbour(DEFAULT_BOARD, 0, -1, 0)).toBe(-1);
    expect(neighbour(DEFAULT_BOARD, 0, 0, -1)).toBe(-1);
    expect(neighbour(DEFAULT_BOARD, 6, 1, 0)).toBe(-1);
    expect(neighbour(DEFAULT_BOARD, 7, 0, 1)).toBe(-1);
  });

  it("adds a row up to the cap, and removes only an empty last row", () => {
    let board: KeyBoard = DEFAULT_BOARD;
    expect(canRemoveRow(board)).toBe(false);
    board = addRow(board);
    expect(board.rows).toBe(3);
    expect(board.cells).toHaveLength(21);
    expect(canRemoveRow(board)).toBe(true);
    expect(usedRows(board)).toBe(2);
    expect(removeRow(board).rows).toBe(2);
    board = setCell(board, 20, key("x"));
    expect(canRemoveRow(board)).toBe(false);
    expect(usedRows(board)).toBe(3);
    expect(removeRow(board)).toBe(board);
    for (let i = 0; i < 20; i++) board = addRow(board);
    expect(board.rows).toBe(MAX_ROWS);
  });

  it("keeps one row, even for an empty board", () => {
    expect(usedRows(boardOf(1, []))).toBe(1);
    expect(canRemoveRow(boardOf(1, []))).toBe(false);
  });
});

describe("the core keys", () => {
  it("names what is missing and puts it back in its own cell, else the first free one", () => {
    let board = setCell(setCell(DEFAULT_BOARD, 0, null), 8, null);
    expect(missingCore(board)).toEqual(["Esc", "Enter"]);
    board = putBackCore(board);
    expect(missingCore(board)).toEqual([]);
    expect(board.cells[0]).toEqual(key("Escape"));
    expect(board.cells[8]).toEqual(key("Enter"));

    // Esc's cell is taken: it goes to the first free cell.
    const taken = setCell(setCell(DEFAULT_BOARD, 0, key("x")), 5, null);
    const back = putBackCore(setCell(taken, 1, null));
    expect(missingCore(back)).toEqual([]);
  });

  it("adds a row when the board is full", () => {
    const full: KeyBoard = { rows: 1, cells: Array.from({ length: 7 }, () => key("x")) };
    const back = putBackCore(full);
    expect(back.rows).toBeGreaterThan(1);
    expect(missingCore(back)).toEqual([]);
  });

  it("counts a key only when it is exactly that one step", () => {
    const board = boardOf(1, [[0, key("Escape", "Escape")]]);
    expect(missingCore(board)).toContain("Esc");
    expect(CORE_KEYS).toHaveLength(6);
  });
});

describe("the layout code", () => {
  it("round-trips the default, every preset, and a named sequence", () => {
    for (const board of [DEFAULT_BOARD, ...PRESETS.map((p) => p.board)]) {
      const decoded = decodeBoard(encodeBoard(board));
      expect(decoded.ok).toBe(true);
      if (decoded.ok) expect(sameBoard(decoded.board, board)).toBe(true);
    }
    const named = boardOf(1, [[3, { kind: "chord", steps: ["ctrl+b", "c"], label: "Win é" }]]);
    const decoded = decodeBoard(encodeBoard(named));
    expect(decoded.ok && decoded.board).toEqual(named);
  });

  it("starts with the versioned prefix and stays short", () => {
    const code = encodeBoard(DEFAULT_BOARD);
    expect(code.startsWith("collie-keys:1:")).toBe(true);
    expect(code.length).toBeLessThan(400);
    expect(/^[A-Za-z0-9_:-]+$/.test(code)).toBe(true);
  });

  it("tolerates whitespace around a pasted code", () => {
    expect(decodeBoard(`  ${encodeBoard(DEFAULT_BOARD)}\n`).ok).toBe(true);
  });

  const reason = (input: string) => {
    const result = decodeBoard(input);
    return result.ok ? "ok" : result.reason;
  };

  it("refuses, by name, everything that is not a whole good layout", () => {
    expect(reason("")).toBe("empty");
    expect(reason("hello")).toBe("notCode");
    expect(reason("collie-keys:2:abc")).toBe("notCode");
    expect(reason(CODE_PREFIX + "x".repeat(MAX_CODE_LENGTH))).toBe("tooLong");
    expect(reason(CODE_PREFIX + "not base64!")).toBe("damaged");
    expect(reason(CODE_PREFIX + "a")).toBe("damaged");
    expect(reason(CODE_PREFIX + b64("not json"))).toBe("notJson");
    expect(reason(codeOf([1, 2]))).toBe("notJson");
    expect(reason(codeOf({ v: 2, rows: 1, keys: [[0, "a"]] }))).toBe("schema");
    expect(reason(codeOf({ rows: 1, keys: [[0, "a"]] }))).toBe("schema");
    expect(reason(codeOf({ v: 1, rows: 0, keys: [[0, "a"]] }))).toBe("rows");
    expect(reason(codeOf({ v: 1, rows: 9, keys: [[0, "a"]] }))).toBe("rows");
    expect(reason(codeOf({ v: 1, rows: 1.5, keys: [[0, "a"]] }))).toBe("rows");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [] }))).toBe("noKeys");
    expect(reason(codeOf({ v: 1, rows: 1, keys: "a" }))).toBe("key");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[7, "a"]] }))).toBe("cell");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[-1, "a"]] }))).toBe("cell");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "a"], [0, "b"]] }))).toBe("cell");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "ctrl+nope"]] }))).toBe("key");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "a b c d e"]] }))).toBe("key");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "@nope"]] }))).toBe("key");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "a", "bad\u0001"]] }))).toBe("label");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "a", "x".repeat(40)]] }))).toBe("label");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "a", 5]] }))).toBe("label");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "a", "ok", "extra"]] }))).toBe("key");
    expect(reason(codeOf({ v: 1, rows: 1, keys: [["0", "a"]] }))).toBe("cell");
  });

  it("refuses more keys than the board can hold", () => {
    const keys = Array.from({ length: MAX_KEYS + 1 }, (_, i) => [i, "a"]);
    expect(reason(codeOf({ v: 1, rows: MAX_ROWS, keys }))).toBe("tooMany");
  });

  it("refuses invalid UTF-8 inside a well-formed base64url body", () => {
    const bad = btoa(String.fromCharCode(0xff, 0xfe, 0xfd)).replace(/=+$/, "");
    expect(reason(CODE_PREFIX + bad)).toBe("damaged");
  });

  it("canonicalises a chord it reads", () => {
    const decoded = decodeBoard(codeOf({ v: 1, rows: 1, keys: [[0, "Shift+CTRL+t"]] }));
    expect(decoded.ok && decoded.board.cells[0]).toEqual(key("ctrl+shift+t"));
  });
});

describe("storage text", () => {
  it("is versioned and reads back", () => {
    const text = serializeBoard(DEFAULT_BOARD);
    expect(JSON.parse(text).v).toBe(1);
    expect(parseBoard(text).ok).toBe(true);
    expect(parseBoard("{")).toEqual({ ok: false, reason: "notJson" });
    expect(parseBoard('{"v":9}')).toEqual({ ok: false, reason: "schema" });
  });
});

describe("the five presets", () => {
  it("are the five named ones, in order", () => {
    expect(PRESETS.map((p) => p.id)).toEqual(["default", "claude", "tmux", "vim", "navigation"]);
  });

  it.each(PRESETS.map((p) => [p.id, p.board] as const))("%s is a whole board: valid, capped, with the core keys", (_id, board) => {
    expect(board.cells).toHaveLength(board.rows * BOARD_COLS);
    expect(board.rows).toBeLessThanOrEqual(MAX_ROWS);
    expect(keyCount(board)).toBeLessThanOrEqual(MAX_KEYS);
    expect(missingCore(board)).toEqual([]);
    for (const cell of board.cells) {
      if (cell?.kind !== "chord") continue;
      expect(cell.steps.length).toBeLessThanOrEqual(4);
      for (const step of cell.steps) expect(canonicalStep(step)).toBe(step);
      if (cell.label !== undefined) expect(chordKey(cell.steps, cell.label)).toEqual(cell);
    }
  });

  it.each(PRESETS.map((p) => [p.id, p.board] as const))("%s keeps Down under Up and Enter away from the arrows", (_id, board) => {
    const at = (step: string) => board.cells.findIndex((k) => k?.kind === "chord" && k.steps.length === 1 && k.steps[0] === step);
    expect(at("Down") % BOARD_COLS).toBe(at("Up") % BOARD_COLS);
    const near = [at("Left"), at("Down"), at("Right"), at("Up")];
    expect(near.some((cell) => Math.abs(cell - at("Enter")) === 1)).toBe(false);
  });

  it("no preset puts a danger step on a key someone taps repeatedly, except the stock ^C", () => {
    for (const p of PRESETS) {
      for (const cell of p.board.cells) if (cell !== null && cell.kind === "chord" && cell.steps[0] !== "ctrl+c") expect(needsSecondTap(cell)).toBe(false);
    }
  });

  it("the tmux board sends the real prefix sequences", () => {
    const tmux = PRESETS.find((p) => p.id === "tmux")?.board;
    const steps = tmux?.cells.flatMap((k) => (k?.kind === "chord" && k.steps.length === 2 ? [k.steps.join(" ")] : [])) ?? [];
    expect(steps).toEqual(
      expect.arrayContaining(["ctrl+b c", "ctrl+b n", "ctrl+b p", "ctrl+b %", 'ctrl+b "', "ctrl+b o", "ctrl+b z", "ctrl+b [", "ctrl+b w", "ctrl+b x"]),
    );
  });

  it("the navigation board has Home, End, PageUp and PageDown, and Herdr greys exactly those and Delete", () => {
    const nav = PRESETS.find((p) => p.id === "navigation")?.board;
    const grey = (nav?.cells ?? []).flatMap((k) => (k?.kind === "chord" && !keysSendable(k.steps, HERDR_REFUSES) ? [k.steps[0]] : []));
    expect(grey.toSorted()).toEqual(["Delete", "End", "Home", "PageDown", "PageUp"]);
  });

  it("only the navigation board holds keys Herdr refuses", () => {
    for (const p of PRESETS.filter((x) => x.id !== "navigation")) {
      for (const cell of p.board.cells) if (cell?.kind === "chord") expect(keysSendable(cell.steps, HERDR_REFUSES)).toBe(true);
    }
  });
});
