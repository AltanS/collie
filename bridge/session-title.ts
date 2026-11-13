// ONE NORMALIZER FOR EVERY NAME A HARNESS OR A MULTIPLEXER GIVES A SESSION.
//
// A session's name arrives from several places: a harness's journal (a name the person set, or the
// agent's own title), a screen read (Claude's `/rename` name in the rule of its input box), a Muse
// journal row, and every multiplexer's terminal title. Each used to be cleaned its own way or not at
// all: Herdr, herdr-core and tuios stripped a spinner glyph, tmux, zellij, tern and the durable
// adapter passed the title through raw, and a scraped name had no cap. So the same session could read
// `✳ Fix the login bug` on one machine and `Fix the login bug` on another.
//
// Every one of those strings now goes through {@link normalizeTitle} before it reaches a view (a
// terminal title through {@link normalizeTerminalTitle}, which also drops a status glyph), and
// the rest of the bridge treats the result as display text. It names no harness: what a harness
// calls a name is its adapter's business (journal/*.ts `nameProbe`), how the text is cleaned is this
// file's.

/** The longest session name a pane carries, in graphemes. A real one is under 60. */
export const TITLE_MAX = 80;

// A leading status glyph, e.g. Claude's `◐ Reviewing the diff`. The classes are the symbol blocks a
// harness draws a spinner from: Geometric Shapes (◐◑◒◓), Miscellaneous Symbols, Dingbats (✳✻✽✢),
// Misc Symbols and Arrows, emoji, plus the bare `*` and `·` some use.
//
// The trailing `\s` is the safety, and it is why this is a whitelist of BLOCKS rather than of
// individual frames: a status glyph is always followed by a space before the title text, so
// requiring one lets this strip spinner frames nobody has observed yet without eating a title that
// merely OPENS with punctuation (`(main) vim`, `— draft`). Bounded to 2 glyphs; no real prefix is
// longer, and an unbounded run on hostile input would scan the whole string.
const STATUS_GLYPH_CLASS = "■-◿☀-⛿✀-➿⬀-⯿\\u{1F300}-\\u{1FAFF}*·";

/** A leading status glyph and the space after it. */
export const LEADING_STATUS_GLYPH = new RegExp(`^[${STATUS_GLYPH_CLASS}]{1,2}\\s+`, "u");

/** A string with no prose in it at all, a bare spinner frame, which names nothing. Needed apart from
 *  the strip above, which requires trailing whitespace, so `"◐"` alone would otherwise survive. */
export const GLYPHS_ONLY = new RegExp(`^[${STATUS_GLYPH_CLASS}\\s]+$`, "u");

/** Control characters (C0, C1), which a title may carry from an escape sequence, become a space. */
const CONTROL_CHARS = /\p{Cc}+/gu;

/**
 * Format characters, which draw nothing: zero-width space (U+200B), word joiner (U+2060), the byte order
 * mark, soft hyphen, and the bidirectional overrides and isolates, which could also reorder the text
 * around them. All of `\p{Cf}` but the zero-width joiner, which joins an emoji sequence (below).
 */
const FORMAT_CHARS = /[\p{Cf}--[\u200D]]+/gv;

/** A zero-width joiner that joins no two pictographs is one more invisible character. */
const LOOSE_JOINER = /(?<!\p{Extended_Pictographic}(?:\u{FE0E}|\u{FE0F}|\p{Emoji_Modifier})?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu;

/**
 * Characters that draw as a blank but are no space to `\s`: the Braille blank (U+2800), the Hangul
 * fillers (U+115F, U+1160, U+3164, U+FFA0), the combining grapheme joiner (U+034F) and the Mongolian
 * vowel separator (U+180E). Each becomes a space, so a name made of them alone is nothing.
 */
const BLANK_FILLERS = /[\u034F\u115F\u1160\u180E\u2800\u3164\uFFA0]/gu;

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A session name as display text, or `undefined` when it says nothing.
 *
 * In order: no string is nothing; control characters and blank fillers become a space; format
 * characters and a joiner outside an emoji go; runs of blanks become one space; the ends are trimmed;
 * the result is cut at {@link TITLE_MAX} graphemes, so a flag, a skin tone or a family emoji is kept
 * whole or left out whole. A string left empty is nothing. A name a person typed keeps a leading
 * emoji or `*`: only a terminal title loses a status glyph ({@link normalizeTerminalTitle}). Pure, so
 * every source is tested against the same table.
 */
export function normalizeTitle(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const visible = raw.replace(CONTROL_CHARS, " ").replace(BLANK_FILLERS, " ").replace(FORMAT_CHARS, "").replace(LOOSE_JOINER, "");
  const collapsed = visible.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return undefined;
  return cutGraphemes(collapsed, TITLE_MAX);
}

/**
 * A terminal title as display text: {@link normalizeTitle}, after a leading status glyph goes. A program
 * paints its state into the title it sets (Claude's `◐ Reviewing the diff`, `✳` when it settles), so the
 * glyph is no part of the name there, and a title of glyphs only names nothing.
 */
export function normalizeTerminalTitle(raw: string | null | undefined): string | undefined {
  const clean = normalizeTitle(raw);
  if (clean === undefined || GLYPHS_ONLY.test(clean)) return undefined;
  return normalizeTitle(clean.replace(LEADING_STATUS_GLYPH, ""));
}

/** The first `max` graphemes of a string, the end trimmed. */
function cutGraphemes(text: string, max: number): string {
  const parts: string[] = [];
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (parts.length === max) return parts.join("").trimEnd();
    parts.push(segment);
  }
  return text;
}

/**
 * What a harness's own records say a session is called, before {@link normalizeTitle} cleans it.
 *
 * Two names, because a harness can hold both: `person` is a name the person set in the harness
 * (Claude's `/rename`, pi's `/name`), `agent` is the title the agent gave the session itself (Claude's
 * `ai-title`, Oh My Pi's automatic title, OpenCode's session title). For each field: a string is the
 * name, `null` says the records prove there is none (a title cleared), and `undefined` says the read
 * found nothing either way, so the last name known stands.
 */
export interface NameReading {
  person?: string | null;
  agent?: string | null;
}

/** The two names a session carries once cleaned. Absent means none. */
export interface SessionTitles {
  person?: string;
  agent?: string;
}
