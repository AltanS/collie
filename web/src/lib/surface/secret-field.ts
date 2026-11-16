// A SIGN-IN FIELD: the one-line field an agent opens for the code or the redirect address a login page
// shows, or for a key (profile.ts `FrameLayout.secret`). Claude Code's `/login` draws `Paste code here
// if prompted >`, pi's `/login` draws `paste the authorization code / redirect URL here:` over a `> `
// field. What is typed there is a secret: the phone keeps no draft of it, the bridge keeps no line of
// it, and the Send Protocol still checks it on screen before it presses the submit key.
//
// The check is the hard part, because such a field may not show the text as typed. Claude Code
// 2.1.325 draws every character as `*` but the last six (`***************ESTATE`), and a text longer
// than the row as a row of `*` cut with `…`. pi 1.3.0 shows the text, but a text longer than the row
// scrolls, so only its end is on screen. Claude Code's first-run field (an empty config folder) wraps a
// long text under its label instead of cutting it, and shows clear characters on its last row only. This module says whether the field shows a given text in
// the way its profile says it draws one. It never guesses the hidden part: a mask is checked by its
// length and its clear tail, a cut row by being full of the mask glyph, a scrolled row by being the
// end of the text.
//
// Pure: no DOM, no Bun API, no harness name.

import type { Profile, SecretField, SecretMask } from "./profile";

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
 * Whether the rows of a wrapping field (`wrap`), joined with no space, draw `typed` under `mask`: as many
 * characters as `typed` holds, the mask glyph for each, but a clear tail of at most `mask.clear` that is
 * `typed`'s own end. The clear tail is shorter when the last row holds fewer characters (Claude Code
 * 2.1.325 at 40 columns: 21 characters draw `********`, `********`, `STATE`). Never guesses a hidden one.
 */
function wrappedShows(shown: string, typed: string, mask: SecretMask): boolean {
  const drawn = Array.from(shown.replace(/\s+/gu, ""));
  const chars = [...typed];
  if (drawn.length !== chars.length) return false;
  let clear = 0;
  while (clear < drawn.length && drawn[drawn.length - 1 - clear] !== mask.glyph) clear++;
  if (clear > mask.clear) return false;
  for (let i = 0; i < drawn.length - clear; i++) if (drawn[i] !== mask.glyph) return false;
  return drawn.slice(drawn.length - clear).join("") === chars.slice(chars.length - clear).join("");
}

/**
 * Whether the field's text `shown` is how the field draws `typed`. Exact text always is. With a mask:
 * the masked form of `typed`, or, with `cut`, a row of the mask glyph cut short of `typed`'s length, or,
 * with `wrap`, the masked form over rows that join with no space ({@link wrappedShows}). With `tail`:
 * the end of the text (or of its masked form) the field scrolled to.
 */
export function fieldShows(shown: string, typed: string, field: Pick<SecretField, "mask" | "tail" | "wrap">): boolean {
  if (shown === "" || typed === "") return false;
  if (shown === typed) return true;
  const mask = field.mask;
  if (mask !== undefined && field.wrap === true && wrappedShows(shown, typed, mask)) return true;
  if (mask === undefined) return field.tail === true && tailOf(shown, typed);
  if (mask.cut !== undefined && shown.endsWith(mask.cut)) {
    const glyphs = Array.from(shown.slice(0, shown.length - mask.cut.length));
    return glyphs.length > 0 && glyphs.length < [...typed].length && glyphs.every((glyph) => glyph === mask.glyph);
  }
  const drawn = maskedText(typed, mask);
  return shown === drawn || (field.tail === true && tailOf(shown, drawn));
}

/** How many of the screen's last rows that are not blank {@link signInShown} reads. */
const SIGN_IN_REACH = 12;

const signInCache = new WeakMap<readonly string[], readonly RegExp[]>();

