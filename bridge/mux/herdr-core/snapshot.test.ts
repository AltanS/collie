import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAnsi } from "../../../web/src/lib/ansi.ts";
import { lineText, splitLines } from "../../../web/src/lib/blocks.ts";
import { stripSgr } from "../../../web/src/lib/surface/plain.ts";
import { styledSnapshot } from "./snapshot.ts";

function capture(name = "preview") {
  const path = join(import.meta.dirname, "fixtures", `rpiv-${name}-v015`);
  return { paint: readFileSync(`${path}.paint.ansi`, "utf8"), screen: { text: readFileSync(`${path}.screen.txt`, "utf8"), complete: true } };
}
const size = { cols: 200, rows: 120, reports: 1 };
const visibleRows = (text: string) => splitLines(parseAnsi(text)).map((row) => lineText(row).trimEnd());

describe("a core observer snapshot as an already rendered SGR grid", () => {
  test.each(["preview", "answer"])("%s retains every rendered row and contains SGR, not terminal commands", (name) => {
    const { paint, screen } = capture(name);
    const grid = styledSnapshot(paint, screen, size);
    expect(grid).not.toBeNull();
    expect(visibleRows(grid!)).toEqual(screen.text.split("\n").map((row) => row.trimEnd()));
    expect(grid).toContain("\x1b[");
    expect(stripSgr(grid!)).not.toContain("\x1b");
  });

  test("pending-wrap restoration neither adds a cell nor conceals a different cell or style", () => {
    const { paint, screen } = capture();
    const restore = "\x1b[120;200H\x1b[0m\x1b[38;2;134;134;134mf";
    expect(paint).toContain(restore); // The real first-paint form this regression covers.
    const grid = styledSnapshot(paint, screen, size)!;
    expect(visibleRows(grid).at(-1)).toEndWith("thinking off");
    expect(styledSnapshot(paint.replace(restore, restore.slice(0, -1) + "g"), screen, size)).toBeNull();
    expect(styledSnapshot(paint.replace(restore, "\x1b[120;200H\x1b[0m\x1b[31mf"), screen, size)).toBeNull();
  });

  test("a coalesced live bell does not discard a proved 59-column first paint", () => {
    const { paint, screen } = capture("startup-bell");
    expect(paint).toEndWith("\x07");
    const grid = styledSnapshot(paint, screen, { cols: 59, rows: 40, reports: 1 });
    expect(grid).not.toBeNull();
    expect(visibleRows(grid!)).toEqual(screen.text.split("\n").map(row => row.trimEnd()));
    expect(grid).not.toContain("\x07");
  });

  test("a real coalesced cursor update retains the complete narrow editor and no live controls", () => {
    const { paint, screen } = capture("coalesced-cursor");
    const grid = styledSnapshot(paint, screen, { cols: 59, rows: 40, reports: 1 });
    expect(grid).not.toBeNull();
    expect(visibleRows(grid!)).toEqual(screen.text.split("\n").map(row => row.trimEnd()));
    expect(stripSgr(grid!)).not.toContain("\x1b");
    const caret = parseAnsi(grid!).find((span) => span.inverse);
    expect(caret).toMatchObject({ text: "K", bold: true, inverse: true });
  });

  test("multiline text, leading spaces, emoji and reverse-video cell styling survive conversion", () => {
    const { paint, screen } = capture("answer");
    const grid = styledSnapshot(paint, screen, size)!;
    expect(splitLines(parseAnsi(grid)).map(lineText)).toContain("       Core second 😀\u00a0");
    const caret = parseAnsi(grid).find((span) => span.inverse);
    expect(caret).toMatchObject({ text: "\u00a0", bold: true, inverse: true, bg: "rgb(181,152,189)" });
  });

  test("unsupported SGR cannot manufacture style facts from subparameters or incomplete colours", () => {
    const { paint, screen } = capture();
    for (const sgr of ["4:3", "1;;31", "5", "38;2;255;0", "48;5;256"]) {
      expect(styledSnapshot(paint.replace("Sequential", `\x1b[${sgr}mSequential`), screen, size)).toBeNull();
    }
  });

  test("supported semicolon RGB and indexed colours keep their exact SGR", () => {
    for (const sgr of ["38;2;0;128;255;48;2;255;128;0", "38;5;0;48;5;255"]) {
      const grid = `\x1b[${sgr}mX`;
      const paint = `\x1b[2J\x1b[H${grid}\x1b[1;1H\x1b[?9001l`;
      expect(styledSnapshot(paint, { text: "X", complete: true }, { cols: 1, rows: 1, reports: 0 })).toBe(grid);
    }
  });

  test("Unicode whitespace disagreement is not ASCII formatter padding", () => {
    const { paint, screen } = capture("answer");
    expect(screen.text).toContain("Core second 😀\u00a0");
    const changed = screen.text.replace("Core second 😀\u00a0", "Core second 😀");
    expect(styledSnapshot(paint, { ...screen, text: changed }, size)).toBeNull();
  });

  test("pending-wrap restoration must preserve inverse state, not just resolved colours", () => {
    const paint = "\x1b[2J\x1b[H\x1b[31;44mX\x1b[1;1H\x1b[0;7;34;41mX\x1b[?9001l";
    expect(styledSnapshot(paint, { text: "X", complete: true }, { cols: 1, rows: 1, reports: 0 })).toBeNull();
  });

  test.each([
    ["movement inside the body", (paint: string) => paint.replace("Sequential", "\x1b[3DSequential")],
    ["bare carriage return", (paint: string) => paint.replace("Sequential", "\rSequential")],
    ["a bell inside the grid body", (paint: string) => paint.replace("Sequential", "\x07Sequential")],
    ["unknown prologue", (paint: string) => "unproved" + paint],
    ["unmeasured private mode", (paint: string) => paint.replace("\x1b[H", "\x1b[?9999h\x1b[H")],
    ["screen reverse mode", (paint: string) => paint.replace("\x1b[H", "\x1b[?5h\x1b[H")],
    ["origin mode", (paint: string) => paint.replace("\x1b[H", "\x1b[?6h\x1b[H")],
    ["missing cursor restoration", (paint: string) => paint.slice(0, paint.indexOf("\x1b[120;200H"))],
    ["truncated metadata", (paint: string) => paint.slice(0, -1)],
    ["live output before the metadata boundary", (paint: string) => paint.replace("\x1b[?9001l", "new output\x1b[?9001l")],
  ])("refuses %s rather than interpreting a terminal program", (_name, change) => {
    const { paint, screen } = capture();
    expect(styledSnapshot(change(paint), screen, size)).toBeNull();
  });

  test("drift, incomplete text and changed or invalid bounds cannot prove a styled read", () => {
    const { paint, screen } = capture("answer");
    expect(styledSnapshot(paint, { ...screen, text: screen.text.replace("Core first line", "Changed") }, size)).toBeNull();
    expect(styledSnapshot(paint, { ...screen, complete: false }, size)).toBeNull();
    for (const bounds of [{ cols: 200.5, rows: 120 }, { cols: 199, rows: 120 }, { cols: 200, rows: 119 }, { cols: 0, rows: 120 }]) {
      expect(styledSnapshot(paint, screen, { ...bounds, reports: 1 })).toBeNull();
    }
  });
});
