import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// THE RENDERER PAINTS WITH TOKENS ONLY (DESIGN.md section 13, the design's section 5). A colour reaches
// a trick's part through the tone map onto the status tokens and through nothing else, so a literal in
// any of these files would paint the same under every theme and give a trick a colour of its own.

const FILES = [
  "clock.ts",
  "frame.ts",
  "icons.tsx",
  "layout.ts",
  "mark.tsx",
  "part-frame.tsx",
  "render.tsx",
  "store.ts",
  "time.ts",
  "tone.ts",
  "wire.ts",
  "../../playground/sections/trick-render.tsx",
];

/** The number sign, spelled so this file does not trip its own check. */
const HASH = String.fromCharCode(35);
const COLOUR_FUNCTION = /\b(rgba?|hsla?|oklch|oklab|lab|lch|color-mix)\(/;
const PALETTE =
  /\b(text|bg|border|fill|stroke|ring|outline|decoration|divide|from|via|to|shadow|accent|caret)-(slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b/;

describe("the tricks renderer's ink", () => {
  it.each(FILES)("%s names no colour of its own", (file) => {
    const source = readFileSync(join(__dirname, file), "utf8");
    const lines = source.split("\n");
    expect(lines.filter((line) => line.includes(HASH))).toEqual([]);
    expect(lines.filter((line) => COLOUR_FUNCTION.test(line))).toEqual([]);
    expect(lines.filter((line) => PALETTE.test(line))).toEqual([]);
  });

  it("would catch each kind of literal", () => {
    expect(COLOUR_FUNCTION.test('style={{ color: "oklch(0.6 0.2 30)" }}')).toBe(true);
    expect(COLOUR_FUNCTION.test("rgb(255 0 0)")).toBe(true);
    expect(PALETTE.test('className="text-red-500"')).toBe(true);
    expect(PALETTE.test('className="bg-white"')).toBe(true);
    expect(PALETTE.test('className="text-status-blocked bg-muted"')).toBe(false);
    expect(`${HASH}ff0000`.includes(HASH)).toBe(true);
  });
});
