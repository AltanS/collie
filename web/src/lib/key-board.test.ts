import {
  addRow,
  areaFits,
  areaCss,
  BOARD_COLS,
  boardOf,
  canonicalStep,
  canRemoveRow,
  chordKey,
  clampAnchor,
  CODE_PREFIX,
  CORE_KEYS,
  DEFAULT_BOARD,
  decodeBoard,
  defaultLabel,
  dropKey,
  encodeBoard,
  keyCount,
  keyLabel,
  MAX_CODE_LENGTH,
  MAX_KEYS,
  MAX_ROWS,
  missingCore,
  needsSecondTap,
  owners,
  parseBoard,
  parseStep,
  PRESETS,
  putBackCore,
  removeRow,
  resizeKey,
  sameBoard,
  serializeBoard,
  setCell,
  spanOf,
  stepFace,
  stepKey,
  stepsWords,
  stepWords,
  usedRows,
  withSize,
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
  it("is today's pad in 7 columns: Space three wide, Enter set apart from the arrows", () => {
    const at = (i: number) => DEFAULT_BOARD.cells[i];
    expect(DEFAULT_BOARD.rows).toBe(2);
    expect(DEFAULT_BOARD.cells).toHaveLength(14);
    expect(at(0)).toEqual(key("Escape"));
    expect(at(2)).toEqual({ kind: "mod", mod: "shift" });
    expect(at(6)).toEqual(key("ctrl+c"));
    expect(at(7)).toEqual(key("Enter"));
    expect(at(8)).toEqual({ kind: "chord", steps: ["Space"], w: 3 });
    // The cells Space covers hold nothing of their own, and nothing is free: the pad is full.
    expect(at(9)).toBeNull();
    expect(at(10)).toBeNull();
    expect(owners(DEFAULT_BOARD).slice(7, 14)).toEqual([7, 8, 8, 8, 11, 12, 13]);
    expect(owners(DEFAULT_BOARD)).not.toContain(-1);
    // Down sits under Up, and Space stands between Enter and the arrows (issue 263).
    const col = (step: string) => DEFAULT_BOARD.cells.findIndex((k) => k?.kind === "chord" && k.steps[0] === step) % BOARD_COLS;
    expect(col("Down")).toBe(col("Up"));
    expect(Math.abs(col("Enter") - col("Left"))).toBeGreaterThan(1);
    expect(keyCount(DEFAULT_BOARD)).toBe(12);
    expect(missingCore(DEFAULT_BOARD)).toEqual([]);
  });

  it("places a wide key with a CSS span", () => {
    expect(areaCss(8, { kind: "chord", steps: ["Space"], w: 3 })).toEqual({ gridColumn: "2 / span 3", gridRow: "2 / span 1" });
    expect(areaCss(0, { kind: "chord", steps: ["Enter"], h: 2 })).toEqual({ gridColumn: "1 / span 1", gridRow: "1 / span 2" });
  });
});

// A small board for the area tests: three rows, so a tall key has room.
//
//     a a a b . .  .
//     c . . d . .  .
//     e f . . . .  .
const A = key("a");
const grid = (entries: readonly (readonly [number, BoardKey])[]): KeyBoard => boardOf(3, entries);

