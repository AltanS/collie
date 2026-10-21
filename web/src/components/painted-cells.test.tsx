import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as textWidth from "@/lib/text-width";

import { renderWideCells } from "./painted-cells";

// `renderWideCells` is what the non-wrapping mirror runs on every row of every poll. A run with no
// double-width glyph must cost one regex test and nothing else, so `widePieces` (and the
// `Intl.Segmenter` pass under it) is spied on to see which path a run took.
vi.mock("@/lib/text-width", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/text-width")>();
  return { ...original, widePieces: vi.fn(original.widePieces) };
});

const widePieces = vi.mocked(textWidth.widePieces);

const WIDE_CELL = '[class~="w-[2ch]"]';

function wideTexts(run: string): string[] {
  const { container } = render(<span>{renderWideCells(run)}</span>);
  return [...container.querySelectorAll(WIDE_CELL)].map((cell) => cell.textContent ?? "");
}

describe("renderWideCells", () => {
  beforeEach(() => widePieces.mockClear());

  it.each([
    ["printable ASCII", "  1. coffee      | details"],
    ["box drawing", "┌──────┬────┐\n│ name │ ok │\n├──────┼────┤\n└──────┴────┘"],
    ["the marks of a Claude screen", "⏺ Read(src/cart.ts)\n❯ 1. Yes → continue ─ │"],
    ["a combining mark and no wide glyph", "café │ é"],
  ])("takes the plain path for a run of %s", (_name, run) => {
    // The very string it was given: no pieces, no wide span, and no segmenter pass.
    expect(renderWideCells(run)).toBe(run);
    expect(widePieces).not.toHaveBeenCalled();
    expect(wideTexts(run)).toEqual([]);
  });

  it("holds each Hangul and Han character to its own two cells", () => {
    expect(wideTexts("  3. 中文 │ 커피 ─")).toEqual(["中", "文", "커", "피"]);
    expect(widePieces).toHaveBeenCalled();
  });

  it("keeps a combining mark with its base beside a wide glyph", () => {
    const run = "café │ 커피";
    const { container } = render(<span>{renderWideCells(run)}</span>);

    expect(container.textContent).toBe(run);
    expect([...container.querySelectorAll(WIDE_CELL)].map((c) => c.textContent)).toEqual(["커", "피"]);
  });

  it("holds an emoji drawn by VS16 to two cells", () => {
    const run = "⚠️ warn │ ❤️ ok";
    const { container } = render(<span>{renderWideCells(run)}</span>);

    expect(container.textContent).toBe(run);
    expect([...container.querySelectorAll(WIDE_CELL)].map((c) => c.textContent)).toEqual([
      "⚠️",
      "❤️",
    ]);
  });

  it("holds a keycap to two cells", () => {
    expect(wideTexts("1️⃣ one")).toEqual(["1️⃣"]);
  });

  it("leaves a text-default emoji without VS16 at one cell", () => {
    const run = "⚠ warn";
    expect(renderWideCells(run)).toBe(run);
    expect(wideTexts(run)).toEqual([]);
  });

  // The regex is built from WIDE_RANGES, so it must agree with `widePieces` on every range. A bad
  // escape or an off-by-one in the build would send a wide glyph down the plain path, and its wall
  // would drift again with nothing else failing.
  it("sends every range of the width table down the wide path", () => {
    const disagreements: string[] = [];
    for (const [lo, hi] of textWidth.WIDE_RANGES) {
      for (const cp of new Set([lo, (lo + hi) >> 1, hi])) {
        const ch = String.fromCodePoint(cp);
        const expected = textWidth.widePieces(ch).some((p) => p.wide);
        const painted = wideTexts(ch).length > 0;
        if (painted !== expected) disagreements.push(cp.toString(16));
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("gives each wide piece the decoration of the link around it", () => {
    // An underline does not propagate into an inline-block child, and each wide piece is one.
    const { container } = render(
      <a href="/docs" className="underline">
        {renderWideCells("docs/한글.md")}
      </a>,
    );
    const cells = [...container.querySelectorAll<HTMLElement>(WIDE_CELL)];

    expect(cells.map((cell) => cell.textContent)).toEqual(["한", "글"]);
    for (const cell of cells) expect(cell.className).toContain("[text-decoration:inherit]");
  });
});
