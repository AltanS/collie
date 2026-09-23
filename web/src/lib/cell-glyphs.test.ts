import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { CELL_FILL, cellPieces } from "./cell-glyphs";

const FULL_BLOCK = "█";
const LOWER_HALF = "▄";
const RIGHT_EIGHTH = "▕";
const LEFT_EIGHTH = "▏";
const LOWER_EIGHTH = "▁";
const UPPER_EIGHTH = "▔";
const LEFT_CAP = "";
const RIGHT_CAP = "";
const RIGHT_WEDGE = "";
const LEFT_WEDGE = "";
const LIGHT_SHADE = "░";
const BOX_VERTICAL = "│";

describe("cell glyph splitting", () => {
  // The whole hot path of the mirror is runs with none of these characters, so the answer for them
  // has to be "no work at all" rather than "one piece". The renderer tests the null and emits the
  // string it already had, adding no element and no allocation.
  it("declines a run with nothing to paint", () => {
    expect(cellPieces("")).toBeNull();
    expect(cellPieces("ordinary output, 42 files")).toBeNull();
    expect(cellPieces(`${BOX_VERTICAL} a framed row ${BOX_VERTICAL}`)).toBeNull();
  });

  // Every piece is one painted character or one plain stretch, and the concatenation must be the
  // input: find offsets, link offsets and a clipboard copy are all defined over these text nodes.
  it("reassembles to the run it was given", () => {
    const run = `${LEFT_CAP}CX${RIGHT_CAP} 7d ${FULL_BLOCK.repeat(4)}${RIGHT_EIGHTH}`;
    expect(
      cellPieces(run)!
        .map((piece) => piece.text)
        .join(""),
    ).toBe(run);
  });

  it("paints each cap on its own and leaves the text between them whole", () => {
    const pieces = cellPieces(`${LEFT_CAP}CX${RIGHT_CAP}`)!;
    expect(pieces.map((piece) => piece.text)).toEqual([LEFT_CAP, "CX", RIGHT_CAP]);
    expect(pieces.map((piece) => piece.cell)).toEqual(["round-left", undefined, "round-right"]);
  });

  // A span per CHARACTER, never per run: a wrapping mirror can break a run across two lines, and
  // the painted band is one box, so the run's second line would show nothing.
  it("paints every character on its own, a bar included", () => {
    expect(cellPieces(FULL_BLOCK.repeat(3))).toEqual([
      { text: FULL_BLOCK, cell: "full" },
      { text: FULL_BLOCK, cell: "full" },
      { text: FULL_BLOCK, cell: "full" },
    ]);
    expect(cellPieces(`${FULL_BLOCK}${LOWER_HALF} 91%`)).toEqual([
      { text: FULL_BLOCK, cell: "full" },
      { text: LOWER_HALF, cell: "lower-4" },
      { text: " 91%" },
    ]);
  });

  // The eighths are what a bar is drawn from, and getting the axis or the direction wrong is
  // invisible in a screenshot of a full bar. `▕` inks the RIGHT eighth.
  it("names each partial block by the wall it grows from and how far", () => {
    expect(cellPieces(RIGHT_EIGHTH)![0]!.cell).toBe("right-1");
    expect(cellPieces(LEFT_EIGHTH)![0]!.cell).toBe("left-1");
    expect(cellPieces(LOWER_EIGHTH)![0]!.cell).toBe("lower-1");
    expect(cellPieces(UPPER_EIGHTH)![0]!.cell).toBe("upper-1");
    expect(cellPieces("▀")![0]!.cell).toBe("upper-4");
    expect(cellPieces("▐")![0]!.cell).toBe("right-4");
    expect(cellPieces("▉")![0]!.cell).toBe("left-7");
    expect(cellPieces("▇")![0]!.cell).toBe("lower-7");
  });

  // The two separators are mirror images, and a wedge pointing the wrong way is the one error in
  // this table that still looks deliberate on screen. `` opens to the right.
  it("points each Powerline separator the way the font draws it", () => {
    expect(cellPieces(RIGHT_WEDGE)![0]!.cell).toBe("wedge-right");
    expect(cellPieces(LEFT_WEDGE)![0]!.cell).toBe("wedge-left");
  });

  // The six quadrants that are not one rectangle are the easiest entries to transpose. Each row
  // reads the character's own Unicode name back as the quarters it inks.
  it("names each quadrant by the quarters its Unicode name lists", () => {
    // UPPER LEFT AND LOWER LEFT AND LOWER RIGHT
    expect(cellPieces("▙")![0]!.cell).toBe("quad-ul-ll-lr");
    // UPPER LEFT AND LOWER RIGHT
    expect(cellPieces("▚")![0]!.cell).toBe("quad-ul-lr");
    // UPPER LEFT AND UPPER RIGHT AND LOWER LEFT
    expect(cellPieces("▛")![0]!.cell).toBe("quad-ul-ur-ll");
    // UPPER LEFT AND UPPER RIGHT AND LOWER RIGHT
    expect(cellPieces("▜")![0]!.cell).toBe("quad-ul-ur-lr");
    // UPPER RIGHT AND LOWER LEFT
    expect(cellPieces("▞")![0]!.cell).toBe("quad-ur-ll");
    // UPPER RIGHT AND LOWER LEFT AND LOWER RIGHT
    expect(cellPieces("▟")![0]!.cell).toBe("quad-ur-ll-lr");
  });

  // The splitter's regex and the shape table are two spellings of one set. A character in one and
  // not the other either paints nothing or throws, so every candidate in both ranges is walked.
  it("paints exactly the characters the shape table names", () => {
    const candidates = [
      ...Array.from({ length: 0x100 }, (_, i) => String.fromCharCode(0x2500 + i)),
      ...Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0xe0a0 + i)),
    ];
    for (const ch of candidates) {
      const pieces = cellPieces(ch);
      // SAFETY: `Object.hasOwn` has just proved `ch` is one of the table's own keys.
      expect(pieces === null ? undefined : pieces[0]!.cell, ch.codePointAt(0)!.toString(16)).toBe(
        Object.hasOwn(CELL_FILL, ch) ? CELL_FILL[ch as keyof typeof CELL_FILL] : undefined,
      );
    }
  });

  // The splitter walks code UNITS, which is safe only because every character it paints is in the
  // BMP. An astral character beside one must come back whole, not as two lone surrogates.
  it("carries an astral character through intact", () => {
    const run = `${FULL_BLOCK}\u{1F642}${FULL_BLOCK}`;
    const pieces = cellPieces(run)!;
    expect(pieces.map((piece) => piece.text)).toEqual([FULL_BLOCK, "\u{1F642}", FULL_BLOCK]);
    expect(pieces[1]!.cell).toBeUndefined();
    expect(pieces.map((piece) => piece.text).join("")).toBe(run);
  });

  // The exclusions are a promise that this change cannot restyle anything: a shade is a dither
  // pattern, and box drawing is a stroke whose weight belongs to the font. Both keep the glyph they
  // have always had.
  it("leaves the shades and box drawing to the font", () => {
    expect(cellPieces(LIGHT_SHADE)).toBeNull();
    expect(cellPieces(BOX_VERTICAL)).toBeNull();
  });
});

// The paint lives in index.css, one rule per shape. A shape the table names with no rule would
// render as an invisible character: the ink is emptied and nothing is painted in its place.
describe("cell glyph paint rules", () => {
  const css = readFileSync(resolve(import.meta.dirname, "../index.css"), "utf8");
  const block = css.slice(
    css.indexOf("@supports (height: 1lh)"),
    css.indexOf("/* `dark:` must fire"),
  );

  it("has a rule for every shape", () => {
    for (const fill of new Set(Object.values(CELL_FILL))) {
      expect(block, fill).toContain(`.cell-glyph[data-cell="${fill}"]`);
    }
  });

  // `currentColor` is the whole reason a painted cell needs no colour of its own: it takes the
  // segment's foreground, and .adr/0002's inversion filter then treats it exactly like text. A
  // literal colour would render correctly in dark and wrongly in light. A shape is never a
  // `clip-path`: a clipped box does not meet the one beside it, so a bar would grow seams.
  it("paints in the inherited colour and never clips", () => {
    expect(block).toContain("currentColor");
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|oklch\(|clip-path/i);
  });
});
