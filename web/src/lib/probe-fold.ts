// The fold two texts are compared in when one is a journal's source and the other a screen's paint
// (lib/latest-reply.ts holds the argument): letters and digits only, so wrapping, indentation, markdown
// punctuation and glyph prefixes all fall away at once. Alias-free, so the bridge imports it too
// (Hermes's door binds a pane by the same probe, bridge/door/hermes-bind.ts).

/**
 * How much of a turn a probe compares, in folded characters. Long enough that a coincidental match is
 * not a real risk (48 letters of prose is a sentence), short enough to sit inside a message's first and
 * last rendered lines.
 */
export const PROBE_CHARS = 48;

/** Keep letters and digits, lose everything else. Unicode-aware, so a non-Latin text folds to its own content. */
export function fold(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}
