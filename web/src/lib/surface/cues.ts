// Generic modal cues (M56 spec 04, experiments/reader-stability/ARCHITECTURE.md section 4). A cue is
// a shape a dialog draws that an input box does not: a pointer glyph on a listed row, a numbered
// option list, a key-hint footer, a single-key prompt. The cues carry no harness name and no harness
// constant; the CI test in no-harness-names.test.ts holds this file to that.
//
// Cues anchor to the bottom cluster, never to the whole screen, so a dialog quoted in the transcript
// stays free:
//  - With an input frame found, the transcript is everything above the frame's top edge. Only the
//    nearest run of rows above the top edge, inside the profile's volatile band, is read, and there
//    only a strong shape counts: a harness that draws a dialog over its own live box (a rating
//    survey, a question) draws a strong one, and a weak shape flush on the box is a quote. Under the
//    bottom edge, the rows are read only when they do not walk as the profile's status and footer
//    rows (a popup or a dialog sits there); the volatile rows themselves are a statusline the operator
//    writes, so they are never read for a modal cue. Nor is a row the profile names as a footer row
//    (`frame.volatile.named`): the frame found it from the profile's list, and this file only skips it.
//  - With no frame, the cluster is the last run of rows on the screen: up to CLUSTER_MAX_ROWS
//    non-blank rows from the last non-blank one up, ended by CLUSTER_GAP_ROWS blank rows in a row.
//    A footer of at most FOOTER_MAX_ROWS rows at the very bottom, set apart by a gap, does not end
//    it: an overlay drawn mid-screen over a status line sits above that gap. The cluster never cuts
//    a list: when the cap falls inside an aligned list, the cluster grows up to the list's first row.
//
// Strength: one cue alone is weak (the fold says `unknown`). A pointer on a listed row together with
// a numbered list, a key-hint footer together with any listed row, or a single-key prompt is strong
// (the fold says `unreadable` when no reader lifted the dialog).
//
// Overlay shapes count in the no-frame cluster only, and each is strong on its own: a title row that
// names only its close key ("Select agent      esc"), a list of three slash commands or more, a
// slash query with a choice under it, and a pointer list between two rules. A pointed list there
// also reads wrapped rows (indented deeper than the items) as part of the item above. A read with no
// frame is never free, so one of these shapes in a transcript costs a counter, never a send; over a
// found frame the stricter rules above keep a quote free.
//
// A profile that draws its dialogs in the box's place has its box rows read as that cluster too. There
// a prompt glyph over a draft soft-wrapped to the box's width ({@link draftWrap}) is read as blank: the
// wrapped rows under it line up like a pointed list between two rules, and they are one paragraph.
// The same rows with a row cut by an ellipsis read as neither: no cue, flagged `cutWrap`, unreadable.
// A layout that names `frame.draftLines` reads a draft typed with newlines the same way, when its rows
// hold no option, key hint or named command list: its dialogs never point with the prompt glyph.
//
// Pure: the same rows always give the same answer.

import { displayWidth } from "../text-width";
import { commandListNear, openedByText, pointsAt, type CommandListRead } from "./command-list";
import { popupUnder, type PopupRead } from "./popup";
import { promptDraft, rowText, type Frame, type FrameRow, type IdleProfile } from "./frame";
import { isSingleKeyRow } from "./key-row";
import { readAboveNotice, type AboveNotice } from "./notice";
import type { CommandListRows } from "./profile";
import { shortHash } from "./surface";

export type { CommandListRead } from "./command-list";

export type CueKind =
  | "pointer-row"
  | "numbered-list"
  | "checkbox-list"
  | "key-hint"
  | "single-key"
  | "dismiss-header"
  | "command-list"
  | "command-query";

export interface Cue {
  readonly kind: CueKind;
  /** The screen row the cue was found on (the first item of a list). */
  readonly row: number;
}

export type CueStrength = "none" | "weak" | "strong";

export interface CueRead {
  /** The rows read for every cue. */
  readonly cluster: readonly number[];
  /** The rows above a found frame, read for the single-key prompt only. */
  readonly above: readonly number[];
  readonly cues: readonly Cue[];
  readonly strength: CueStrength;
  /** A short hash of the bottom cluster's text (the generic one, frame or not), for log lines. */
  readonly hash: string;
  /** A panel's dismiss hint stands alone over the found box ({@link PANEL_FOOT}): the panel takes the keys, not the box. */
  readonly panelFoot?: true;
  /**
   * The box's rows would read as a soft-wrapped draft, but a row ends in an ellipsis ({@link draftWrap}
   * `cut`): a draft and a menu cut to the box's width look the same there. The screen is unreadable for
   * this read: no dialog, no draft, nothing free (fold.ts `surfaceOfScreen`).
   */
  readonly cutWrap?: true;
}

/** The most non-blank rows the no-frame cluster reads (a list it would cut is read whole). */
export const CLUSTER_MAX_ROWS = 24;
/** Blank rows in a row that end the no-frame cluster. */
export const CLUSTER_GAP_ROWS = 3;
/** The tallest bottom run the no-frame cluster reads as a footer and passes over. */
export const FOOTER_MAX_ROWS = 2;
/** Commands in a list that make it an overlay shape. */
const COMMAND_LIST_MIN = 3;
/** Cells a soft-wrapped row may stop short of the box's width before its next word would have fit. */
const WRAP_SLACK = 8;

