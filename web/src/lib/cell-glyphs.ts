// Block and Powerline characters painted as a CELL, because the font cannot fill one.
//
// THE DEFECT. A segment's background paints its content box; a glyph paints its EM BOX, and the
// mirror runs at `leading-[1.25]` (components/ansi-output.tsx). So every character whose whole job
// is to fill its cell — a block element, a Powerline cap — comes out a quarter of a row short, and
// whatever is behind it shows through above and below. Measured on an iPhone 16 Pro (device pixel
// ratio 3) at the default `fontSize = 11`: the row pitch is 41px, which is 11 x 1.25 x 3, and the
// ink of both `U+E0B6` and `U+2595` is 33px, which is 11 x 3. The 8px difference is the whole bug.
// It is not a font bug and not a Nerd Font bug: the two characters measured come from two different
// faces and are short by exactly the same 0.25em.
//
// A prompt pill shows it worst. Its letters sit on a span background, so they are full height, and
// its two round caps are glyphs, so they are not — the pill steps in at both joins.
//
// WHY THE FONT CANNOT FIX IT. Nothing about the character says "fill the cell"; the cell is a
// terminal's idea and the font never sees it. A terminal emulator solves this by drawing these
// ranges itself, to the cell, ignoring the outline the font ships. Collie runs no emulator
// (ADR 0008) and this does not add one: no cell grid, no second renderer, no change to what
// `pane.read` returns or to what the grammars consume. It changes how ONE character is painted,
// in one span, inside the renderer that already exists.
//
// HOW. The character is wrapped in a `cell-glyph` span whose paint is `currentColor` — so it takes
// the segment's own foreground, and the inversion filter (.adr/0002) treats it exactly like text.
// The character itself STAYS in the span as a text node, so find offsets, link offsets, selection
// and copy are byte-identical; only its ink is emptied. index.css has the span.
//
// EVERY SHAPE IS A BACKGROUND, NEVER A `clip-path`, AND THAT IS MEASURED. A clipped box does not
// meet the clipped box beside it: each one antialiases its own edge, so a run of full blocks — a
// progress bar, the common case — grows a seam at every cell boundary. Twelve adjacent full blocks
// at device pixel ratio 3: `clip-path: inset(0)` leaves 6 visible seams in Chromium and 4 in
// WebKit, and WebKit's drop all the way to the page background. The same twelve painted as
// backgrounds leave none in either engine. So a rectangle is a `linear-gradient` layer sized and
// positioned inside the box, and a round cap is `border-radius` on a full one.
//
// IT MOVES NOTHING. The span sets no geometry of its own, so the character keeps its own advance:
// a Powerline cap stays as wide as the symbol face makes it, every column lands where it landed
// before, and the only difference on screen is that the shape now reaches the top and bottom of its
// row. The documented advance-width drift (index.css § "EXPECTED, NOT A BUG") is untouched, on
// purpose. Sizing a cell here would fix that drift and move a prompt's columns in the same commit,
// and a column-faithful box in the client is the grid ADR 0008 refuses. The browser case fails if a
// later hand gives this span a size, so the boundary is held by a test and not by this paragraph.
//
// NO PANE BYTE EVER COMPOSES A CSS VALUE. A character selects one of the constant strings in the
// table below by exact match, or it is left alone. Nothing is interpolated, parsed, or built.
//
// WHAT IS DELIBERATELY NOT HERE. One line covers three of the four: paint the character whose
// glyph is a solid fill that must reach the edges of its cell, and leave every stroke and every
// texture to the font.
//
//   · Box drawing (U+2500-257F). A stroke, not a fill. Its weight is the font's to choose, and a
//     short stroke leaves no background seam — there is nothing here for it to join.
//   · The thin Powerline variants (U+E0B1, E0B3, E0B5, E0B7). Strokes, for the same reason.
//   · The shades (U+2591-2593). A dither pattern. A flat tint at the same density would be a
//     restyle, not a repair.
//   · The Symbols for Legacy Computing blocks (U+1FB00- and U+1CC00-), which hold the sextants and
//     octants. These ARE fills, so the line above does not reach them; the reason is scope. Mobile
//     faces do not carry them, so they render as tofu today. Painting one would make an absent
//     character appear, and this change repairs the height of characters that already render.
//
// No excluded character renders differently than it does today. That is per character, and it is
// not the same as "nothing looks different": a run that mixes the two sets, `████░░░░`, is
// uniformly short today and gains a step at the seam, because the solid half now fills its row and
// the shaded half still cannot. The step is the shades' own height, unchanged and now visible. The
// fix for it is to paint the shades, which is the restyle above, and it stays refused.
//
// This is the FIFTH question asked about these ranges, and like the four in lib/rule-glyphs.ts it
// keeps its own alphabet. That file classifies a ROW — is it a rule, a frame, a table. This one
// asks how to PAINT one character. Sharing a constant between the two would tie a renderer detail
// to a grammar's false-positive budget.