describe("areas: a key spans columns and rows", () => {
  it("reads sizes, covers cells, and lets a one-cell key stay plain", () => {
    expect(spanOf(A)).toEqual({ w: 1, h: 1 });
    const wide = withSize(A, 3, 2);
    expect(wide).toEqual({ kind: "chord", steps: ["a"], w: 3, h: 2 });
    expect(withSize(wide, 1, 1)).toEqual(A);
    expect(withSize(A, 9, 9)).toEqual({ kind: "chord", steps: ["a"], w: 3, h: 2 });
    const board = grid([[0, withSize(A, 3, 2)], [3, key("b")]]);
    expect(owners(board).slice(0, 14)).toEqual([0, 0, 0, 3, -1, -1, -1, 0, 0, 0, -1, -1, -1, -1]);
  });

  it("fits an area only inside the board and on free cells", () => {
    const board = grid([[0, A], [9, key("b")]]);
    expect(areaFits(board, 1, 3, 1)).toBe(true);
    expect(areaFits(board, 5, 3, 1)).toBe(false); // runs off the right edge
    expect(areaFits(board, 14, 1, 2)).toBe(false); // runs off the bottom
    expect(areaFits(board, 8, 2, 1)).toBe(false); // covers b
    expect(areaFits(board, 8, 2, 1, 9)).toBe(true); // ...unless b is the key being moved
    expect(areaFits(board, 0, 1, 1, 0)).toBe(true);
    expect(areaFits(board, 0, 1, 1)).toBe(false);
  });

  it("clamps a dragged corner back inside the board", () => {
    const board = grid([]);
    expect(clampAnchor(board, 6, 0, 3, 1)).toBe(4);
    expect(clampAnchor(board, -2, 5, 2, 2)).toBe(7);
    expect(clampAnchor(board, 3, 1, 1, 1)).toBe(10);
  });

  it("adds a key only where its whole area is free", () => {
    const board = grid([[0, withSize(A, 2, 1)]]);
    expect(setCell(board, 1, key("x"))).toBe(board); // covered by a
    expect(setCell(board, 2, key("x")).cells[2]).toEqual(key("x"));
    expect(setCell(board, 6, withSize(key("x"), 2, 1))).toBe(board); // off the edge
    // Replacing a key at its anchor may keep its size.
    expect(setCell(board, 0, withSize(key("x"), 2, 1)).cells[0]).toEqual(withSize(key("x"), 2, 1));
    // Removing: only a key's own anchor.
    expect(setCell(board, 1, null)).toBe(board);
    expect(setCell(board, 0, null).cells[0]).toBeNull();
  });
});

describe("moving keys by drop", () => {
  it("moves a key into a free area, wide or not", () => {
    const board = grid([[0, withSize(A, 3, 1)], [7, key("c")]]);
    const res = dropKey(board, 0, 2);
    expect(res.kind).toBe("move");
    if (res.kind === "move") {
      expect(res.at).toBe(2);
      expect(res.board.cells[0]).toBeNull();
      expect(res.board.cells[2]).toEqual(withSize(A, 3, 1));
    }
  });

  it("lets a key slide over its own old cells", () => {
    const board = grid([[0, withSize(A, 3, 1)]]);
    const res = dropKey(board, 0, 1);
    expect(res.kind).toBe("move");
  });

  it("swaps two keys of the same size, and puts neither anywhere else", () => {
    const board = grid([[0, key("a")], [3, key("b")], [7, withSize(key("c"), 2, 1)], [9, withSize(key("d"), 2, 1)]]);
    const one = dropKey(board, 0, 3);
    expect(one.kind).toBe("swap");
    if (one.kind === "swap") {
      expect(one.board.cells[0]).toEqual(key("b"));
      expect(one.board.cells[3]).toEqual(key("a"));
      expect(one.at).toBe(3);
    }
    // Dropped on the SECOND cell of a same-size neighbour: still a swap with that neighbour.
    const two = dropKey(board, 7, 10);
    expect(two.kind).toBe("swap");
    if (two.kind === "swap") {
      expect(two.board.cells[7]).toEqual(withSize(key("d"), 2, 1));
      expect(two.board.cells[9]).toEqual(withSize(key("c"), 2, 1));
    }
  });

  it("refuses a drop on a key of another size, and says which key is in the way", () => {
    const board = grid([[0, key("a")], [3, withSize(key("b"), 2, 1)]]);
    expect(dropKey(board, 0, 3)).toEqual({ kind: "refused", reason: "blocked", by: 3 });
    // A wide key dropped so that its tail lands on another key.
    const wide = grid([[0, withSize(key("a"), 2, 1)], [9, key("b")]]);
    expect(dropKey(wide, 0, 8)).toEqual({ kind: "refused", reason: "blocked", by: 9 });
    // Nothing moved: the board is the caller's own value.
    expect(wide.cells[0]).toEqual(withSize(key("a"), 2, 1));
  });

  it("refuses an area that leaves the board, and does nothing for a drop on itself", () => {
    const board = grid([[0, withSize(A, 3, 1)]]);
    expect(dropKey(board, 0, 6)).toEqual({ kind: "refused", reason: "edge" });
    expect(dropKey(board, 0, 0)).toEqual({ kind: "none" });
    expect(dropKey(board, 5, 6)).toEqual({ kind: "none" }); // nothing there to lift
  });
});

