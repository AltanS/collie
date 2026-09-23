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
// HOW. The character is wrapped in a `cell-glyph` span with a `data-cell` attribute naming its
// shape, and index.css paints each shape as a background in `currentColor` — so it takes the
// segment's own foreground, and the inversion filter (.adr/0002) treats it exactly like text. The
// character itself STAYS in the span as a text node, so find offsets, link offsets, selection and
// copy are byte-identical; only its ink is emptied.
//
// A BLOCK ELEMENT IS PAINTED TO THE ROW, NOT TO THE SPAN. An inline span's background covers the
// font's CONTENT AREA (its ascent plus descent), and that is neither the em box nor the row, nor
// even centred on the row: at 10px, 13px against a 12.5px row pitch and 0.75px high, in Chromium on
// Linux. So a block's shape is painted on a `::before` band that takes the line box's own top and
// is `1lh` tall: the row, exactly, in Chromium and WebKit. Stacked `█` rows meet with no gap and no
// overlap, and a half block splits at half the row. index.css has the rules and the reason the
// band lands there.
//
// A POWERLINE GLYPH IS PAINTED TO ITS NEIGHBOUR, the content area, because its job is to join the
// segment background beside it, and that background covers the content area too. Painted to the
// row, a cap would step out of its pill wherever the two differ.
//
// EVERY SHAPE IS A BACKGROUND, NEVER A `clip-path`, AND THAT IS MEASURED. A clipped box does not
// meet the clipped box beside it: each one antialiases its own edge, so a run of full blocks — a
// progress bar, the common case — grows a seam at every cell boundary. Twelve adjacent full blocks
// at device pixel ratio 3: `clip-path: inset(0)` leaves 6 visible seams in Chromium and 4 in
// WebKit, and WebKit's drop all the way to the page background. The same twelve painted as
// backgrounds leave none in either engine. So a rectangle is a `linear-gradient` layer sized and
// positioned inside its box, and a round cap is `border-radius` on a full one.
//
// ONE SPAN PER CHARACTER, NEVER ONE PER RUN. A bar of forty `█` as one span would be cheaper, but
// a wrapping mirror can break a long run across two lines, and the band is one box: the second
// line would lose its paint and, with its ink emptied, show nothing. A single character never
// breaks. What the hot path saves instead: one regex search answers "nothing to paint" for almost
// every run, and a painted span carries a `data-cell` name and no style object.
//
// IT MOVES NOTHING. The span sets no width, no display and no padding, and the band is absolutely
// positioned and takes no room, so the character keeps its own advance:
// a Powerline cap stays as wide as the symbol face makes it, every column lands where it landed
// before, and the only difference on screen is that the shape now reaches the top and bottom of its
// row. The documented advance-width drift (index.css § "EXPECTED, NOT A BUG") is untouched, on
// purpose. Sizing a cell here would fix that drift and move a prompt's columns in the same commit,
// and a column-faithful box in the client is the grid ADR 0008 refuses. The browser case fails if a
// later hand gives this span a size, so the boundary is held by a test and not by this paragraph.
//
// NO PANE BYTE EVER COMPOSES A CSS VALUE. A character selects one of the constant names in the
// table below by exact match, or it is left alone. Nothing is interpolated, parsed, or built, and
// the element carries no inline style: the paint is a fixed rule per name in index.css.
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

/** The name index.css keys a shape's paint on, as `.cell-glyph[data-cell="…"]`. The eighths count
 *  how many eighths of the cell are inked, from the wall they grow from; a quadrant names the
 *  quarters it inks. */