/** One rectangle of ink: `<position>/<size>`, in the `background` shorthand's own grammar. Every
 *  rectangle a block element draws is flush to an edge, so each position is `0%` or `100%` and the
 *  percentage-of-the-remainder rule that makes `background-position` awkward never bites. */
function ink(...rects: string[]): string {
  return rects.map((rect) => `linear-gradient(currentColor,currentColor) ${rect} no-repeat`).join(",");
}

/** A right-pointing wedge: the half-cell above the axis keeps its lower-left triangle, the half
 *  below keeps its upper-left. `to top right` and `to bottom right` put their 50% boundary on the
 *  sub-box's own diagonal, which IS the wedge's edge. `49.8%` rather than `50%` gives the hard stop
 *  a sliver to antialias in — a bare hard stop stairsteps. */
const WEDGE_RIGHT =
  "linear-gradient(to top right,currentColor 49.8%,transparent 50%) 0% 0%/100% 50% no-repeat," +
  "linear-gradient(to bottom right,currentColor 49.8%,transparent 50%) 0% 100%/100% 50% no-repeat";
const WEDGE_LEFT =
  "linear-gradient(to top left,currentColor 49.8%,transparent 50%) 0% 0%/100% 50% no-repeat," +
  "linear-gradient(to bottom left,currentColor 49.8%,transparent 50%) 0% 100%/100% 50% no-repeat";

const SOLID = ink("0% 0%/100% 100%");

/** How one character fills its cell: the ink, and the corners the ink is rounded off at. */
export interface CellPaint {
  /** A `background` shorthand value. */
  fill: string;
  /** A `border-radius` value; absent means square. */
  radius?: string;
}

/** Keyed by the character, and written with escapes rather than the literal: several of these are
 *  invisible in an editor, and the Powerline four are private-use codepoints that show as tofu in
 *  most of them. */
