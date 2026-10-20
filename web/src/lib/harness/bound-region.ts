// What a dialog region a tap is bound to may hold, shared by the grammars that bind one: a size the
// bridge accepts, and no character that changes how a row reads without being seen. The card is what
// someone approves from, so a row the card cannot show faithfully is not lifted.

/** The bridge's cap on a bound region (`MAX_EXPECTED_PROMPT_CHARS`, bridge/server.ts), less a margin.
 *  Mirrored rather than imported, as everything else bridge-sized is in `web/`. */
export const MAX_REGION_CHARS = 32_000;

/** Whether a row holds a character that changes how it reads without being seen: the soft hyphen, the
 *  Arabic letter mark, zero-width and directional marks, the line and paragraph separators, the bidi
 *  embeddings, overrides and isolates, the invisible operators, variation selectors, the byte-order mark
 *  and the tag characters, plus every C0 or C1 control. Found by code point, so no pattern holds a raw
 *  control or combining character. */
export function hasHiddenCharacter(row: string): boolean {
  for (const ch of row) {
    const code = ch.codePointAt(0)!;
    if (
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0xad ||
      code === 0x61c ||
      code === 0x180e ||
      (code >= 0x200b && code <= 0x200f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) ||
      (code >= 0xfe00 && code <= 0xfe0f) ||
      code === 0xfeff ||
      (code >= 0xe0000 && code <= 0xe007f)
    ) {
      return true;
    }
  }
  return false;
}
