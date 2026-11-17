// The generic menu sign (M102 spec 12, decision 4). A profile-free look at the bottom window of a
// screen for a menu or a yes/no prompt: the one guard on the person's override ("Send past this screen") on
// a screen no reader could read. Where it fires, the override is refused `menu_open`, nothing is typed,
// and the phone shows the key pad: a pasted "1" or "y", or the Enter the person presses next, would
// otherwise pick an option the person never chose.
//
// It is built from the corpus, not from one harness (menu-sign.corpus.test.ts runs it over every dialog
// and every idle fixture and pins the hit and false rates). It errs on the side of firing: a false
// sign costs the person one press on the key pad, a missed one can answer a permission.
//
// The signs, each read on the window only:
//  - a pointer glyph in front of an option: a numbered item or a choice word;
//  - a numbered option list: two items or more with consecutive numbers, close together;
//  - choice rows: two rows or more that hold only Yes, No, Allow, Deny, Cancel, Always and the like;
//  - a `(y/n)` or `[Y/n]` form, or a row of single-key items (`a approve | s request changes`);
//  - a hint row that names a key for a menu verb ("Enter to confirm", "Esc to cancel", "↑/↓ to
//    navigate"), or two key hints of any verb on the window ("enter resume   esc exit").
//
// The window: with no input box found, the last {@link MENU_WINDOW_ROWS} rows of the screen. With a box
// the reader found, its rows are read as blank (a draft that quotes these words is the person's text,
// not a menu), and the transcript above it is read only for {@link ABOVE_BOX_ROWS} rows: a dialog drawn
// over a live box stands right on it, a list further up is the agent's answer.
//
// The anchored reading (`anchor`, the blind road on a pane whose foreground is a program or not known;
// a shell gets no sign at all): with no box, a sign counts only where it stands live at the bottom. A
// yes/no form on the last or second-last row; any other sign when no prompt row is the bottom row under
// it and at most {@link ANCHOR_ROWS} rows that are no part of a menu stand under it. A numbered `cat -n`,
// a git log or an answered `[Y/n]` above a shell prompt is old output, not a question.
//
// Pure, and it names no harness (no-harness-names.test.ts holds this folder to that).

import { isSingleKeyRow } from "./key-row";

/** The rows the sign reads with no box: the last rows of the screen, as many as the rows hash reads. */
export const MENU_WINDOW_ROWS = 24;
/** The rows over a found box the sign reads. */
export const ABOVE_BOX_ROWS = 1;
/**
 * The anchored reading's K (see {@link anchored}): the most rows that are not a part of a menu that may
 * stand under a sign. The smallest K that keeps 98 % of the dialog fixtures with no box (menu-sign.corpus.test.ts,
 * measured 2026-11-17: K 3 reads 97.9 %, K 4 99.0 %); an agent draws its status, its box and a
 * task list under a dialog. Old output above a shell prompt is caught by the prompt row, not by K.
 */
export const ANCHOR_ROWS = 4;

/** Every kind of sign, the list a stored receipt's `menuSign.kind` is checked against. */
export const MENU_SIGN_KINDS = ["pointer", "pointed-list", "numbered", "choices", "yes-no", "single-key", "hint", "position", "dismiss", "commands", "search"] as const;
export type MenuSignKind = (typeof MENU_SIGN_KINDS)[number];

export interface MenuSign {
  readonly kind: MenuSignKind;
  /** The screen row it was found on. */
  readonly row: number;
}

/**
 * A found input box, as the reader's frame names it: its top edge, and the rows the sign never reads
 * there: the box's interior (the person's text), and the rows the profile itself names around the box
 * (a notice over it whose keys act only on a box holding one of them, the named footer rows under it).
 */
export interface MenuBox {
  readonly top: number;
  readonly skip: ReadonlySet<number>;
}