const CELL_PAINT = {
  // Lower eighths: ink on the floor, growing up.
  "\u2581": { fill: ink("0% 100%/100% 12.5%") },
  "\u2582": { fill: ink("0% 100%/100% 25%") },
  "\u2583": { fill: ink("0% 100%/100% 37.5%") },
  "\u2584": { fill: ink("0% 100%/100% 50%") },
  "\u2585": { fill: ink("0% 100%/100% 62.5%") },
  "\u2586": { fill: ink("0% 100%/100% 75%") },
  "\u2587": { fill: ink("0% 100%/100% 87.5%") },
  "\u2588": { fill: SOLID },
  // Left eighths: ink on the left wall, growing right. The full block above is the eighth of both
  // runs and is written once.
  "\u2589": { fill: ink("0% 0%/87.5% 100%") },
  "\u258a": { fill: ink("0% 0%/75% 100%") },
  "\u258b": { fill: ink("0% 0%/62.5% 100%") },
  "\u258c": { fill: ink("0% 0%/50% 100%") },
  "\u258d": { fill: ink("0% 0%/37.5% 100%") },
  "\u258e": { fill: ink("0% 0%/25% 100%") },
  "\u258f": { fill: ink("0% 0%/12.5% 100%") },
  // The halves and eighths that grow the other way.
  "\u2580": { fill: ink("0% 0%/100% 50%") },
  "\u2590": { fill: ink("100% 0%/50% 100%") },
  "\u2594": { fill: ink("0% 0%/100% 12.5%") },
  "\u2595": { fill: ink("100% 0%/12.5% 100%") },
  // Quadrants, one rectangle each.
  "\u2596": { fill: ink("0% 100%/50% 50%") },
  "\u2597": { fill: ink("100% 100%/50% 50%") },
  "\u2598": { fill: ink("0% 0%/50% 50%") },
  "\u259d": { fill: ink("100% 0%/50% 50%") },
  // Quadrants, two rectangles: a half plus the quadrant across from its open corner, or the two
  // diagonal pairs. Layered, so no shape here needs to be a single polygon.
  "\u2599": { fill: ink("0% 0%/50% 100%", "100% 100%/50% 50%") },
  "\u259a": { fill: ink("0% 0%/50% 50%", "100% 100%/50% 50%") },
  "\u259b": { fill: ink("0% 0%/100% 50%", "0% 100%/50% 50%") },
  "\u259c": { fill: ink("0% 0%/100% 50%", "100% 100%/50% 50%") },
  "\u259e": { fill: ink("100% 0%/50% 50%", "0% 100%/50% 50%") },
  "\u259f": { fill: ink("0% 100%/100% 50%", "100% 0%/50% 50%") },
  // Powerline, the thick half of each pair: two separators and two round caps. A cap is a full cell
  // with the corners on one side rounded all the way out — horizontally by the cell's whole width,
  // vertically by half its height, which is the half-ellipse the font draws.
  "\ue0b0": { fill: WEDGE_RIGHT },
  "\ue0b2": { fill: WEDGE_LEFT },
  "\ue0b4": { fill: SOLID, radius: "0 100% 100% 0 / 0 50% 50% 0" },
  "\ue0b6": { fill: SOLID, radius: "100% 0 0 100% / 50% 0 0 50%" },
} satisfies Record<string, CellPaint>;

/** How this character fills its cell, or `undefined` when this module does not paint it. */
function cellPaint(ch: string): CellPaint | undefined {
  // SAFETY: `Object.hasOwn` has just proved `ch` is one of this literal's own keys, which is all
  // the assertion claims. The table has no inherited or shadowed entries to confuse it.
  return Object.hasOwn(CELL_PAINT, ch) ? CELL_PAINT[ch as keyof typeof CELL_PAINT] : undefined;
}

/** A slice of a segment: plain text, or one character to paint as a cell. */
export interface CellPiece {
  text: string;
  /** How to paint this one character; absent means render `text` as it always was. */
  paint?: CellPaint;
}

/**
 * Split a rendered run into plain stretches and the single characters that must be painted.
 *
 * Returns `null` — not `[{ text }]` — when the run holds none, which is almost every run in the
 * mirror. The caller then emits the string it already had, and this path allocates nothing.
 *
 * Every covered character is in the BMP, so indexing by code unit is safe: no surrogate pair can
 * be cut in half here.
 */
export function cellPieces(text: string): CellPiece[] | null {
  let first = -1;
  for (let i = 0; i < text.length; i++) {
    if (cellPaint(text[i]!) !== undefined) {
      first = i;
      break;
    }
  }
  if (first === -1) return null;

  const pieces: CellPiece[] = [];
  if (first > 0) pieces.push({ text: text.slice(0, first) });
  let plain = -1; // where the current plain stretch started, or -1 inside painted characters
  for (let i = first; i < text.length; i++) {
    const ch = text[i]!;
    const paint = cellPaint(ch);
    if (paint === undefined) {
      if (plain === -1) plain = i;
      continue;
    }
    if (plain !== -1) {
      pieces.push({ text: text.slice(plain, i) });
      plain = -1;
    }
    pieces.push({ text: ch, paint });
  }
  if (plain !== -1) pieces.push({ text: text.slice(plain) });
  return pieces;
}
