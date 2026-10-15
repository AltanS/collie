// The key-hint footer of a pi-family question screen, read as a CONTRACT (.adr/0098).
//
// A pi question extension draws its own footer, and each one words it differently. The footer is
// still the one thing on the screen that says which keys do what, so the reader takes every plan from
// it and from nothing else:
//
//   ↑↓ navigate • Enter to select • Esc to cancel                         stock `question` (pi 0.87.1, 1.1.0)
//   ↑↓ navigate • Enter select • Esc cancel                               stock `questionnaire`, one question
//   Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel              stock `questionnaire`, several
//   ↑↓ navigate • Enter to select • Tab to add note • type a number or an answer • Esc to cancel
//                                                                         the PR 397 extension (pi--v110-*)
//   ↑↓ move  1-9 select  space select  enter next  tab next question  c comment  esc cancel
//                                                                         OmO's built-in ask (pi--omo-v5130-*)
//
// Two separators (` • ` and OmO's double space; ` · ` too, which pi's own modals print) and two hint
// forms (`<key> to <verb>` and `<key> <verb>`). Every segment must be a hint whose key is in the
// small set below, or prose that starts with `type` (a footer that says digits are TYPED TEXT, which
// makes no plan, ADR 0098). One segment that is neither, and the row is not a footer: a countdown, a
// scroll indicator, a status line. What a verb means is read per key, and only the verbs below count;
// any other verb leaves that key with no role, so it can never be the reason a plan exists.
//
// Pure, no harness imports.

/** What the footer says Enter does on this screen. */
export type EnterRole = "select" | "submit" | "other";

export interface PiFooter {
  /** The joined text that was parsed (one space between wrapped rows). */
  text: string;
  /** ↑↓ named, with a verb that moves the pointer (`navigate`, `move`, or `select` as the stock
   *  questionnaire's `↑↓ select` says it). */
  arrowsMove: boolean;
  /** Enter's role, or null when the footer does not name Enter. `select` and `confirm` are `select`;
   *  `submit` is `submit`; every other verb (`next`, `toggle`, `save and next`, `goes to the first
   *  unanswered`) is `other`. */
  enter: EnterRole | null;
  /** `1-9 select`: a digit picks an option. A footer that only says digits may be TYPED is not this. */
  digitsSelect: boolean;
  /** Space named as `tick` or `toggle`. */
  spaceToggles: boolean;
  /** The verb the footer gives Escape (`cancel`, `go back`, `discard`), or null when Esc is not named. */
  escapeVerb: string | null;
  /** Left/Right or Tab named as moving between tabs. */
  tabs: boolean;
}

// Segment separators: a bullet or a middle dot with spaces round it, or a run of two or more spaces.
const SEPARATOR = /\s+[•·]\s+|\s{2,}/;
// `<key> to <verb>` or `<key> <verb>`. The key is one token; the verb is the rest.
const HINT = /^(\S+)\s+(?:to\s+)?(\S.*)$/i;

type KeyKind = "updown" | "leftright" | "enter" | "escape" | "space" | "digits" | "tab" | "letter";

function keyKind(token: string): KeyKind | null {
  if (token === "↑↓" || token === "↑/↓") return "updown";
  if (token === "←→" || token === "←/→" || /^tab\/←\/?→$/i.test(token)) return "leftright";
  if (/^enter$/i.test(token)) return "enter";
  // pi's own core modals print `Escape/Ctrl+C to cancel` (pi--v110-core-selector.txt).
  if (/^(?:esc|escape)(?:\/ctrl\+c)?$/i.test(token)) return "escape";
  if (/^space$/i.test(token)) return "space";
  if (token === "1-9") return "digits";
  if (/^(?:tab|shift\+tab)$/i.test(token)) return "tab";
  if (/^[a-z]$/.test(token) || /^ctrl\+[a-z]$/i.test(token)) return "letter";
  return null;
}

/**
 * Parse one footer, the rows of a wrapped one joined with a space. Null when any segment is neither a
 * hint with a known key nor `type …` prose, or when there are fewer than two segments.
 */
export function parsePiFooter(text: string): PiFooter | null {
  const trimmed = text.trim();
  // A row the terminal wrapped can end in its separator (`… Tab to add note •`, pi--v110-single-narrow).
  const segments = trimmed.split(SEPARATOR).map((s) => s.trim()).filter((s) => s.length > 0 && s !== "•");
  if (segments.length < 2) return null;
  const footer: PiFooter = {
    text: trimmed,
    arrowsMove: false,
    enter: null,
    digitsSelect: false,
    spaceToggles: false,
    escapeVerb: null,
    tabs: false,
  };
  for (const segment of segments) {
    // Typed-text prose: `type a number or an answer`, `type numbers (1,3) or an answer`, `type 1,3`.
    if (/^type\b/i.test(segment)) continue;
    const m = HINT.exec(segment);
    if (m === null) return null;
    const kind = keyKind(m[1]!);
    if (kind === null) return null;
    const verb = m[2]!.trim().toLowerCase();
    switch (kind) {
      case "updown":
        if (verb === "navigate" || verb === "move" || verb === "select") footer.arrowsMove = true;
        break;
      case "enter":
        // Two Enter hints on one footer are two claims; keep the stricter reading.
        footer.enter = combineEnter(footer.enter, enterRole(verb));
        break;
      case "digits":
        if (verb === "select") footer.digitsSelect = true;
        break;
      case "space":
        if (verb === "tick" || verb === "toggle") footer.spaceToggles = true;
        break;
      case "escape":
        footer.escapeVerb = m[2]!.trim();
        break;
      case "leftright":
        footer.tabs = true;
        break;
      case "tab":
      case "letter":
        break;
    }
  }
  return footer;
}

