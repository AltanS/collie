// A TRICK'S TONE AS INK (M94 slice 02, the tree's tone words since the re-cut). Tones map one to one onto the existing status tokens through the
// schema's `TONE_TEXT_CLASS`, and nothing else gives a trick a colour. A part past its fresh window loses
// its tone: every status tone draws in the unknown grey, because a muted green still reads green in
// sunlight and a bridge that is down must not leave "deploy green" on the glass. `plain` and `muted`
// are inks, not statuses, so they stay.

import { TONE_TEXT_CLASS, TONES, type Tone } from "./schema";

/** The tones that say something about the world, and so go grey when the part is stale. */
const STATUS_TONES: ReadonlySet<Tone> = new Set(["ok", "warn", "danger", "accent"]);

function isTone(word: string): word is Tone {
  return TONES.some((tone) => tone === word);
}

/**
 * The text class a tone draws in, or `""` for no tone (the ink of the surface). A word this Collie
 * does not know (a newer crew member's) draws as no tone.
 */
export function inkOf(tone: string | undefined, stale: boolean): string {
  if (tone === undefined || !isTone(tone)) return "";
  if (stale && STATUS_TONES.has(tone)) return TONE_TEXT_CLASS.unknown;
  return TONE_TEXT_CLASS[tone];
}

/**
 * A chip's ink IN THE USAGE ROW (components/trick-status-item.tsx): the row has one type and one colour, the usage
 * figures', and a chip draws in them by default, so `plain` and `muted` (and a tone this row has no word for) are the
 * row's own ink: no class, the colour is inherited. Only `warn` and `danger` change it, to the tokens they always
 * had (the caution colour and the notice red that a hot usage figure wears). A stale chip loses its tone and reads as
 * the row; its tap says its age.
 */
export function rowInkOf(tone: string | undefined, stale: boolean): string {
  if (stale) return "";
  if (tone === "warn") return TONE_TEXT_CLASS.warn;
  if (tone === "danger") return TONE_TEXT_CLASS.danger;
  return "";
}
