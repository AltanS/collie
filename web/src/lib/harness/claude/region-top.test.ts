import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { claudeBuildBlocks } from "./index";
import { lineText } from "./markers";
import { findRegionTop, isModalEdge } from "./region-top";

// The `▔` modal edge, in particular the form where a timed notice fills the row edge to edge and
// leaves one trailing glyph (Claude Code 2.1.318, the weekly-limit notice over the /model picker).

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
const NOTICE_FIXTURE = "claude--v2318-model-picker-usage-notice-edge--w120.txt";
const NOTICE_ROW =
  " You've used 80% of your weekly limit · resets Nov 11, 2am (Europe/Berlin) · /usage-credits to keep using Claude Code ▔";

/** A footer line under `row`, with a narrower body between, as a modal region looks. */
function region(row: string): string[] {
  return [row, "   Select model", "   1. First", "   Esc to cancel"];
}

describe("isModalEdge", () => {
  it("accepts the usage notice that runs edge to edge", () => {
    expect(isModalEdge(region(NOTICE_ROW), 0, 3)).toBe(true);
  });

  it("accepts the same notice without the leading space", () => {
    expect(isModalEdge(region(NOTICE_ROW.trimStart()), 0, 3)).toBe(true);
  });

  it("accepts a notice left-trimmed to its trailing glyphs", () => {
    expect(isModalEdge(region("ep using Claude Code and more words to fill ▔▔"), 0, 3)).toBe(true);
  });

  it("keeps every shape the edge had before", () => {
    const bar = "▔".repeat(60);
    expect(isModalEdge(region(bar), 0, 3)).toBe(true);
    expect(isModalEdge(region(`${"▔".repeat(40)} ● high · /effort ▔`), 0, 3)).toBe(true);
    expect(isModalEdge(region(`▔▔▔ You've used 89% of your weekly limit · resets soon ▔`), 0, 3)).toBe(true);
  });

  it("declines an ordinary text row, with or without a glyph in the middle", () => {
    expect(isModalEdge(region("   A long ordinary row of agent prose that spans well past eight cells."), 0, 3)).toBe(false);
    expect(isModalEdge(region("   A long ordinary row ▔ with a glyph in the middle of the prose."), 0, 3)).toBe(false);
    expect(isModalEdge(region("A glyph hugging a word▔"), 0, 3)).toBe(false);
    expect(isModalEdge(region(`note: ${"▔".repeat(40)}`), 0, 3)).toBe(false);
  });

  it("declines an empty row and a blank row", () => {
    expect(isModalEdge(region(""), 0, 3)).toBe(false);
    expect(isModalEdge(region("          "), 0, 3)).toBe(false);
  });

  it("declines a notice row that is not the widest of its region", () => {
    const wider = [NOTICE_ROW, `   ${"x".repeat(130)}`, "   Esc to cancel"];
    expect(isModalEdge(wider, 0, 2)).toBe(false);
  });
});

describe(`${NOTICE_FIXTURE}`, () => {
  const lines = splitLines(parseAnsi(readFileSync(join(PANES_DIR, NOTICE_FIXTURE), "utf8")));
  const texts = lines.map(lineText);

  it("is 40 rows and its notice row is the capture's edge", () => {
    expect(texts).toHaveLength(40);
    expect(texts[20]!.trimEnd()).toBe(NOTICE_ROW);
  });

  it("finds the notice row as the region top", () => {
    expect(findRegionTop(texts, 39)).toEqual({ line: 20, edge: true });
  });

  it("lifts the picker as a menu", () => {
    const menu = claudeBuildBlocks(lines).find((block) => block.kind === "menu");
    expect(menu?.kind).toBe("menu");
    if (menu?.kind !== "menu") return;
    expect(menu.menu.title).toBe("Select model");
  });
});