// A picker's key-hint row (.adr/0098, "Pickers"). pi's own pickers and OmO's print one; a question
// footer is one too. Wider keys than the question contract above, because a picker names chords
// (`ctrl+←/→ branch`, `shift+t label time`, `ctrl+d/t/u/l/a`), and one more separator, OmO's single
// space between pairs (`enter select ctrl+s select as default ctrl+f favorite`). The row still has to
// be NOTHING BUT pairs, so prose that mentions a key is not one.

const NAMED_KEY = "enter|return|esc|escape|tab|space|backspace|delete|home|end|pgup|pgdn|pageup|pagedown";
const ARROW_KEY = "↑↓|↑/↓|←→|←/→|↑|↓|←|→";
const MODIFIER = "(?:ctrl|shift|alt|meta|cmd|super)\\+";
/** One key: modifiers, then a named key, an arrow, a letter or a digit. */
const KEY_ATOM = `(?:${MODIFIER})*(?:${NAMED_KEY}|${ARROW_KEY}|[a-z0-9])`;
/** A key token, with the alternatives a hint row joins by `/` (`escape/ctrl+c`, `ctrl+d/t/u/l/a`). */
const HINT_KEY = new RegExp(`^${KEY_ATOM}(?:/(?:${KEY_ATOM}|${ARROW_KEY}))*$`, "i");
/** A chord or an arrow: a token no English word spells, which the single-space form must carry. */
const CHORD = new RegExp(`${MODIFIER}|[↑↓←→]`, "i");

/** A key token of a hint row. A bare letter or digit counts only when `bare` allows it. */
function hintKey(token: string, bare: boolean): boolean {
  if (token === "1-9") return bare;
  if (!HINT_KEY.test(token)) return false;
  return bare || !/^[a-z0-9]$/i.test(token);
}

/**
 * The number of key/action pairs on one key-hint row, or 0 when the row is not one. A row is a hint
 * row when it is nothing but pairs, two or more:
 *   - split by the separators the footers use (` • `, ` · `, two or more spaces), every segment a
 *     `<key> <action>` or `<key> to <action>` pair (`ctrl+p path (off)` is one);
 *   - or, with no such separator, single-space pairs: the row opens with a key, every key is followed
 *     by at least one word, a bare letter is not a key, and one key is a chord or an arrow
 *     (`enter select ctrl+s select as default ctrl+f favorite`). A chord or an arrow always starts a
 *     pair. A named key starts one only after the current pair has its action, so a named key right
 *     after a key is that key's action: `ctrl+d delete ctrl+r rename` is two pairs.
 */
export function keyHintPairs(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return 0;
  const segments = trimmed.split(SEPARATOR).map((s) => s.trim()).filter((s) => s.length > 0);
  if (segments.length >= 2) {
    for (const segment of segments) {
      const m = HINT.exec(segment);
      if (m === null || !hintKey(m[1]!, true)) return 0;
    }
    return segments.length;
  }
  const tokens = trimmed.split(" ");
  let pairs = 0;
  let verbs = 0;
  let chord = false;
  for (const token of tokens) {
    const key = hintKey(token, false);
    const chorded = key && CHORD.test(token);
    // A chord after a key with no action yet: that key had no action, so this is no hint row.
    if (chorded && pairs > 0 && verbs === 0) return 0;
    if (chorded || (key && (pairs === 0 || verbs > 0))) {
      pairs++;
      verbs = 0;
      chord ||= chorded;
    } else {
      if (pairs === 0) return 0;
      verbs++;
    }
  }
  if (verbs === 0 || pairs < 2 || !chord) return 0;
  return pairs;
}

/**
 * The key-hint rows of pi 1.2.0's two list dialogs whose rows are not all key/action pairs: `/settings`
 * (`Type to search · Enter/Space to change · Esc to cancel`, pi--v120-settings-padded2.txt) leads with
 * the search hint, and `/scoped-models` (`Enter toggle · Ctrl+A all · ... · Ctrl+S save · all enabled`,
 * pi--v120-scoped-models-padded2.txt) ends on a status. Matched on the stable fragment, since the
 * rest of the row changes with the width and the state. Both screens draw a search input row
 * (`> ` and the cursor cell) that reads as an editor, so the hint row is the only evidence of a dialog.
 */
const LIST_DIALOG_HINTS = [/\bType to search\s+[•·]\s+Enter\/Space to change\b/, /\bEnter toggle\s+[•·]\s+Ctrl\+A all\b/];

/** Whether a row is one of pi 1.2.0's list-dialog hint rows (`LIST_DIALOG_HINTS`). */
export function listDialogHint(text: string): boolean {
  return LIST_DIALOG_HINTS.some((re) => re.test(text));
}

function enterRole(verb: string): EnterRole {
  if (verb === "select" || verb === "confirm") return "select";
  if (verb === "submit") return "submit";
  return "other";
}

function combineEnter(a: EnterRole | null, b: EnterRole): EnterRole {
  if (a === null || a === b) return b;
  return "other";
}