export type CellFill =
  | "full"
  | `lower-${1 | 2 | 3 | 4 | 5 | 6 | 7}`
  | `left-${1 | 2 | 3 | 4 | 5 | 6 | 7}`
  | "upper-1"
  | "upper-4"
  | "right-1"
  | "right-4"
  | "quad-ll"
  | "quad-lr"
  | "quad-ul"
  | "quad-ur"
  | "quad-ul-ll-lr"
  | "quad-ul-lr"
  | "quad-ul-ur-ll"
  | "quad-ul-ur-lr"
  | "quad-ur-ll"
  | "quad-ur-ll-lr"
  | "wedge-right"
  | "wedge-left"
  | "round-right"
  | "round-left";

/** Keyed by the character, and written with escapes rather than the literal: several of these are
 *  invisible in an editor, and the Powerline four are private-use codepoints that show as tofu in
 *  most of them. */
export const CELL_FILL = {
  // Lower eighths: ink on the floor, growing up. The full block is the eighth of both runs.
  "\u2581": "lower-1",
  "\u2582": "lower-2",
  "\u2583": "lower-3",
  "\u2584": "lower-4",
  "\u2585": "lower-5",
  "\u2586": "lower-6",
  "\u2587": "lower-7",
  "\u2588": "full",
  // Left eighths: ink on the left wall, growing right.
  "\u2589": "left-7",
  "\u258a": "left-6",
  "\u258b": "left-5",
  "\u258c": "left-4",
  "\u258d": "left-3",
  "\u258e": "left-2",
  "\u258f": "left-1",
  // The halves and eighths that grow the other way.
  "\u2580": "upper-4",
  "\u2590": "right-4",
  "\u2594": "upper-1",
  "\u2595": "right-1",
  // Quadrants, named by the quarters they ink.
  "\u2596": "quad-ll",
  "\u2597": "quad-lr",
  "\u2598": "quad-ul",
  "\u2599": "quad-ul-ll-lr",
  "\u259a": "quad-ul-lr",
  "\u259b": "quad-ul-ur-ll",
  "\u259c": "quad-ul-ur-lr",
  "\u259d": "quad-ur",
  "\u259e": "quad-ur-ll",
  "\u259f": "quad-ur-ll-lr",
  // Powerline, the thick half of each pair: two separators and two round caps.
  "\ue0b0": "wedge-right",
  "\ue0b2": "wedge-left",
  "\ue0b4": "round-right",
  "\ue0b6": "round-left",
} as const satisfies Record<string, CellFill>;

/** Exactly the keys of CELL_FILL, as one character class; cell-glyphs.test.ts holds the two in
 *  step. Global, so one pass finds every match. */
const PAINTED = /[\u2580-\u2590\u2594-\u259f\ue0b0\ue0b2\ue0b4\ue0b6]/g;

/** A slice of a segment: plain text, or one painted character. */
export interface CellPiece {
  text: string;
  /** How to paint `text`; absent means render it as it always was. */
  cell?: CellFill;
}

/**
 * Split a rendered run into plain stretches and the single characters that must be painted.
 *
 * Returns `null` — not `[{ text }]` — when the run holds none, which is almost every run in the
 * mirror. The first regex search is the whole cost of that answer: no per-character loop, and the
 * caller then emits the string it already had.
 *
 * Every covered character is in the BMP, so the regex never matches half a surrogate pair.
 */
export function cellPieces(text: string): CellPiece[] | null {
  PAINTED.lastIndex = 0;
  let match = PAINTED.exec(text);
  if (match === null) return null;

  const pieces: CellPiece[] = [];
  let plain = 0; // where the plain stretch before the next match starts
  while (match !== null) {
    if (match.index > plain) pieces.push({ text: text.slice(plain, match.index) });
    // SAFETY: PAINTED's class is exactly CELL_FILL's keys, one code unit each, and the test above
    // walks both ranges to hold them equal.
    const ch = match[0] as keyof typeof CELL_FILL;
    pieces.push({ text: ch, cell: CELL_FILL[ch] });
    plain = PAINTED.lastIndex;
    match = PAINTED.exec(text);
  }
  if (plain < text.length) pieces.push({ text: text.slice(plain) });
  return pieces;
}
