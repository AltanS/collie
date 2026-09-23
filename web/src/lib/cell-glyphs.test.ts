import { describe, expect, it } from "vitest";

import { cellPieces } from "./cell-glyphs";

const FULL_BLOCK = "\u2588";
const RIGHT_EIGHTH = "\u2595";
const LEFT_EIGHTH = "\u258f";
const LOWER_EIGHTH = "\u2581";
const UPPER_EIGHTH = "\u2594";
const LOWER_LEFT_QUADRANT = "\u2596";
const LEFT_CAP = "\ue0b6";
const RIGHT_CAP = "\ue0b4";
const RIGHT_WEDGE = "\ue0b0";
const LEFT_WEDGE = "\ue0b2";
const LIGHT_SHADE = "\u2591";
const BOX_VERTICAL = "\u2502";

describe("cell glyph splitting", () => {
  // The whole hot path of the mirror is runs with none of these characters, so the answer for them
  // has to be "no work at all" rather than "one piece". The renderer tests the null and emits the
  // string it already had, adding no element and no allocation.
  it("declines a run with nothing to paint", () => {
    expect(cellPieces("")).toBeNull();
    expect(cellPieces("ordinary output, 42 files")).toBeNull();
    expect(cellPieces(`${BOX_VERTICAL} a framed row ${BOX_VERTICAL}`)).toBeNull();
  });

  // Every piece is one character or one plain stretch, and the concatenation must be the input:
  // find offsets, link offsets and a clipboard copy are all defined over these text nodes.
  it("reassembles to the run it was given", () => {
    const run = `${LEFT_CAP}CX${RIGHT_CAP} 7d ${FULL_BLOCK.repeat(4)}${RIGHT_EIGHTH}`;
    expect(
      cellPieces(run)!
        .map((piece) => piece.text)
        .join(""),
    ).toBe(run);
  });

  it("paints one character per piece and leaves the text between them whole", () => {
    const pieces = cellPieces(`${LEFT_CAP}CX${RIGHT_CAP}`)!;
    expect(pieces.map((piece) => piece.text)).toEqual([LEFT_CAP, "CX", RIGHT_CAP]);
    expect(pieces[1]!.paint).toBeUndefined();
    // A cap is a full cell with the corners on one side rounded all the way out, horizontally by
    // the whole cell and vertically by half of it — the half-ellipse the font draws.
    expect(pieces[0]!.paint!.radius).toBe("100% 0 0 100% / 50% 0 0 50%");
    expect(pieces[2]!.paint!.radius).toBe("0 100% 100% 0 / 0 50% 50% 0");
  });

  // The eighths are what a bar is drawn from, and getting the axis or the direction wrong is
  // invisible in a screenshot of a full bar. `▕` inks the RIGHT eighth, so its layer is an eighth
  // of the cell wide and sits flush against the right wall.
  it("sizes and places each partial block against the wall it grows from", () => {
    expect(cellPieces(RIGHT_EIGHTH)![0]!.paint!.fill).toContain("100% 0%/12.5% 100%");
    expect(cellPieces(LEFT_EIGHTH)![0]!.paint!.fill).toContain("0% 0%/12.5% 100%");
    expect(cellPieces(LOWER_EIGHTH)![0]!.paint!.fill).toContain("0% 100%/100% 12.5%");
    expect(cellPieces(UPPER_EIGHTH)![0]!.paint!.fill).toContain("0% 0%/100% 12.5%");
    expect(cellPieces(FULL_BLOCK)![0]!.paint!.fill).toContain("0% 0%/100% 100%");
  });

  // A shape is never a `clip-path`: a clipped box does not meet the clipped box beside it, so a run
  // of full blocks would grow a seam per cell — measured at device pixel ratio 3, six in Chromium
  // and four in WebKit, WebKit's all the way down to the page background. Backgrounds leave none.
  // The colour is always `currentColor`, so a painted cell inherits the segment's foreground and
  // .adr/0002's inversion filter treats it exactly like the text beside it.
  it("draws every shape as a background in the inherited colour", () => {
    const run = `${LEFT_CAP}${FULL_BLOCK}${LOWER_LEFT_QUADRANT}${RIGHT_WEDGE}${RIGHT_EIGHTH}`;
    for (const piece of cellPieces(run)!) {
      expect(piece.paint!.fill).toContain("linear-gradient");
      expect(piece.paint!.fill).toContain("currentColor");
      expect(piece.paint!.fill).not.toContain("clip-path");
      expect(piece.paint!.fill).not.toMatch(/#[0-9a-f]{3,8}|rgb\(/i);
    }
  });

  // The two separators are mirror images, and a wedge pointing the wrong way is the one error in
  // this table that still looks deliberate on screen. `` opens to the right, so both of its
  // gradients run rightward and its diagonal is the font's own.
  it("points each Powerline separator the way the font draws it", () => {
    const right = cellPieces(RIGHT_WEDGE)![0]!.paint!.fill;
    const left = cellPieces(LEFT_WEDGE)![0]!.paint!.fill;
    expect(right).toContain("to top right");
    expect(right).toContain("to bottom right");
    expect(left).toContain("to top left");
    expect(left).toContain("to bottom left");
    expect(right).not.toBe(left);
  });

  // The six quadrants that are not one rectangle are the easiest entries to transpose, and every
  // one of them is a half plus the quadrant across from its open corner, or a diagonal pair. Each
  // row below reads the character's own Unicode name back as areas. Six call sites in lockstep.
  it("assembles each multi-part quadrant from the areas its name lists", () => {
    const areas = (ch: string) =>
      [...cellPieces(ch)![0]!.paint!.fill.matchAll(/\d[\d.]*% \d[\d.]*%\/\d[\d.]*% \d[\d.]*%/g)].map(
        (match) => match[0],
      );
    // UPPER LEFT AND LOWER LEFT AND LOWER RIGHT: the left half, plus the lower right.
    expect(areas("\u2599")).toEqual(["0% 0%/50% 100%", "100% 100%/50% 50%"]);
    // UPPER LEFT AND LOWER RIGHT: the falling diagonal.
    expect(areas("\u259a")).toEqual(["0% 0%/50% 50%", "100% 100%/50% 50%"]);
    // UPPER LEFT AND UPPER RIGHT AND LOWER LEFT: the upper half, plus the lower left.
    expect(areas("\u259b")).toEqual(["0% 0%/100% 50%", "0% 100%/50% 50%"]);
    // UPPER LEFT AND UPPER RIGHT AND LOWER RIGHT: the upper half, plus the lower right.
    expect(areas("\u259c")).toEqual(["0% 0%/100% 50%", "100% 100%/50% 50%"]);
    // UPPER RIGHT AND LOWER LEFT: the rising diagonal.
    expect(areas("\u259e")).toEqual(["100% 0%/50% 50%", "0% 100%/50% 50%"]);
    // UPPER RIGHT AND LOWER LEFT AND LOWER RIGHT: the lower half, plus the upper right.
    expect(areas("\u259f")).toEqual(["0% 100%/100% 50%", "100% 0%/50% 50%"]);
  });

  // The splitter walks code UNITS, which is safe only because every character it paints is in the
  // BMP. An astral character beside one must come back whole, not as two lone surrogates.
  it("carries an astral character through intact", () => {
    const run = `${FULL_BLOCK}\u{1F642}${FULL_BLOCK}`;
    const pieces = cellPieces(run)!;
    expect(pieces.map((piece) => piece.text)).toEqual([FULL_BLOCK, "\u{1F642}", FULL_BLOCK]);
    expect(pieces[1]!.paint).toBeUndefined();
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
