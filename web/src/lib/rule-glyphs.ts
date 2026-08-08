// Shared Unicode rule-glyph classes. Claude's grammar intentionally retains its established broad
// box-drawing contract; visual clipping narrows that to glyphs that are themselves horizontal, so
// a repeated corner/junction can never be mistaken for a terminal-width border.

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