/** Glyphs a dialog draws in front of the highlighted row. */
const POINTERS = "❯›>▶►→➜❱▸➤⟩❭〉";
/** Border glyphs a dialog draws at the left and right of its rows; read as blank columns. */
const BORDERS = /[│┃║▌▐]/gu;
/** Every box glyph, for the slash query: a prompt row is often a box's own edge ("╰─ /"). */
const BOX_GLYPHS = /[│┃║▌▐╭╮╰╯┌┐└┘├┤┬┴┼─━═╹▀▔▁]/gu;
/** A horizontal rule: plain line glyphs, maybe one short label inside ("────2─"), no corners. */
const RULE = /^\s*[─━═╌┄┈]{2,}(?:\s*[^\s─━═╌┄┈]{1,3}\s*[─━═╌┄┈]+)?\s*$/u;
const RULE_MIN_GLYPHS = 8;
/** A title row that names only its close key, at its right end after a wide gap. */
const DISMISS_HEADER = /^\s*(\S(?:.*\S)?)\s{3,}(?:esc|escape)\s*$/iu;
/**
 * A row that is nothing but the dismiss hint of an open panel ("Esc to cancel"). Alone in the run over a
 * live box it is the foot of a panel drawn above the box, which takes the keys (Claude Code 2.1.301's
 * /cost and /usage panel during a turn, fixtures claude--v2301-usage-panel-over-box--w82 and --w40): strong.
 */
const PANEL_FOOT = /^\s*(?:esc|escape)\s+to\s+(?:cancel|close|exit|dismiss|go back)\s*$/iu;
/** A slash command with its description in a second column ("/agents     Switch agent"). */
const COMMAND_ENTRY = new RegExp(`^(\\s*)(?:[${POINTERS}]\\s*)?/[\\w:.-]+\\s{2,}\\S`, "u");
/** A prompt that holds only a slash query: "/", "/res", "❯ /usage". */
const COMMAND_QUERY = new RegExp(`^\\s*(?:[${POINTERS}]\\s*)?/[\\w:.-]*\\s*$`, "u");

const POINTER_ROW = new RegExp(`^(\\s*)([${POINTERS}])(\\s*)(\\S)`, "u");
const NUMBERED_ITEM = new RegExp(
  `^\\s*(?:[${POINTERS}]\\s*)?(?:(\\d{1,2})[.)]\\s+\\S|(\\d{1,2})\\s+[([][^)\\]]{0,2}[)\\]]\\s+\\S|\\[(\\d{1,2})\\]\\s+\\S|(\\d{1,2})\\s{2,}\\S)`,
  "u",
);
const CHECKBOX_ITEM = new RegExp(
  `^\\s*(?:[${POINTERS}]\\s*)?(?:\\d{1,2}[.)]?\\s+)?(?:\\[[ xX✓✔•*-]?\\]|\\([ ○●◉xX✓✔•*-]?\\)|[☐☑☒◯○◉◻◼])\\s+\\S`,
  "u",
);

/** One key as a footer names it. A private-use glyph is an icon font's key cap (Enter, Escape). */
const KEY_ATOM =
  "(?:enter|return|esc|escape|tab|space|spacebar|backspace|shift\\+tab|shift\\+[a-z]|ctrl\\+[a-z.]|alt\\+[a-z]|⌃[a-z]|up|down|left|right|[↑↓←→⇆⇅⏎↵⎋⇥]+|[\\u{E000}-\\u{F8FF}\\u{F0000}-\\u{FFFFD}](?:\\s?[a-z](?![a-z]))?|arrow keys|arrows)";
/** A key, or several joined by slashes ("↑/↓", "Tab/←→", "Escape/Ctrl+C"). */
const KEY = `${KEY_ATOM}(?:\\s*/\\s*${KEY_ATOM})*`;
/** What a dialog's footer says a key does. A composer's footer says send, newline, mode or cycle. */
const VERB =
  "(?:confirm|select|cancel|submit|continue|choose|proceed|approve|deny|reject|accept|go back|back|exit|close|dismiss|navigate|toggle|answer|adjust|amend|move|pick|view|stop|quit|filter|search|scroll|switch|apply|save|skip|next|previous|prev|open|allow|decline|change|clear|reset|focus|use)";
const KEY_HINT_SOURCE = `(?:^|[^\\w+])(?:press\\s+)?${KEY}\\s*(?:to\\s+|:\\s*|=\\s*|\\s+)${VERB}s?\\b`;
const KEY_HINT = new RegExp(KEY_HINT_SOURCE, "iu");
const KEY_HINTS = new RegExp(KEY_HINT_SOURCE, "giu");

/** Running signs: an interrupt hint, or a spinner row whose ellipsis is followed by a bracketed timer,
 *  with at most one ` · <words>` segment between them (`Flowing… · tool use (5m 41s …)`). The fold reads
 *  them in a frame's volatile rows ({@link runningSign}); the bridge also scans whole screens with them. */
