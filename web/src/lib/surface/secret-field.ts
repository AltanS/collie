// A SIGN-IN FIELD: the one-line field an agent opens for the code or the redirect address a login page
// shows, or for a key (profile.ts `FrameLayout.secret`). Claude Code's `/login` draws `Paste code here
// if prompted >`, pi's `/login` draws `paste the authorization code / redirect URL here:` over a `> `
// field. What is typed there is a secret: the phone keeps no draft of it, the bridge keeps no line of
// it, and the Send Protocol still checks it on screen before it presses the submit key.
//
// The check is the hard part, because such a field may not show the text as typed. Claude Code
// 2.1.325 draws every character as `*` but the last six (`***************ESTATE`), and a text longer
// than the row as a row of `*` cut with `…`. pi 1.3.0 shows the text, but a text longer than the row
// scrolls, so only its end is on screen. This module says whether the field shows a given text in
// the way its profile says it draws one. It never guesses the hidden part: a mask is checked by its
// length and its clear tail, a cut row by being full of the mask glyph, a scrolled row by being the
// end of the text.
//
// Pure: no DOM, no Bun API, no harness name.

import type { SecretField, SecretMask } from "./profile";

/** A scrolled field shows at least this many characters of a longer text: fewer is no evidence. */
const MIN_TAIL = 16;

/** What the field draws for `typed` under a mask: the glyph for each hidden character, the last `clear` as typed. */
export function maskedText(typed: string, mask: SecretMask): string {
  const chars = [...typed];
  const clear = Math.min(mask.clear, chars.length);
  return mask.glyph.repeat(chars.length - clear) + chars.slice(chars.length - clear).join("");
}

/** Whether `shown` is the end of `drawn`, long enough to count, when the field scrolls (`tail`). */
function tailOf(shown: string, drawn: string): boolean {
  const length = [...shown].length;
  return drawn.endsWith(shown) && length >= Math.min([...drawn].length, MIN_TAIL);
}

/**
 * Whether the field's text `shown` is how the field draws `typed`. Exact text always is. With a mask:
 * the masked form of `typed`, or, with `cut`, a row of the mask glyph cut short of `typed`'s length.
 * With `tail`: the end of the text (or of its masked form) the field scrolled to.
 */
export function fieldShows(shown: string, typed: string, field: Pick<SecretField, "mask" | "tail">): boolean {
  if (shown === "" || typed === "") return false;
  if (shown === typed) return true;
  const mask = field.mask;
  if (mask === undefined) return field.tail === true && tailOf(shown, typed);
  if (mask.cut !== undefined && shown.endsWith(mask.cut)) {
    const glyphs = Array.from(shown.slice(0, shown.length - mask.cut.length));
    return glyphs.length > 0 && glyphs.length < [...typed].length && glyphs.every((glyph) => glyph === mask.glyph);
  }
  const drawn = maskedText(typed, mask);
  return shown === drawn || (field.tail === true && tailOf(shown, drawn));
}