describe("moving keys by arrow", () => {
  it("skips keys in the way and lands on the next place where the area fits", () => {
    const roomy = grid([[0, withSize(A, 2, 1)], [2, key("b")]]);
    const skipped = stepKey(roomy, 0, 1, 0);
    expect(skipped.kind).toBe("move");
    if (skipped.kind === "move") expect(skipped.at).toBe(3);
    // Nothing fits to the right: b and c are in the way and the edge ends the search.
    const jammed = grid([[0, withSize(A, 2, 1)], [2, key("b")], [3, key("c")], [4, key("d")], [5, key("e")], [6, key("f")]]);
    expect(stepKey(jammed, 0, 1, 0).kind).toBe("none");
    // A same-size key further along is a swap, not a skip.
    const swappable = grid([[0, withSize(A, 2, 1)], [2, key("b")], [3, withSize(key("d"), 2, 1)]]);
    const swapped = stepKey(swappable, 0, 1, 0);
    expect(swapped.kind).toBe("swap");
    if (swapped.kind === "swap") expect(swapped.at).toBe(3);
  });

  it("swaps with a same-size neighbour when an arrow runs into one, as before", () => {
    const res = stepKey(DEFAULT_BOARD, 0, 1, 0);
    expect(res.kind).toBe("swap");
    if (res.kind === "swap") {
      expect(res.board.cells[0]).toEqual(key("Tab"));
      expect(res.board.cells[1]).toEqual(key("Escape"));
      expect(res.at).toBe(1);
    }
  });

  it("stays put at an edge, and for a tall key where there are no rows", () => {
    expect(stepKey(DEFAULT_BOARD, 0, -1, 0).kind).toBe("none");
    expect(stepKey(DEFAULT_BOARD, 0, 0, -1).kind).toBe("none");
    const tall = boardOf(2, [[0, withSize(A, 1, 2)]]);
    expect(stepKey(tall, 0, 0, 1).kind).toBe("none");
    expect(stepKey(tall, 0, 1, 0).kind).toBe("move");
  });
});

describe("resizing", () => {
  const board = grid([[0, A], [1, key("b")], [7, key("c")]]);

  it("grows right and down over free cells, and shrinks any time", () => {
    const wider = resizeKey(grid([[0, A]]), 0, 3, 2);
    expect(wider.ok).toBe(true);
    if (wider.ok) {
      expect(wider.board.cells[0]).toEqual(withSize(A, 3, 2));
      const back = resizeKey(wider.board, 0, 1, 1);
      expect(back.ok && back.board.cells[0]).toEqual(A);
    }
  });

  it("is blocked by a key in the way and by the edge, and names the key", () => {
    expect(resizeKey(board, 0, 2, 1)).toEqual({ ok: false, reason: "blocked", by: 1 });
    expect(resizeKey(board, 0, 1, 2)).toEqual({ ok: false, reason: "blocked", by: 7 });
    expect(resizeKey(board, 1, 3, 1)).toMatchObject({ ok: true });
    expect(resizeKey(grid([[6, A]]), 6, 2, 1)).toEqual({ ok: false, reason: "edge" });
    expect(resizeKey(grid([[14, A]]), 14, 1, 2)).toEqual({ ok: false, reason: "edge" });
    expect(resizeKey(board, 0, 4, 1)).toEqual({ ok: false, reason: "edge" });
    expect(resizeKey(board, 9, 1, 1)).toEqual({ ok: false, reason: "edge" }); // nothing there
  });

  it("never moves another key", () => {
    const res = resizeKey(board, 0, 2, 1);
    expect(res.ok).toBe(false);
    expect(board.cells[1]).toEqual(key("b"));
  });

  it("a tall key keeps its last row from being removed", () => {
    const tall = addRow(boardOf(2, [[7, withSize(A, 1, 2)]]));
    expect(tall.rows).toBe(3);
    expect(canRemoveRow(tall)).toBe(false);
    expect(usedRows(tall)).toBe(3);
  });
});