const INTERRUPT_HINT = /(?:^|[·(•|│,]\s*)(?:esc|escape|ctrl\+c|⌃c)\s+to\s+interrupt\s*(?:$|[·)•|│,])/iu;
const SPINNER_ROW = /^\s*\S{1,2}\s+\S[^(]*?(?:…|\.\.\.)(?:\s+·\s+\p{L}[\p{L} -]{0,30})?\s*\(\s*(?:\d+\s*[hms]\s*)+/u;

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** The row with border glyphs read as spaces, so columns hold and a boxed row reads like a bare one. */
function unboxed(text: string): string {
  return text.replace(BORDERS, " ");
}

function numberOf(text: string): number | null {
  const m = NUMBERED_ITEM.exec(text);
  if (m === null) return null;
  return Number(m[1] ?? m[2] ?? m[3] ?? m[4]);
}

/** Whether a row holds a key-hint phrase such as "Enter to select" or "Esc:cancel". */
export function isKeyHintRow(text: string): boolean {
  return KEY_HINT.test(text);
}

/** Whether a row is a running sign: an interrupt hint or a spinner with an elapsed time. */
export function isRunningRow(text: string): boolean {
  return INTERRUPT_HINT.test(text) || SPINNER_ROW.test(text);
}

/** The column a row's text starts in, with border glyphs read as blank, or -1 on a blank row. */
function startCol(text: string): number {
  return unboxed(text).search(/\S/u);
}

/** Whether a row is a horizontal rule (see RULE). */
function isRule(text: string): boolean {
  const t = unboxed(text);
  return RULE.test(t) && (t.match(/[─━═╌┄┈]/gu)?.length ?? 0) >= RULE_MIN_GLYPHS;
}

/** The generic bottom cluster: the last run of rows on the screen (see the header for the rules). */
function tailCluster(texts: readonly string[]): number[] {
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  const rows: number[] = [];
  let gap = 0;
  let footerPassed = false;
  let crossing = false;
  let i = end;
  for (; i >= 0 && rows.length < CLUSTER_MAX_ROWS; i--) {
    if (isBlank(texts[i]!)) {
      if (crossing) continue;
      gap++;
      if (gap < CLUSTER_GAP_ROWS) continue;
      // A short run at the very bottom set apart by a gap is a footer: pass over the gap once.
      if (!footerPassed && rows.length <= FOOTER_MAX_ROWS) {
        footerPassed = true;
        crossing = true;
        continue;
      }
      break;
    }
    gap = 0;
    crossing = false;
    rows.push(i);
  }
  // The cap fell inside a list: read the list whole, up to its first row (a pointer row included).
  if (rows.length === 0) return rows;
  const top = rows.at(-1)!;
  const col = startCol(texts[top]!);
  if (rows.length >= CLUSTER_MAX_ROWS && col >= 1) {
    for (let j = top - 1, n = 0; j >= 0 && n < CLUSTER_MAX_ROWS; j--, n++) {
      if (isBlank(texts[j]!)) break;
      if (startCol(texts[j]!) === col) {
        rows.push(j);
        continue;
      }
      const pointer = POINTER_ROW.exec(unboxed(texts[j]!));
      if (pointer !== null && pointer[1]!.length + pointer[2]!.length + pointer[3]!.length === col) rows.push(j);
      break;
    }
  }
  return rows.toReversed();
}

/** The nearest run of non-blank rows above a frame's top edge, inside the volatile band. A notice the
 *  profile names is blank by now ({@link readCues}), so the run is the one above it. */
function aboveRun(texts: readonly string[], frame: Frame): number[] {
  const band = frame.volatile.above;
  if (band === null) return [];
  let i = frame.top - 1;
  while (i >= band.first && isBlank(texts[i]!)) i--;
  const rows: number[] = [];
  while (i >= band.first && !isBlank(texts[i]!)) rows.push(i--);
  return rows.toReversed();
}

/** The rows under a frame's bottom edge when they do not walk as status and footer rows. A row the
 *  profile names as a footer row (`frame.volatile.named`) is never one of them. */
function belowRows(texts: readonly string[], frame: Frame): number[] {
  if (frame.volatile.status !== null || frame.volatile.footer !== null) return [];
  const named = new Set(frame.volatile.named.map((hit) => hit.row));
  const rows: number[] = [];
  for (let i = frame.bottom + 1; i < texts.length; i++) if (!isBlank(texts[i]!) && !named.has(i)) rows.push(i);
  return rows;
}

/** Which rows of a found frame are volatile: the band above, the status and footer runs, and any
 *  rows under the bottom edge. The fold reads running signs here and nowhere else; the bridge's
 *  whole-screen scans read them too. */
export function volatileRows(texts: readonly string[], frame: Frame): number[] {
  const rows: number[] = [];
  const { above } = frame.volatile;
  if (above !== null) for (let i = above.first; i <= above.last; i++) rows.push(i);
  for (let i = frame.bottom + 1; i < texts.length; i++) rows.push(i);
  return rows.filter((i) => !isBlank(texts[i]!));
}

const compiledSigns = new WeakMap<readonly string[], readonly RegExp[]>();

function signPatterns(sources: readonly string[]): readonly RegExp[] {
  const known = compiledSigns.get(sources);
  if (known !== undefined) return known;
  const compiled = sources.map((source) => new RegExp(source, "u"));
  compiledSigns.set(sources, compiled);
  return compiled;
}

/**
 * Whether a found frame's volatile rows show a running sign. `profileSigns` are the profile's own
 * running rows (`idle.runningRows`): patterns read on the volatile rows, the bottom edge, the top
 * edge and the prompt row included, for a harness that marks a turn there (a spinner frame on its
 * status row, a hint only a turn shows, a label in the top rule, a prompt glyph only a turn draws).
 */
export function runningSign(rows: readonly FrameRow[], frame: Frame, profileSigns: readonly string[] = []): boolean {
  const texts = rows.map(rowText);
  if (volatileRows(texts, frame).some((i) => isRunningRow(texts[i]!))) return true;
  if (profileSigns.length === 0) return false;
  const patterns = signPatterns(profileSigns);
  return [...volatileRows(texts, frame), frame.bottom, frame.top, frame.interior.prompt].some((i) => {
    const text = texts[i]!.trimEnd();
    return text.length > 0 && patterns.some((pattern) => pattern.test(text));
  });
}

interface ClusterCues {
  readonly cues: Cue[];
  /** A numbered item, a checkbox item or a pointer row with an aligned sibling is in the cluster. */
  readonly listed: boolean;
  /** The pointer row is listed. */
  readonly pointerListed: boolean;
  /** The pointer row has two or more aligned siblings: a pointed list of three rows or more. */
  readonly pointedList: boolean;
  /** How many key-hint phrases the cluster holds, over all its rows. */
  readonly keyHints: number;
  /** An overlay shape (no-frame cluster only, see the header): strong on its own. */
  readonly overlay: boolean;
}

interface Siblings {
  /** Rows in the list's column next to the pointer row. */
  readonly count: number;
  /** The list's first and last row, wrapped rows included. */
  readonly first: number;
  readonly last: number;
}

/**
 * The rows next to `row`, upward and downward without a gap, that start in column `col`. With
 * `wrapped`, a row indented deeper than `col` is a wrapped line of the item above and does not end
 * the walk.
 */
function alignedSiblings(texts: readonly string[], inCluster: ReadonlySet<number>, row: number, col: number, wrapped: boolean): Siblings {
  let count = 0;
  let first = row;
  let last = row;
  for (const dir of [-1, 1]) {
    for (let j = row + dir; inCluster.has(j); j += dir) {
      const other = unboxed(texts[j]!);
      if (isBlank(other)) break;
      const at = other.search(/\S/u);
      if (at === col) count++;
      else if (!(wrapped && at > col)) break;
      if (dir < 0) first = j;
      else last = j;
    }
  }
  return { count, first, last };
}

/** Whether a row holds only a slash query, box glyphs read as blank ("╰─ /", "❯ /usage"). */
function isCommandQuery(text: string): boolean {
  return COMMAND_QUERY.test(text.replace(BOX_GLYPHS, " "));
}

/** Whether the first row under a slash query, rules passed over, is a choice: a pointer row or a
 *  slash command with its description. */
function choiceUnder(texts: readonly string[], inCluster: ReadonlySet<number>, row: number): boolean {
  for (let j = row + 1; inCluster.has(j) && j <= row + 2; j++) {
    const text = unboxed(texts[j]!);
    if (isRule(text)) continue;
    return POINTER_ROW.test(text) || COMMAND_ENTRY.test(text);
  }
  return false;
}

/**
 * The cues in a run of rows. `readOverlay` reads the overlay shapes of the header too; only the no-frame
 * cluster passes it.
 */
function cuesIn(texts: readonly string[], cluster: readonly number[], readOverlay = false): ClusterCues {
  const cues: Cue[] = [];
  const inCluster = new Set(cluster);
  const numbered: { row: number; n: number }[] = [];
  const checkboxes: number[] = [];
  let pointerListed = false;
  let pointedList = false;
  let pointerRow = -1;
  let keyHintRow = -1;
  let keyHints = 0;
  let singleKeyRow = -1;
  let dismissRow = -1;
  let commandQueryRow = -1;
  let ruledList = false;
  const commandCols = new Map<number, number[]>();

  for (const i of cluster) {
    const text = unboxed(texts[i]!);
    const n = numberOf(text);
    if (n !== null) numbered.push({ row: i, n });
    const checkbox = CHECKBOX_ITEM.test(text);
    if (checkbox) checkboxes.push(i);
    const pointer = POINTER_ROW.exec(text);
    if (pointer !== null && !pointerListed) {
      const textCol = pointer[1]!.length + pointer[2]!.length + pointer[3]!.length;
      const siblings = alignedSiblings(texts, inCluster, i, textCol, readOverlay);
      if (n !== null || checkbox || siblings.count > 0) {
        pointerListed = true;
        pointedList = siblings.count >= 2;
        pointerRow = i;
        ruledList =
          readOverlay &&
          inCluster.has(siblings.first - 1) &&
          inCluster.has(siblings.last + 1) &&
          isRule(texts[siblings.first - 1]!) &&
          isRule(texts[siblings.last + 1]!);
      }
    }
    if (readOverlay) {
      const header = DISMISS_HEADER.exec(text);
      if (dismissRow < 0 && header !== null && /\p{L}/u.test(header[1]!)) dismissRow = i;
      const command = COMMAND_ENTRY.exec(text);
      if (command !== null) commandCols.set(command[1]!.length, [...(commandCols.get(command[1]!.length) ?? []), i]);
      if (commandQueryRow < 0 && isCommandQuery(texts[i]!) && choiceUnder(texts, inCluster, i)) commandQueryRow = i;
    }
    const hints = text.match(KEY_HINTS)?.length ?? 0;
    if (hints > 0 && keyHintRow < 0) keyHintRow = i;
    keyHints += hints;
    if (singleKeyRow < 0 && isSingleKeyRow(text)) singleKeyRow = i;
  }

  if (pointerListed) cues.push({ kind: "pointer-row", row: pointerRow });
  const consecutive = numbered.some((a) => numbered.some((b) => b.n === a.n + 1));
  if (numbered.length >= 2 && consecutive) cues.push({ kind: "numbered-list", row: numbered[0]!.row });
  if (checkboxes.length >= 2) cues.push({ kind: "checkbox-list", row: checkboxes[0]! });
  if (keyHintRow >= 0) cues.push({ kind: "key-hint", row: keyHintRow });
  if (singleKeyRow >= 0) cues.push({ kind: "single-key", row: singleKeyRow });
  if (dismissRow >= 0) cues.push({ kind: "dismiss-header", row: dismissRow });
  const commandList = [...commandCols.values()].find((rows) => rows.length >= COMMAND_LIST_MIN);
  if (commandList !== undefined) cues.push({ kind: "command-list", row: commandList[0]! });
  if (commandQueryRow >= 0) cues.push({ kind: "command-query", row: commandQueryRow });
  const listed = numbered.length > 0 || checkboxes.length > 0 || pointerListed;
  const overlay = dismissRow >= 0 || commandList !== undefined || commandQueryRow >= 0 || ruledList;
  return { cues, listed, pointerListed, pointedList, keyHints, overlay };
}

/**
 * The profile's completion list for a slash command (`idle.volatile.below.commandList`) at a frame, on
 * the sides the profile names ({@link commandListNear}). Null when the profile names no list or neither
 * side holds one.
 */
export function commandListAt(texts: readonly string[], frame: Frame, list: CommandListRows | undefined, rows?: readonly FrameRow[]): CommandListRead | null {
  return commandListNear(texts, frame.top, frame.bottom, list, rows, frame.interior.prompt, frame.interior.text);
}

/**
 * The profile's command list at a frame whatever the box's text is: {@link commandListAt} without the profile's
 * `notForText`, which keeps a path's popup rows out of the Surface's and the cues' reads. The Send Protocol asks
 * this one before Enter, so a list drawn under such a text is never pressed over unseen.
 */
export function commandListAnyText(texts: readonly string[], frame: Frame, list: CommandListRows | undefined, rows?: readonly FrameRow[]): CommandListRead | null {
  return commandListNear(texts, frame.top, frame.bottom, list, rows, frame.interior.prompt);
}

/**
 * The typeahead of the command the box holds, or null: the profile's command list on either side of
 * a found frame, its pointer on an entry whose command is the box's text ({@link pointsAt}: `/model` is
 * pointed at by `❯ /model`, never by `❯ /models`). Enter there picks the command that is already typed,
 * so the list is no dialog and its rows are read for no cue. So is a list the text opened on a profile
 * that names `leadOpens` ({@link openedByText}), whatever it points at: the harness's fuzzy list for a
 * half-typed command. Any other list that points at another command, or at none, is read as before.
 */
export function ownCommandList(texts: readonly string[], frame: Frame | null, idle: IdleProfile | null, styled?: readonly FrameRow[]): CommandListRead | null {
  if (frame === null || idle === null || frame.placeholder) return null;
  const rows = idle.volatile.below.commandList;
  const list = commandListAt(texts, frame, rows, styled);
  return list !== null && (pointsAt(list, frame.interior.text, rows) || openedByText(list, frame.interior.text, rows)) ? list : null;
}

/** The rows with the rows `first` to `last` read as blank. */
function withoutSpan(rows: readonly FrameRow[], span: { readonly first: number; readonly last: number } | null): readonly FrameRow[] {
  if (span === null) return rows;
  return rows.map((row, i) => (i >= span.first && i <= span.last ? { segments: [] } : row));
}

/** Whether a row is an option row: a numbered item or a checkbox item, a pointer glyph in front allowed. */
function isOptionRow(text: string): boolean {
  const row = unboxed(text);
  return numberOf(row) !== null || CHECKBOX_ITEM.test(row);
}

/**
 * The rows with the transcript's echoes of sent prompts above a found frame read as blank, for a profile
 * whose transcript echoes each prompt in its prompt row's shape (`idle.promptEchoes`). An echo is a row
 * the prompt anchor matches with text behind the glyph ({@link promptDraft}), then the rows under it
 * indented at least `frame.continuationIndent` columns, ended by a blank row or the frame's top edge.
 * A long prompt wraps into rows that line up like a pointed list under the glyph, and the whole-screen
 * read took them for one (Claude Code 2.1.309 and 2.1.310, live 2026-10-25). A run whose first row is an
 * option row ({@link isOptionRow}, `❯ 1. Yes`, `❯ [ ] Cheese`) is left as it is: a list puts its pointer
 * on an option, whoever drew it. Option rows under the first row do not count: a sent text's own list
 * (`❯ Please do these:` over `  1. reply D`) stands there, and before 2026-10-26 such a queued message read
 * as an unreadable modal at S2. Every other row, and every row of any other profile, stays as it is. Both the bridge's frameless read and the
 * framed read ({@link readCuesFor}) take it: Claude Code's queued message over the box has the same
 * shape, `❯ ` and its text with its wrapped rows and the `ctrl+enter to send now` hint under it.
 */
export function withoutPromptEchoes(rows: readonly FrameRow[], frame: Frame | null, idle: IdleProfile | null): readonly FrameRow[] {
  if (frame === null || idle?.promptEchoes !== true) return rows;
  const texts = rows.map(rowText);
  const echoes: { first: number; last: number }[] = [];
  for (let i = 0; i < frame.top; i++) {
    const draft = promptDraft(texts[i]!, idle);
    if (draft === null || draft.length === 0) continue;
    let last = i;
    while (last + 1 < frame.top && !isBlank(texts[last + 1]!) && startCol(texts[last + 1]!) >= idle.frame.continuationIndent) last++;
    const ended = last + 1 === frame.top || isBlank(texts[last + 1]!);
    // Only the pointer row decides: a list puts its pointer on an option (`❯ 1. Yes`), while a text's
    // own numbered or checkbox lines stand under its first line.
    if (ended && !isOptionRow(texts[i]!)) echoes.push({ first: i, last });
    i = last;
  }
  if (echoes.length === 0) return rows;
  return rows.map((row, i) => (echoes.some((echo) => i >= echo.first && i <= echo.last) ? { segments: [] } : row));
}

/**
 * The typeahead popup under a found frame that the box's text opened (`idle.volatile.below.popups`,
 * {@link popupUnder}), or null: with no frame, or on a profile that names none. A box showing its
 * placeholder holds no text.
 */
export function popupAt(texts: readonly string[], frame: Frame | null, idle: IdleProfile | null): PopupRead | null {
  if (frame === null || idle === null) return null;
  return popupUnder(texts, frame.bottom, frame.placeholder ? "" : frame.interior.text, idle.volatile.below.popups);
}

/** The rows with a typeahead popup's rows read as blank. */
export function withoutPopup(rows: readonly FrameRow[], popup: PopupRead | null): readonly FrameRow[] {
  return withoutSpan(rows, popup);
}

/** The rows with a command list's rows read as blank. */
export function withoutCommandList(rows: readonly FrameRow[], list: CommandListRead | null): readonly FrameRow[] {
  return withoutSpan(rows, list);
}

/**
 * The rows with the box's own prompt glyph read as blank ({@link Frame.ownPrompt}): the prompt row's
 * text in front of the draft hole turns into spaces, so the columns hold. Every other row, and the
 * rows of a frame whose layout names no own glyph, stay as they are.
 */
function withoutOwnPrompt(rows: readonly FrameRow[], frame: Frame): readonly FrameRow[] {
  const mark = frame.ownPrompt;
  if (mark === undefined) return rows;
  return rows.map((row, i) => {
    if (i !== mark.row) return row;
    const text = rowText(row);
    return { segments: [{ text: " ".repeat(Math.min(mark.end, text.length)) + text.slice(mark.end) }] };
  });
}

/**
 * The notice the profile names over a found frame's top edge (`idle.notices`, {@link readAboveNotice}),
 * or null. Every cue read takes it ({@link readCues}) and leaves its rows out: the box keeps its keys.
 */
export function noticeOver(texts: readonly string[], frame: Frame | null, idle: IdleProfile | null): AboveNotice | null {
  if (frame === null || idle === null) return null;
  return readAboveNotice(texts, frame.top, idle.notices ?? [], idle.noticeGaps ?? []);
}

/**
 * The cues of a screen read under a profile: the frame's own cues, or, when the profile draws its
 * dialogs where the box stands (`idle.dialogsInBox`), the cues of the rows from the box's top edge down,
 * the box rows included. The typed command's own list on either side of the box ({@link ownCommandList})
 * and a notice over the box ({@link noticeOver}) are left out of both, and so are the prompt-shaped runs
 * over the box of a profile whose transcript echoes prompts ({@link withoutPromptEchoes}): Claude Code
 * draws a queued message there in that shape, and its wrapped rows and send-now hint under the `❯ ` row
 * are no pointed list. The second also reads the box's
 * own prompt glyph ({@link withoutOwnPrompt}) as blank, and the prompt glyph over a soft-wrapped draft
 * ({@link draftWrap}); a draft-shaped box cut by an ellipsis reads as no cue at all, flagged `cutWrap`.
 */
export function readCuesFor(allRows: readonly FrameRow[], frame: Frame | null, idle: IdleProfile | null): CueRead {
  const texts = allRows.map(rowText);
  const rows = withoutPromptEchoes(withoutPopup(withoutCommandList(allRows, frame === null ? null : ownCommandList(texts, frame, idle, allRows)), popupAt(texts, frame, idle)), frame, idle);
  const plain = readCues(rows, frame, noticeOver(texts, frame, idle));
  if (idle?.dialogsInBox !== true || frame === null) return plain;
  // From the top edge down: a dialog in the box's place lies there, and the transcript above is no part of it.
  // The box's own prompt glyph, where the layout names one (`frame.ownPrompt`), is no pointer there.
  const at = frame.top;
  // A draft-shaped box with a row cut by an ellipsis is neither a draft nor a dialog: claim unreadable.
  if (plain.strength !== "strong" && wrapUnderGlyph(withoutOwnPrompt(rows, frame).map(rowText), frame, idle) === "cut") {
    return { ...plain, cues: [], strength: "none", cutWrap: true };
  }
  const down = readCues(withoutDraftContinuation(withoutPromptGlyph(withoutOwnPrompt(rows, frame), frame, idle), frame, idle).slice(at), null, null);
  // A weak shape inside the box is the box's own hint row (OMP draws "to change thinking effort" there).
  if (down.strength !== "strong" || plain.strength === "strong") return plain;
  return { ...down, cluster: down.cluster.map((i) => i + at), cues: down.cues.map((cue) => ({ kind: cue.kind, row: cue.row + at })) };
}

/**
 * The rows with the draft's continuation rows read as blank, for a profile that names `frame.draftIndent`:
 * the rows under the prompt row inside the box that start with that many spaces. A dialog the person quoted
 * in a long draft (a permission box in a prompt about permission boxes) draws at that indent and is no
 * dialog; one the harness draws in the box's place starts at the box's own column and stays.
 */
function withoutDraftContinuation(rows: readonly FrameRow[], frame: Frame, idle: IdleProfile): readonly FrameRow[] {
  const indent = idle.frame.draftIndent;
  if (indent === undefined) return rows;
  const lead = " ".repeat(indent);
  return rows.map((row, i) => (i > frame.interior.prompt && i <= frame.interior.last && rowText(row).startsWith(lead) ? { segments: [] } : row));
}

/**
 * The shape of a found box's draft, from the prompt row down to its last non-blank row. `wrapped`: one
 * paragraph soft-wrapped to the box's width, two rows or more, no blank row between them, and every row
 * but the last filled to the top edge's width, so the next row's first word would not have fit on it
 * (within {@link WRAP_SLACK}). A draft typed with newlines has short rows and fails this (`no`), so it
 * reads as a list still: the conservative side, a send refused, never a dialog typed into.
 *
 * `lines`: a layout that names `frame.draftLines` says no dialog in its box points with the prompt glyph.
 * There a box that fails the wrap test is still the draft's own lines when {@link ownLines} holds: no row
 * holds an option or a key hint, and no list the profile names stands in the box. Any of those keeps
 * the box a list.
 *
 * `cut`: the rows pass that test, but a row ends in an ellipsis ({@link endsInEllipsis}). pi cuts a menu
 * or hint row wider than the box with `…` (or `...`), so the row fills the width the way a soft wrap
 * does, and a wrapped draft and a cut menu cannot be told apart. A row cut so is taken as filled. Neither
 * reading is safe: as a draft, Enter would answer a menu; as a menu (the older reading, a pointed list),
 * a tap's Enter would submit the draft. So `cut` makes the read unreadable ({@link CueRead.cutWrap}):
 * no dialog card, no taps, no free Send. Unreadable is the safe failure; a wrong dialog is not.
 */
function draftWrap(texts: readonly string[], frame: Frame, idle: IdleProfile): DraftRead {
  const soft = softWrap(texts, frame);
  if (soft !== "no" || idle.frame.draftLines !== true) return soft;
  return ownLines(texts, frame, idle) ? "lines" : "no";
}

/** The {@link draftWrap} test of one paragraph soft-wrapped to the box's width, for every layout. */
function softWrap(texts: readonly string[], frame: Frame): DraftRead {
  // The top edge spans the box: an open box's bottom row is its last row (a statusline), not a rule.
  const width = displayWidth(texts[frame.top]!.trimEnd());
  // A blank top edge gives no width to fill: read no wrap.
  if (width <= WRAP_SLACK) return "no";
  const { prompt } = frame.interior;
  let last = frame.interior.last;
  while (last > prompt && isBlank(texts[last]!)) last--;
  if (last === prompt) return "no";
  let cut = false;
  for (let i = prompt; i <= last; i++) if (endsInEllipsis(texts[i]!)) cut = true;
  for (let i = prompt; i < last; i++) {
    const row = texts[i]!.trimEnd();
    const next = texts[i + 1]!.trim().split(/\s/u)[0]!;
    if (isBlank(row) || next.length === 0) return "no";
    if (endsInEllipsis(row)) continue;
    if (displayWidth(row) + 1 + displayWidth(next) <= width - WRAP_SLACK) return "no";
  }
  return cut ? "cut" : "wrapped";
}

/** What a found box's rows under its prompt glyph are ({@link draftWrap}). */
type DraftRead = "wrapped" | "lines" | "cut" | "no";

/**
 * Whether the rows of a box, from its prompt row down to its last non-blank row, are a draft typed with
 * newlines, for a layout whose prompt glyph is never a dialog's pointer (`frame.draftLines`). Two rows or
 * more; none an option row ({@link isOptionRow}) or a key hint; and no list the profile names for its
 * typed commands in the box ({@link commandListAt}), the one list such a harness
 * draws under its prompt glyph.
 */
function ownLines(texts: readonly string[], frame: Frame, idle: IdleProfile): boolean {
  const { prompt } = frame.interior;
  let last = frame.interior.last;
  while (last > prompt && isBlank(texts[last]!)) last--;
  if (last === prompt) return false;
  for (let i = prompt; i <= last; i++) {
    const text = texts[i]!;
    if (isBlank(text)) continue;
    if (isOptionRow(text) || KEY_HINT.test(unboxed(text))) return false;
  }
  return commandListAt(texts, frame, idle.volatile.below.commandList) === null;
}

/** Whether a row's text ends in an ellipsis: the character `…` or three ASCII dots. */
function endsInEllipsis(text: string): boolean {
  const end = text.trimEnd();
  return end.endsWith("…") || end.endsWith("...");
}

/** The {@link draftWrap} of a box whose prompt row opens on a pointer glyph the frame took as the prompt
 *  marker (the draft does not start with it), or `no` for any other box. */
function wrapUnderGlyph(texts: readonly string[], frame: Frame, idle: IdleProfile): DraftRead {
  if (frame.placeholder) return "no";
  const glyph = texts[frame.interior.prompt]!.trimStart()[0];
  if (glyph === undefined || !POINTERS.includes(glyph) || frame.interior.text.startsWith(glyph)) return "no";
  return draftWrap(texts, frame, idle);
}

/** The rows with the pointer glyph the box's prompt row opens on read as blank, when the frame took it as
 *  the prompt marker (the draft does not start with it) and the draft under it is soft-wrapped or the
 *  layout's own lines ({@link draftWrap}). */
function withoutPromptGlyph(rows: readonly FrameRow[], frame: Frame, idle: IdleProfile): readonly FrameRow[] {
  const texts = rows.map(rowText);
  const draft = wrapUnderGlyph(texts, frame, idle);
  if (draft !== "wrapped" && draft !== "lines") return rows;
  const glyph = texts[frame.interior.prompt]!.trimStart()[0]!;
  const segments = [...rows[frame.interior.prompt]!.segments];
  const at = segments.findIndex((run) => run.text.includes(glyph));
  segments[at] = { ...segments[at]!, text: segments[at]!.text.replace(glyph, " ") };
  return rows.map((row, i) => (i === frame.interior.prompt ? { segments } : row));
}

/**
 * The modal cues on a screen read. `frame` is the input frame the profile found, or null: a screen
 * with no profile, or one whose frame the profile did not find, gets the no-frame cluster. `notice` is
 * the notice over the box ({@link noticeOver}), indexed as `rows` are, or null when these rows hold
 * none: its rows down to the box (`first` to `end`, a gap row included) are read as blank, so its key
 * row is never a single-key prompt.
 */
export function readCues(allRows: readonly FrameRow[], frame: Frame | null, notice: AboveNotice | null): CueRead {
  const rows = withoutSpan(allRows, notice === null ? null : { first: notice.first, last: notice.end });
  const texts = rows.map(rowText);
  const tail = tailCluster(texts);
  const hash = shortHash(tail.map((i) => texts[i]!.trimEnd()).join("\n"));

  if (frame === null) {
    const found = cuesIn(texts, tail, true);
    return { cluster: tail, above: [], cues: found.cues, strength: strengthOf(found.cues, found), hash };
  }

  // Over the box, only a strong shape counts: a dialog a harness draws above its own live box (a
  // rating survey, a question) is strong, and a weak shape there is a quote in the transcript.
  const cluster = belowRows(texts, frame);
  const above = aboveRun(texts, frame);
  const under = cuesIn(texts, cluster);
  const over = cuesIn(texts, above);
  // A panel's dismiss hint, alone over the box: the panel holds the keys, whatever the box looks like.
  const panelFoot = above.length === 1 && PANEL_FOOT.test(unboxed(texts[above[0]!]!));
  const overStrong = panelFoot || strengthOf(over.cues, over) === "strong";
  const cues = overStrong ? [...under.cues, ...over.cues] : under.cues;
  const strength = overStrong ? "strong" : strengthOf(under.cues, under);
  return panelFoot ? { cluster, above, cues, strength, hash, panelFoot } : { cluster, above, cues, strength, hash };
}

/**
 * Strong: a single-key prompt; a pointer on a listed row with a numbered list; a key-hint footer with
 * a listed row. Two more shapes name a list or a choice on their own, so they are strong too: a
 * pointed list of three rows or more, and key hints that name two keys or more ("↑/↓ navigate ·
 * enter select", "enter confirm · esc cancel"). In the no-frame cluster an overlay shape (see the
 * header) is strong on its own. Any other cue alone is weak.
 */
function strengthOf(cues: readonly Cue[], found: ClusterCues): CueStrength {
  if (cues.length === 0) return "none";
  const has = (kind: CueKind): boolean => cues.some((cue) => cue.kind === kind);
  if (has("single-key")) return "strong";
  if (found.pointerListed && has("numbered-list")) return "strong";
  if (has("key-hint") && found.listed) return "strong";
  if (found.pointedList || found.keyHints >= 2 || found.overlay) return "strong";
  return "weak";
}
