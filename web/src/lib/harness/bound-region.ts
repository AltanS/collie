// What a dialog region a tap is bound to may hold, shared by the grammars that bind one: a size the
// bridge accepts, and no character that changes how a row reads without being seen. The card is what
// someone approves from, so a row the card cannot show faithfully is not lifted.

/** The bridge's cap on a bound region (`MAX_EXPECTED_PROMPT_CHARS`, bridge/server.ts), less a margin.
 *  Mirrored rather than imported, as everything else bridge-sized is in `web/`. */
export const MAX_REGION_CHARS = 32_000;

// Every control (C0, DEL, C1), format character (the soft hyphen, the Arabic letter mark, zero-width
// and directional marks, the bidi embeddings, overrides and isolates, the invisible operators, the
// byte-order mark, the tag characters), the line and paragraph separators, and every other default
// ignorable code point, such as the variation selectors. Written as Unicode properties, so the pattern
// holds no raw control or combining character.
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}]/u;

/** Whether a row holds a character that changes how it reads without being seen. */
export function hasHiddenCharacter(row: string): boolean {
  return HIDDEN_CHARACTER.test(row);
}