/** Pointer glyphs, with the icon fonts' own chevrons and carets (Nerd Font U+F054, U+F0DA, U+F105, U+F061). */
const POINTERS = "❯›>▶►→➜❱▸➤⟩❭〉\u{F054}\u{F0DA}\u{F105}\u{F061}";
const BORDERS = /[│┃║▌▐╭╮╰╯┌┐└┘├┤]/gu;
const POINTER_ROW = new RegExp(`^(\\s*)([${POINTERS}])(\\s*)(\\S.*)$`, "u");
const NUMBERED = /^\s*(?:\[(\d{1,2})\]|(\d{1,2})[.)]|(\d{1,2})(?=\s{2,}))\s+\S/u;
const NUMBER_LEAD = /^\s*(?:\[\d{1,2}\]|\d{1,2}[.)]|\d{1,2}(?=\s{2,}))\s+/u;
/** A radio or a check box, with the icon fonts' own (circle-o, circle, dot-circle, square-o, square, check-square, check-circle). */
const BOX_GLYPHS = "☐☑☒◯○◉◻◼\u{F10C}\u{F111}\u{F192}\u{F096}\u{F0C8}\u{F046}\u{F14A}\u{F058}";
const CHECKBOX_LEAD = new RegExp(`^\\s*(?:\\[[ xX✓✔•*-]?\\]|\\([ ○●◉xX✓✔•*-]?\\)|[${BOX_GLYPHS}])\\s+`, "u");
const YES_NO_FORM = /[([]\s*y(?:es)?\s*\/\s*n(?:o)?\s*[)\]]/iu;
/** The words of a choice row, alone on it once its pointer, number and box are gone. */
const CHOICE =
  /^(?:yes|no|y|n|ok|allow|deny|cancel|always|never|accept|reject|decline|approve|skip|continue|proceed|abort|retry|quit|submit|confirm|allow once|allow always|always allow|deny once|yes,? (?:allow|and|for|always|don'?t|proceed)\b.*|no,? (?:and|tell|deny|cancel|exit|keep|quit|thanks)\b.*)$/iu;
/** One key as a hint names it. A private-use glyph is an icon font's key cap. */
const KEY_ATOM =
  "(?:enter|return|esc|escape|tab|space|backspace|shift\\+tab|shift\\+[a-z]|ctrl\\+[a-z.]|alt\\+[a-z↑↓]|\\^[a-z]|⌃[a-z]|f\\d{1,2}|pgup|pgdn|up|down|left|right|[↑↓←→⏎↵⎋]+|[\\u{E000}-\\u{F8FF}\\u{F0000}-\\u{FFFFD}]|arrow keys|arrows)";
const KEY = `${KEY_ATOM}(?:\\s*/\\s*${KEY_ATOM})*`;
/** A verb only a menu's hint names. */
const MENU_VERB = "(?:confirm|select|cancel|choose|navigate|approve|deny|reject|accept|allow|decline|pick|answer|move|apply|close|exit|back|go back|continue|proceed)";
/** Any verb a key hint names (the cue reader's list, cues.ts). */
const ANY_VERB =
  "(?:confirm|select|cancel|submit|continue|choose|proceed|approve|deny|reject|accept|go back|back|exit|close|dismiss|navigate|toggle|answer|adjust|amend|move|pick|view|stop|quit|filter|search|scroll|switch|apply|save|skip|next|previous|prev|open|allow|decline|change|clear|reset|focus|use|details|resume|edit|browse|delete|reply|return)";
/** A picker's place in its list: `(1/9)`, `2 / 5 · 40%`, `… 372 more below`. */
const POSITION = /^\s*(?:\(\d+\s*\/\s*\d+\)|\d+\s*\/\s*\d+\s*(?:·|$))|…\s*\+?\d+\s+more\s+(?:below|above)|^\s*[↑↓]\s*\d+\s+more\b/iu;
/** A title row that names only its close key, at its right end after a wide gap. */
const DISMISS_HEADER = /^\s*\S(?:.*\S)?\s{3,}(?:esc|escape)\s*$/iu;
/** A search field's label, or the words of a picker that filters as the person types. */
const SEARCH = /\btype to (?:search|filter)\b|^\s*(?:search|filter)(?:\s+\w+)?:\s|⌕|\breverse-i-search\b/iu;
/** A slash command with its description in a second column ("/agents     Switch agent"). */
const COMMAND_ENTRY = new RegExp(`^(\\s*)(?:[${POINTERS}]\\s*)?/[\\w:.-]+\\s{2,}\\S`, "u");
/** A row that holds only a slash query: "/", "/res", "❯ /usage". */
const COMMAND_QUERY = new RegExp(`^\\s*(?:[${POINTERS}]\\s*)?/[\\w:.-]*\\s*$`, "u");
/** A row of choice words side by side: `Skip  Confirm`, `Yes | No`. */
const ITEMS = /\s{2,}|\s*[|│·]\s*/u;
/** A mark in front of an option's text, after the pointer: a tick or a radio. */
const MARK_LEAD = new RegExp(`^[✔✓●${BOX_GLYPHS}]\\s+`, "u");
/** A row that only continues the one above it in a tree: a tool's result, a nested line. */
const TREE_LEAD = /^\s*[⎿└├│]/u;
/** A list item behind a bullet: a row of a picker's list. */
const BULLET_LEAD = /^\s*[•◦▪]\s+\S/u;

const hint = (verb: string, flags: string): RegExp => new RegExp(`(?:^|[^\\w+])(?:press\\s+)?${KEY}\\s*(?:to\\s+|:\\s*|=\\s*|\\s+)${verb}s?\\b`, flags);
const MENU_HINT = hint(MENU_VERB, "iu");
const ANY_HINTS = hint(ANY_VERB, "giu");
const ANY_HINT = hint(ANY_VERB, "iu");
/** A prompt waiting for a line: a row that ends in a prompt glyph (`$`, `#`, `%` but no percentage, `>`, `❯`, `»`, `➜`, `λ`). */
const PROMPT_END = /(?:[$#>❯»➜λ]|(?<!\d)%)\s*$/u;

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** The option a row names once its pointer is gone: its text with a number and a checkbox cut. */
function optionText(text: string): string {
  return text.replace(NUMBER_LEAD, "").replace(CHECKBOX_LEAD, "").trim();
}

function numberOf(text: string): number | null {
  const m = NUMBERED.exec(text);
  return m === null ? null : Number(m[1] ?? m[2] ?? m[3]);
}

function isChoice(text: string): boolean {
  return CHOICE.test(optionText(text));
}

/** The window's rows by screen index (see the header); every other row is left out. */
export function menuWindow(texts: readonly string[], box: MenuBox | null): Map<number, string> {
  let end = texts.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  let first = end;
  if (box === null) {
    for (let seen = 0; first > 0 && seen < MENU_WINDOW_ROWS; ) if (!isBlank(texts[--first]!)) seen++;
  } else {
    first = Math.max(0, box.top - ABOVE_BOX_ROWS);
    // A numbered list that ends right on the box is read whole: the row above is one option, the run up
    // from it the others (a dialog of numbered options drawn over a box the reader still finds).
    for (let up = 0; first > 0 && up < MENU_WINDOW_ROWS && NUMBERED.test(texts[first]!) && NUMBERED.test(texts[first - 1]!); up++) first--;
  }
  const rows = new Map<number, string>();
  for (let i = first; i < end; i++) {
    if (box?.skip.has(i) === true) continue;
    rows.set(i, texts[i]!.replace(BORDERS, " ").trimEnd());
  }
  return rows;
}

/**
 * How the sign reads a window with no box. `anchor` set: a sign counts only where it stands live at the
 * bottom (see {@link anchored}), the reading for a pane whose foreground is a program or not known. A
 * found box is read as it is, whatever this says.
 */
export interface MenuSignOptions {
  readonly anchor?: number;
}

/**
 * The menu sign on a screen, or null. `texts` are the screen's plain rows; `box` the input box the
 * reader found, or null.
 */
export function menuSign(texts: readonly string[], box: MenuBox | null = null, options: MenuSignOptions = {}): MenuSign | null {
  const rows = menuWindow(texts, box);
  const anchor = box === null ? options.anchor : undefined;
  for (const found of candidates(rows)) {
    if (anchor === undefined || anchored(rows, found, anchor)) return { kind: found.kind, row: found.row };
  }
  return null;
}

/** A sign found on the window: its kind, the row it names, and the lowest row of its parts. */
interface Candidate extends MenuSign {
  readonly last: number;
}

/** A sign of one row. */
function one(kind: MenuSignKind, row: number): Candidate {
  return { kind, row, last: row };
}

/** Every sign on the window, in the order the plain reading takes the first of. */
function* candidates(rows: ReadonlyMap<number, string>): Generator<Candidate> {
  const order = [...rows.keys()];
  const width = Math.max(0, ...[...rows.values()].map((text) => text.length));
  const numbered: { i: number; n: number }[] = [];
  const choices: number[] = [];
  const commands = new Map<number, number[]>();
  const hintRows: number[] = [];
  let hints = 0;
  for (const i of order) {
    const text = rows.get(i)!;
    if (isBlank(text)) continue;
    if (YES_NO_FORM.test(text)) yield one("yes-no", i);
    if (MENU_HINT.test(text)) yield one("hint", i);
    if (isSingleKeyRow(text)) yield one("single-key", i);
    if (POSITION.test(text)) yield one("position", i);
    if (DISMISS_HEADER.test(text) && /\p{L}{2}/u.test(text.replace(/(?:esc|escape)\s*$/iu, ""))) yield one("dismiss", i);
    if (SEARCH.test(text)) yield one("search", i);
    const found = text.match(ANY_HINTS)?.length ?? 0;
    if (found > 0) hintRows.push(i);
    hints += found;
    const items = text.trim().split(ITEMS).filter((item) => item.length > 0);
    if (items.length >= 2 && items.every((item) => CHOICE.test(item))) yield one("choices", i);
    const command = COMMAND_ENTRY.exec(text);
    if (command !== null) commands.set(command[1]!.length, [...(commands.get(command[1]!.length) ?? []), i]);
    if (COMMAND_QUERY.test(text) && choiceNear(rows, i)) yield one("commands", i);
    const pointer = POINTER_ROW.exec(text);
    const body = pointer === null ? text : pointer[4]!;
    if (pointer !== null) {
      if (numberOf(body) !== null || isChoice(body)) yield one("pointer", i);
      const list = pointedList(rows, i, pointer, width);
      if (list !== null) yield { kind: "pointed-list", row: i, last: Math.max(...list) };
    }
    const n = numberOf(body);
    if (n !== null) numbered.push({ i, n });
    if (isChoice(body)) choices.push(i);
  }
  if (hints >= 2) yield { kind: "hint", row: hintRows[0]!, last: hintRows.at(-1)! };
  for (const a of numbered) {
    let at = a;
    for (let next = nextIn(numbered, at); next !== undefined; next = nextIn(numbered, at)) at = next;
    if (at !== a) yield { kind: "numbered", row: a.i, last: at.i };
  }
  if (choices.length >= 2) yield { kind: "choices", row: choices[0]!, last: choices.at(-1)! };
  for (const at of commands.values()) if (at.length >= 3) yield { kind: "commands", row: at[0]!, last: at.at(-1)! };
}

/** The item that follows `a` in a numbered run: the next number, below it and at most four rows down. */
function nextIn(numbered: readonly { i: number; n: number }[], a: { i: number; n: number }): { i: number; n: number } | undefined {
  return numbered.find((b) => b.n === a.n + 1 && b.i > a.i && b.i - a.i <= 4);
}

/**
 * Whether a sign stands live at the bottom of the window (M102 spec 12, the blind road on a program or
 * an unknown foreground). A yes/no form counts on the last or the second-last row that is not blank; any
 * other sign when at most `k` rows that are not blank and not a part of a menu (an option, a hint, a
 * rule, a row of a panel between two rules, a wrapped hint's next two rows) stand below its lowest part. Old output above a prompt is no menu: the prompt stands under it.
 */
function anchored(rows: ReadonlyMap<number, string>, sign: Candidate, k: number): boolean {
  if (sign.kind === "yes-no") return [...rows.entries()].filter(([i, text]) => i > sign.last && !isBlank(text)).length <= 1;
  // The menu ends at its lowest part or at the lowest row that names a key for a menu verb under it.
  const tail = Math.max(sign.last, ...[...rows.entries()].filter(([i, text]) => i > sign.row && MENU_HINT.test(text)).map(([i]) => i));
  const below = [...rows.entries()].filter(([i, text]) => i > tail && !isBlank(text));
  const bottom = below.at(-1);
  if (bottom !== undefined && PROMPT_END.test(bottom[1])) return false;
  // A block between two rules under the menu is the program's own panel (a preview, a status): no old output.
  const rules = below.filter(([, text]) => isRule(text)).map(([i]) => i);
  const panel = (i: number): boolean => rules.length >= 2 && i > rules[0]! && i < rules.at(-1)!;
  // A hint row a narrow pane wrapped goes on in the next two rows.
  const wrapped = (i: number): boolean => [1, 2].some((up) => MENU_HINT.test(rows.get(i - up) ?? "") && [...Array(up).keys()].every((j) => !isBlank(rows.get(i - j) ?? "")));
  return below.filter(([i, text]) => !isMenuPart(text) && !panel(i) && !wrapped(i)).length <= k;
}

/** Whether a row is a part of a menu: an option, a hint, a key row, a position or a rule. */
function isMenuPart(text: string): boolean {
  const body = POINTER_ROW.exec(text)?.[4] ?? text;
  return (
    POINTER_ROW.test(text) ||
    numberOf(body) !== null ||
    CHECKBOX_LEAD.test(text) ||
    BULLET_LEAD.test(text) ||
    isChoice(body) ||
    MENU_HINT.test(text) ||
    ANY_HINT.test(text) ||
    isSingleKeyRow(text) ||
    POSITION.test(text) ||
    isRule(text) ||
    COMMAND_ENTRY.test(text)
  );
}

/**
 * The rows of the pointed list a pointer row heads, or null when it heads none: two rows or more next to it start where its option text
 * starts (a tick or a radio after the pointer passed over), or one such row with a rule over and under
 * the list; under a radio list each sibling may carry its own radio. A long prompt echoed behind the same glyph wraps into rows that line up the same way: a
 * pointer row that fills the window's width, in a list with no wide gap inside any row (a menu's
 * description column has one), is a wrapped paragraph. A row that continues a tree (`⎿`) is no option.
 */
function pointedList(rows: ReadonlyMap<number, string>, at: number, pointer: RegExpExecArray, width: number): number[] | null {
  const mark = MARK_LEAD.exec(pointer[4]!);
  const col = pointer[1]!.length + pointer[2]!.length + pointer[3]!.length + (mark === null ? 0 : mark[0].length);
  const list = [at];
  for (const dir of [-1, 1]) {
    for (let j = at + dir; rows.has(j); j += dir) {
      const other = rows.get(j)!;
      if (isBlank(other) || TREE_LEAD.test(other)) break;
      // A sibling starts where the option text starts, or, under a radio list, with its own radio where the pointer row's radio stands.
      const start = other.search(/\S/u);
      const radio = mark !== null && start === col - mark[0].length && MARK_LEAD.test(other.slice(start));
      if (start !== col && !radio) break;
      list.push(j);
    }
  }
  const siblings = list.length - 1;
  if (siblings === 0) return null;
  const paragraph = rows.get(at)!.length >= width - 4 && width >= 40 && list.every((j) => !/\S\s{2,}\S/u.test(rows.get(j)!.trim()));
  if (paragraph) return null;
  if (siblings >= 2) return list;
  const top = Math.min(...list);
  const bottom = Math.max(...list);
  return isRule(rows.get(top - 1)) && isRule(rows.get(bottom + 1)) ? list : null;
}

/** Whether a row is a horizontal rule of eight glyphs or more, maybe with one short label inside (`────2─`). */
function isRule(text: string | undefined): boolean {
  if (text === undefined) return false;
  const bare = text.replace(/[╮╯┐┘┤╭╰┌└├]/gu, "");
  return /^\s*[─━═╌┄┈]{2,}(?:\s*[^\s─━═╌┄┈]{1,3}\s*[─━═╌┄┈]+)?\s*$/u.test(bare) && (bare.match(/[─━═╌┄┈]/gu)?.length ?? 0) >= 8;
}

/** Whether a command entry or a pointer row stands within two rows of `at`, up or down. */
function choiceNear(rows: ReadonlyMap<number, string>, at: number): boolean {
  for (const j of [at - 2, at - 1, at + 1, at + 2]) {
    const text = rows.get(j);
    if (text !== undefined && !isBlank(text) && (POINTER_ROW.test(text) || COMMAND_ENTRY.test(text))) return true;
  }
  return false;
}
