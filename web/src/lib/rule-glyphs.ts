// Shared Unicode rule-glyph classes. Claude's grammar intentionally retains its established broad
// box-drawing contract; visual clipping narrows that to glyphs that are themselves horizontal, so
// a repeated corner/junction can never be mistaken for a terminal-width border.
//
// THIS FILE IS THE WHOLE SHARED SURFACE, AND IT IS MEANT TO STAY THAT WAY. Two things in this
// codebase decide whether a line is a border, and the obvious tidy-up — one predicate, one
// threshold — is the change to refuse:
//
//   · `markers.ts` (isBoxBorder / isInputBoxTopBorder) asks whether this is CLAUDE'S INPUT BOX, to
//     decide whether the reply guard may press Enter. Its false positive types a message into a
//     screen that is not the input box. It is therefore the narrowest possible test — U+2500 only,
//     floored in display cells — and not one of these constants.
//   · `blocks.ts` (PURE_HORIZONTAL_BORDER) asks whether this row is TOO WIDE TO WRAP NICELY, to
//     decide whether to clip it. Its false positive crops a short rule. It can afford a broad glyph
//     set and a plain repetition count.
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

// The glyphs that stand at the left and right edge of a boxed row (a TUI menu, a panel): verticals,
// corners, and the TEES an inner separator row hangs off — light, heavy and double in each. Never a
// horizontal rule glyph: this alphabet answers "is this row framed?", not "is this row a rule".
// blocks.ts is its only consumer (FRAME_ROW), for the same clipping question
// PURE_HORIZONTAL_RULE_GLYPH_CLASS answers for a bare rule; markers.ts must not borrow it (see the
// note at the top of this file).
export const FRAME_EDGE_GLYPH_CLASS = "│┌└├┏┗┣╔╚╠╟╞┐┘┤┓┛┫╗╝╣╢╡";