describe("rows and spaces", () => {
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
    let board = setCell(setCell(DEFAULT_BOARD, 0, null), 7, null);
    expect(missingCore(board)).toEqual(["Esc", "Enter"]);
    board = putBackCore(board);
    expect(missingCore(board)).toEqual([]);
    expect(board.cells[0]).toEqual(key("Escape"));
    expect(board.cells[7]).toEqual(key("Enter"));

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
    expect(code.startsWith("collie-keys:2:")).toBe(true);
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
    expect(reason("collie-keys:3:abc")).toBe("notCode");
    expect(reason(CODE_PREFIX + "x".repeat(MAX_CODE_LENGTH))).toBe("tooLong");
    expect(reason(CODE_PREFIX + "not base64!")).toBe("damaged");
    expect(reason(CODE_PREFIX + "a")).toBe("damaged");
    expect(reason(CODE_PREFIX + b64("not json"))).toBe("notJson");
    expect(reason(codeOf([1, 2]))).toBe("notJson");
    expect(reason(codeOf({ v: 3, rows: 1, keys: [[0, "a"]] }))).toBe("schema");
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
    // Sizes: schema 1 has none, schema 2 has both or neither, in range.
    expect(reason(codeOf({ v: 1, rows: 1, keys: [[0, "a", null, 2, 1]] }))).toBe("key");
    expect(reason(codeOf({ v: 2, rows: 1, keys: [[0, "a", null, 2]] }))).toBe("key");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, 4, 1]] }))).toBe("key");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, 1, 3]] }))).toBe("key");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, 1.5, 1]] }))).toBe("key");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, "2", 1]] }))).toBe("key");
    // Areas: inside the board, and overlapping nothing.
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[5, "a", null, 3, 1]] }))).toBe("area");
    expect(reason(codeOf({ v: 2, rows: 1, keys: [[0, "a", null, 1, 2]] }))).toBe("area");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, 3, 1], [2, "b"]] }))).toBe("cell");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[2, "b"], [0, "a", null, 3, 1]] }))).toBe("area");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, 1, 2], [7, "b"]] }))).toBe("cell");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, 3, 2], [8, "b"]] }))).toBe("cell");
    expect(reason(codeOf({ v: 2, rows: 2, keys: [[0, "a", null, 2, 2], [8, "b", null, 2, 1]] }))).toBe("cell");
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

describe("sizes in the layout code", () => {
  it("round-trips wide and tall keys, named or not, modifier or chord", () => {
    const board = boardOf(3, [
      [0, withSize(A, 3, 1)],
      [3, withSize({ kind: "chord", steps: ["ctrl+b", "c"], label: "Win" }, 2, 2)],
      [5, withSize({ kind: "mod", mod: "ctrl" }, 1, 2)],
      [14, key("z")],
    ]);
    const decoded = decodeBoard(encodeBoard(board));
    expect(decoded.ok && decoded.board).toEqual(board);
    const json = JSON.parse(serializeBoard(board));
    expect(json.v).toBe(2);
    expect(json.keys).toEqual([[0, "a", null, 3, 1], [3, "ctrl+b c", "Win", 2, 2], [5, "@ctrl", null, 1, 2], [14, "z"]]);
  });

  it("still reads a version 1 code and a version 1 stored board, every key one cell", () => {
    const v1 = { v: 1, rows: 2, keys: [[0, "Escape"], [1, "@shift"], [7, "ctrl+b c", "Win"]] };
    const old = decodeBoard("collie-keys:1:" + b64(JSON.stringify(v1)));
    expect(old.ok).toBe(true);
    if (old.ok) {
      expect(old.board.cells[0]).toEqual(key("Escape"));
      expect(old.board.cells[1]).toEqual({ kind: "mod", mod: "shift" });
      expect(old.board.cells[7]).toEqual({ kind: "chord", steps: ["ctrl+b", "c"], label: "Win" });
      expect(owners(old.board).filter((o) => o >= 0)).toHaveLength(3);
      // Written back, it is schema 2.
      expect(JSON.parse(serializeBoard(old.board)).v).toBe(2);
    }
    const stored = parseBoard(JSON.stringify(v1));
    expect(stored.ok && stored.board.cells[7]).toEqual({ kind: "chord", steps: ["ctrl+b", "c"], label: "Win" });
  });
});

describe("storage text", () => {
  it("is versioned and reads back", () => {
    const text = serializeBoard(DEFAULT_BOARD);
    expect(JSON.parse(text).v).toBe(2);
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
    // No overlaps, nothing off the board: it survives its own validator.
    const again = parseBoard(serializeBoard(board));
    expect(again.ok && again.board).toEqual(board);
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

  it("every preset has Space three cells wide between Enter and the arrows", () => {
    for (const p of PRESETS) {
      expect(p.board.cells[7]).toEqual(key("Enter"));
      expect(p.board.cells[8]).toEqual({ kind: "chord", steps: ["Space"], w: 3 });
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
