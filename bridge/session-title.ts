// ONE NORMALIZER FOR EVERY NAME A HARNESS OR A MULTIPLEXER GIVES A SESSION.
//
// A session's name arrives from several places: a harness's journal (a name the person set, or the
// agent's own title), a screen read (Claude's `/rename` name in the rule of its input box), a Muse
// journal row, and every multiplexer's terminal title. Each used to be cleaned its own way or not at
// all: Herdr, herdr-core and tuios stripped a spinner glyph, tmux, zellij, tern and the durable
// adapter passed the title through raw, and a scraped name had no cap. So the same session could read
// `✳ Fix the login bug` on one machine and `Fix the login bug` on another.
//
// Every one of those strings now goes through {@link normalizeTitle} before it reaches a view, and
// the rest of the bridge treats the result as display text. It names no harness: what a harness
// calls a name is its adapter's business (journal/*.ts `nameProbe`), how the text is cleaned is this
// file's.

/** The longest session name a pane carries, in code points. A real one is under 60. */
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

/** Bidirectional overrides and isolates, which could reorder the text around them, are dropped. */
const BIDI_CHARS = /\p{Bidi_Control}+/gu;

/**
 * A session name as display text, or `undefined` when it says nothing.
 *
 * In order: no string is nothing; control characters become a space and bidirectional
 * controls go; a leading status glyph goes; runs of blanks become one space; the ends are trimmed;
 * the result is cut at {@link TITLE_MAX} code points. A string left empty, or made of glyphs only, is
 * nothing. Pure, so every source is tested against the same table.
 */
export function normalizeTitle(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const plain = raw.replace(BIDI_CHARS, "").replace(CONTROL_CHARS, " ").trim();
  if (plain === "" || GLYPHS_ONLY.test(plain)) return undefined;
  const unglyphed = plain.replace(LEADING_STATUS_GLYPH, "");
  const collapsed = unglyphed.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return undefined;
  const points = Array.from(collapsed);
  return points.length <= TITLE_MAX ? collapsed : points.slice(0, TITLE_MAX).join("").trimEnd();
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