/**
 * Whether one of the profile's `idle.signInRows` matches one of the screen's last rows that are not
 * blank: a sign-in field is on screen, whether or not a layout reads it. The caller asks only where no
 * other box was found, so a chat line that quotes such a row over a live input box never counts.
 */
export function signInShown(texts: readonly string[], idle: Pick<Profile["idle"], "signInRows">): boolean {
  const sources = idle.signInRows;
  if (sources === undefined || sources.length === 0) return false;
  let patterns = signInCache.get(sources);
  if (patterns === undefined) {
    patterns = sources.map((source) => new RegExp(source, "u"));
    signInCache.set(sources, patterns);
  }
  let seen = 0;
  for (let i = texts.length - 1; i >= 0 && seen < SIGN_IN_REACH; i--) {
    const text = texts[i]!.trim();
    if (text === "") continue;
    seen++;
    if (patterns.some((pattern) => pattern.test(text))) return true;
  }
  return false;
}

const rejectCache = new WeakMap<readonly string[], readonly RegExp[]>();

/** How many rows an error sentence may wrap onto under the row that matched. */
const REJECTION_ROWS = 4;

/**
 * What the screen says where the agent did not take a sign-in code, top to bottom: each row one of the
 * profile's `idle.signInErrors` matches, joined with the rows its sentence wraps onto (up to a blank
 * row or a row with no letter, a rule; at most {@link REJECTION_ROWS} rows in all), each trimmed. An
 * earlier try's error may still stand in the scrollback, so a caller compares the count with a read
 * from before the code went in. Pure.
 */
export function signInRejections(texts: readonly string[], idle: Pick<Profile["idle"], "signInErrors">): string[] {
  const sources = idle.signInErrors;
  if (sources === undefined || sources.length === 0) return [];
  let patterns = rejectCache.get(sources);
  if (patterns === undefined) {
    patterns = sources.map((source) => new RegExp(source, "u"));
    rejectCache.set(sources, patterns);
  }
  const found: string[] = [];
  for (let at = 0; at < texts.length; at++) {
    const head = texts[at]!.trim();
    if (head === "" || !patterns.some((pattern) => pattern.test(head))) continue;
    const words: string[] = [];
    for (let i = at; i < texts.length && words.length < REJECTION_ROWS; i++) {
      const text = texts[i]!.trim();
      if (text === "" || !/\p{L}/u.test(text)) break;
      words.push(text);
    }
    found.push(words.join(" "));
  }
  return found;
}

/**
 * A refused code's detail where the agent's words could not be kept (they held the code): the plain
 * sentence, which the phone's own sentence already says, so the phone shows its own alone.
 */
export const CODE_REJECTED_PLAIN = "The agent did not take the code.";

/** The shortest run of a code's characters that, found in the agent's words, drops them. */
export const CODE_RUN = 6;

/**
 * The agent's words about a code it did not take, made safe to keep: null when they hold the code (a
 * code shorter than {@link CODE_RUN} is looked for whole), or any run of {@link CODE_RUN} or more of
 * its characters in a row (an agent that echoes the code, or a
 * part of it, in its error); else the words cut to `max` characters. Whitespace is left out of both
 * sides first, so a code the screen wrapped is still found. With null the plain sentence stands alone.
 * The words go into the stored receipt, the report line and the phone. Pure.
 */
export function rejectionDetail(words: string, code: string, max: number): string | null {
  const said = [...words.replace(/\s+/gu, "")];
  const secret = [...code.replace(/\s+/gu, "")];
  const heard = said.join("");
  // A code shorter than a run is looked for whole; an empty one cannot be echoed.
  if (secret.length > 0 && secret.length < CODE_RUN && heard.includes(secret.join(""))) return null;
  for (let at = 0; at + CODE_RUN <= secret.length; at++) {
    if (heard.includes(secret.slice(at, at + CODE_RUN).join(""))) return null;
  }
  return [...words].slice(0, max).join("");
}
