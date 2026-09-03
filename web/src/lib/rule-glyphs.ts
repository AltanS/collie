// Shared Unicode rule-glyph classes. Claude's grammar intentionally retains its established broad
// box-drawing contract; visual clipping narrows that to glyphs that are themselves horizontal, so
// a repeated corner/junction can never be mistaken for a terminal-width border.
//
// THIS FILE IS THE WHOLE SHARED SURFACE, AND IT IS MEANT TO STAY THAT WAY. Several tests in this
// codebase decide whether a line is a border; three of them share this file, and the obvious
// tidy-up — one predicate, one threshold — is the change to refuse:
//
//   · `markers.ts` (isBoxBorder / isInputBoxTopBorder) asks whether this is CLAUDE'S INPUT BOX, to
//     decide whether the reply guard may press Enter. Its false positive types a message into a
//     screen that is not the input box. It is therefore the narrowest possible test — U+2500 only,
//     floored in display cells — and not one of these constants.
//   · `blocks.ts` (PURE_HORIZONTAL_BORDER) asks whether this row is TOO WIDE TO WRAP NICELY, to
//     decide whether to clip it. Its false positive crops a short rule. It can afford a broad glyph
//     set and a plain repetition count.
//   · `table-run.ts` (tableRuns) asks whether this row belongs to a TABLE, to decide whether to pan
//     it instead of wrapping it. Its false positive pans readable prose, or worse, a menu. It reads
//     the three classes at the foot of this file plus BOX_DRAWING_RULE_GLYPH_CLASS above, and its
//     predicates and counts are its own.
//
// Same word, different question, and the costs of being wrong are not comparable. markers.ts:86–103
// records what happened the last time one of these tests was reused for the other job — a spaced-out
// prose separator read as an input-box border and defeated the structural guard from the inside.
// Share the alphabet here; never share a predicate or a threshold.

/** All box-drawing glyphs accepted by the existing Claude horizontal-rule grammar. */
export const BOX_DRAWING_RULE_GLYPH_CLASS = "─-╿";
/** Block eighths used by terminal separators. */
export const BLOCK_EIGHTH_RULE_GLYPH_CLASS = "▁-▔";
/** Figure, en, em, and horizontal-bar dashes. ASCII hyphen remains deliberately excluded. */
export const UNICODE_DASH_RULE_GLYPH_CLASS = "‒-―";

/** The established Claude horizontal-rule contract. */
export const CLAUDE_RULE_GLYPH_CLASS =
  BOX_DRAWING_RULE_GLYPH_CLASS + BLOCK_EIGHTH_RULE_GLYPH_CLASS + UNICODE_DASH_RULE_GLYPH_CLASS;

// Horizontal-only members of the box-drawing range: solid, dashed, and double horizontal rules.
// Corners, junctions, and vertical strokes stay out even when repeated.
const HORIZONTAL_BOX_RULE_GLYPH_CLASS = "─━┄┅┈┉╌╍═╴╶╸╺╼╾";

/** Glyphs safe to classify as a repeated, standalone horizontal terminal border. */
export const PURE_HORIZONTAL_RULE_GLYPH_CLASS =
  HORIZONTAL_BOX_RULE_GLYPH_CLASS + BLOCK_EIGHTH_RULE_GLYPH_CLASS + UNICODE_DASH_RULE_GLYPH_CLASS;

// A THIRD question, asked by table-run.ts: is this row part of a TABLE, so the mirror should pan it
// instead of wrapping it? Its false positive pans prose, or worse a menu, but it never types
// anything — which is exactly why it must not borrow either predicate above. It shares only these
// alphabets, and BOX_DRAWING_RULE_GLYPH_CLASS at the head of the file.

/** Box-drawing CROSSES: single, heavy, and double. A cross is one column boundary crossing a row
 *  boundary, which only a table draws — it is the anchor table-run.ts is allowed to trust.
 *
 *  The T-pieces below are deliberately absent, and this is the line that matters. A `┬` sits
 *  wherever ANY two-pane box's divider meets its top border and a `┴` where it meets the bottom, so
 *  anchoring on those claimed omp's splash screen and the whole of its `/model` picker — 18 of the
 *  121 committed pane fixtures — which is the class of screen ADR 0009 exists to keep hands off. */
export const BOX_CROSS_GLYPH_CLASS = "┼-╋╪-╬";

/** Every junction that carries a COLUMN boundary: the crosses above plus the T-pieces. Only ever
 *  used to READ a frame row's column offsets off the anchor, or to recognise one on a member row;
 *  never to decide that a run exists. `├ ┤ ╞ ╡` stay out — they end a frame row without dividing
 *  it, so a single-column chrome box has no column boundary anywhere. */
export const BOX_COLUMN_JUNCTION_GLYPH_CLASS = "┬-╋╤-╬";

/** Vertical strokes that can stand at a column boundary on a content row: solid, heavy, both
 *  dashed weights of each, and double. */
export const BOX_VERTICAL_GLYPH_CLASS = "│┃┆┇┊┋╎╏║";
