import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { lineText, splitLines, type StyledLine } from "../../blocks";
import { prepareOmpDisplay } from "./display";

// PR 837: omp draws a shell tool's command and output inside a `│ … │` box with an `Output` divider.
// blocks.ts marks every framed row `noWrap`, so the wrapped mirror clipped each output line at the
// phone's edge. The display pass takes the side borders off the rows next to that divider, so they
// wrap as Claude's and pi's shell output already do. Display only: the raw rows stay as they were.

const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");

function fixtureLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8")));
}
function lines(text: string): StyledLine[] {
  return splitLines(parseAnsi(text));
}

const DIVIDER = /^├─+ Output ─+┤ *$/;

describe("prepareOmpDisplay", () => {
  it("unboxes the rows of a shell result next to the Output divider, and nothing else", () => {
    const raw = fixtureLines("omp--done--tool-result.txt");
    const shown = prepareOmpDisplay(raw);
    expect(shown).not.toBe(raw);
    expect(shown).toHaveLength(raw.length);
    const divider = raw.findIndex((line) => DIVIDER.test(lineText(line)));
    expect(divider).toBeGreaterThan(0);
    let unboxed = 0;
    raw.forEach((line, i) => {
      const before = lineText(line).trimEnd();
      const after = lineText(shown[i]!);
      if (shown[i] === line) return;
      unboxed += 1;
      expect(line.noWrap).toBe(true);
      expect(before.startsWith("│ ") && before.endsWith("│")).toBe(true);
      expect(after).toBe(before.slice(2, -1).trimEnd());
      expect(shown[i]!.noWrap).toBeUndefined();
    });
    // The rows above the divider (the command) and below it (the output) both lose their sides.
    expect(shown[divider - 1]).not.toBe(raw[divider - 1]);
    expect(shown[divider + 1]).not.toBe(raw[divider + 1]);
    expect(unboxed).toBeGreaterThanOrEqual(2);
    // The divider itself and the box's top and bottom stay framed rows.
    expect(shown[divider]).toBe(raw[divider]);
  });

  it("keeps each piece's own style", () => {
    const raw = lines("╭──────────╮\n│ \x1b[31mred\x1b[0m text │\n├─ Output ─┤\n│ \x1b[1mbold\x1b[0m     │\n╰──────────╯");
    const shown = prepareOmpDisplay(raw);
    expect(lineText(shown[1]!)).toBe("red text");
    expect(shown[1]!.segments[0]).toMatchObject({ text: "red" });
    expect(shown[1]!.segments[0]).toEqual({ ...raw[1]!.segments.find((s) => s.text === "red")! });
    expect(lineText(shown[3]!)).toBe("bold");
    expect(shown[0]).toBe(raw[0]);
    expect(shown[4]).toBe(raw[4]);
  });

  it("leaves a framed box without an Output divider as it was, the same array", () => {
    const raw = lines("╭──────────╮\n│ one      │\n│ two      │\n╰──────────╯");
    expect(prepareOmpDisplay(raw)).toBe(raw);
  });
});
