import { DEFAULT_BOARD, encodeBoard, keyCount, PRESETS, setCell, serializeBoard } from "./key-board";
import { __reloadKeyBoard, getKeyBoard, KEY_BOARD_STORAGE_KEY, resetKeyBoard, setKeyBoard } from "./key-board-store";

const claude = PRESETS[1].board;

beforeEach(() => {
  localStorage.clear();
  __reloadKeyBoard();
});

describe("the stored key board", () => {
  it("is the default board when nothing is stored", () => {
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
  });

  it("saves an edit at once, versioned, and reads it back after a reload", () => {
    setKeyBoard(claude);
    const raw = localStorage.getItem(KEY_BOARD_STORAGE_KEY);
    expect(raw).toBe(serializeBoard(claude));
    expect(JSON.parse(raw ?? "{}").v).toBe(2);
    __reloadKeyBoard();
    expect(keyCount(getKeyBoard())).toBe(keyCount(claude));
    expect(getKeyBoard().rows).toBe(claude.rows);
  });

  it("reads a version 1 board stored by an earlier build, every key one cell, and writes version 2 after the next edit", () => {
    localStorage.setItem(KEY_BOARD_STORAGE_KEY, JSON.stringify({ v: 1, rows: 1, keys: [[0, "Escape"], [1, "ctrl+b c", "Win"]] }));
    __reloadKeyBoard();
    expect(getKeyBoard().cells[0]).toEqual({ kind: "chord", steps: ["Escape"] });
    expect(getKeyBoard().cells[1]).toEqual({ kind: "chord", steps: ["ctrl+b", "c"], label: "Win" });
    setKeyBoard(setCell(getKeyBoard(), 2, { kind: "chord", steps: ["x"] }));
    expect(JSON.parse(localStorage.getItem(KEY_BOARD_STORAGE_KEY) ?? "{}").v).toBe(2);
  });

  it("keeps a wide key through a reload", () => {
    const wide = setCell(DEFAULT_BOARD, 8, null);
    const board = setCell(wide, 8, { kind: "chord", steps: ["Space"], w: 2 });
    setKeyBoard(board);
    __reloadKeyBoard();
    expect(getKeyBoard().cells[8]).toEqual({ kind: "chord", steps: ["Space"], w: 2 });
  });

  it("stores nothing for the default, and Restore removes the key", () => {
    setKeyBoard(claude);
    resetKeyBoard();
    expect(localStorage.getItem(KEY_BOARD_STORAGE_KEY)).toBeNull();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
    setKeyBoard(DEFAULT_BOARD);
    expect(localStorage.getItem(KEY_BOARD_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["junk", "not json"],
    ["a cut-off write", serializeBoard(claude).slice(0, 40)],
    ["a future schema", JSON.stringify({ v: 3, rows: 1, keys: [[0, "a"]] })],
    ["an area off the board", JSON.stringify({ v: 2, rows: 1, keys: [[5, "a", null, 3, 1]] })],
    ["two keys on one area", JSON.stringify({ v: 2, rows: 1, keys: [[0, "a", null, 3, 1], [1, "b"]] })],
    ["an array", "[1,2,3]"],
    ["a bad chord", JSON.stringify({ v: 1, rows: 1, keys: [[0, "ctrl+nope"]] })],
    ["an empty board", JSON.stringify({ v: 1, rows: 1, keys: [] })],
    ["a layout code, not the stored text", encodeBoard(claude)],
    ["null", "null"],
  ])("falls back to the default for %s, and never throws", (_name, raw) => {
    localStorage.setItem(KEY_BOARD_STORAGE_KEY, raw);
    expect(() => __reloadKeyBoard()).not.toThrow();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
  });

  it("keeps working in memory when storage refuses a write", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    try {
      expect(() => setKeyBoard(setCell(DEFAULT_BOARD, 8, null))).not.toThrow();
      expect(keyCount(getKeyBoard())).toBe(11);
      setKeyBoard(claude);
      expect(getKeyBoard()).toBe(claude);
    } finally {
      spy.mockRestore();
    }
  });
});
