// ONE reader for every pi-family question screen (.adr/0098). It names no extension and no tool:
// it reads a dialog by its SHAPE and takes every key from its FOOTER (footer.ts).
//
// Herdr reports stock pi and OmO alike as `agent: "pi"`, and pi's question tools are extensions:
// pi's own stock examples (`question`, `questionnaire`), OmO's built-in ask, and many more on npm.
// One grammar per extension cannot keep up, so this module reads what they share. The captures that
// prove each piece are named where the piece is read; the table of what lifts is in the ADR.
//
// THE SHAPE, bottom up, at the buffer tail. Anything else is a decline (raw mirror plus the Escape
// card):
//
//   ──────────────────────────────────────     top rule: full width, same length and colour as the bottom
//    Ask user · 30m                            header rows, one space in: an optional title (OmO), an
//    ←  □ Color   □ Size   ✓ Submit  →         optional tab strip, then the question, wrapped
//    Pick a color for the Collie probe?
//                                              blank rows
//   > 1. Red                                   options, numbered 1..n (n ≤ 9), contiguous, one pointer
//        Warm and loud.                        description rows at the label's column
//     2. Green
//     3. Type something.                       an optional free-text row, last, numbered or not
//                                              blank rows
//    Submit (0/1 answered) — Enter advances    up to two trailer rows, one space in (OmO)
//    ↑↓ navigate • Enter to select • Esc …     the footer, one space in, styled, up to three rows
//                                              at most one blank row
//   ──────────────────────────────────────     bottom rule
//   /tmp/project                               one to four styled status rows, no rule among them,
//                                              or none at all (Gentle Shell, issue 455)
//
// Two pointer columns are read: column 0 (`> 1.`, stock pi and the PR 397 extension) and column 1
// (` → 1.`, OmO). The pointer glyph is `>` or `→`, the two the captures show; Claude's `❯` is not one.
//
// Unnumbered rows are read at column 1 only: ` → Label` and `   Label`, a description row one column
// further in (`    Primeira opção`), and gentle-pi's `Other…` as the free-text row. That is pi's own
// selector behind `ctx.ui.confirm` and `ctx.ui.select` (ExtensionSelectorComponent) and gentle-pi's
// ask_user_choice (pi--v130-gentle-choice.txt). Column 0 unnumbered (`→ name`) is pi's slash palette
// and its pickers, never read here. Unnumbered rows lift by plan (a) only: there is no digit to send.
// The list is the run that holds the pointer; a selector's title of several rows may quote a command
// further in above it (pi's permission gate, pi--v0871-permission-gate.txt; `unnumberedStart`).
//
// THE PLAN comes from the footer alone, and only these four plans exist:
//   a. Up/Down named as moving and Enter named as select or confirm: a walked pointer list
//      (pointerWalk, ADR 0055/0080). The arrows go first; Enter only after a fresh read shows the
//      pointer on the tapped row. No digit, even where the rows are numbered (ADR 0009).
//   b. `1-9 select` and Enter NOT named as select: the digit alone, and only on a one-question dialog
//      (no tab strip, or a strip with one question chip). The digit is a key the footer printed.
//   c. A footer that names digits only as typed text adds nothing; (a) still applies.
//   e. A tab strip with several questions: a question page lifts by (a) only, captioned with the
//      current chip's label, and the Submit page lifts as a wizard review only when the screen names
//      Enter as submit and every question has an answer row.
// Multi-select (checkbox rows) is not lifted here; it stays raw (see the ADR). The footer's Esc hint
// becomes the last row, sending Escape, in the footer's own words.
//
// The free-text row is never a button. It is the `free-text` field of the model, read so the walk
// knows the row is there; a screen whose pointer stands on it stays raw, and nothing here types.
//
// A READ WITH NO STYLING (herdr-core's `terminal.read`, M78 spec 07): every paint test above stands
// for one text fact, and only when `readIsUnstyled` holds for the whole screen. Styled reads keep
// every paint test.
//   - the footer rows: their parse alone (the paint kept a key hint quoted in a draft out; on a plain
//     read that draft has no option rows, so it still lifts nothing);
//   - the status rows under the bottom rule: one of them carries pi's own session cost (`$0.000`,
//     OmO's `$0.064 (sub)`), and the last does not end like a shell prompt (`textStatus`);
//   - an open frame's title: its place, one space in under the top rule;
//   - a tab strip's current chip: not on the screen at all. A question page of several questions
//     lifts uncaptioned (its own question row names it), and a page with no option row under the
//     strip is the Submit page.
// A frameless dialog (no rules) and a picker stay paint-only: they decline on a plain read.
//
// Pure functions over StyledLine[], tail-anchored, fail closed.

import { lineText, type StyledLine } from "../../blocks";
import { readIsUnstyled } from "../../surface/frame";
import { MAX_REGION_CHARS } from "../bound-region";
import { pointerWalk } from "../menu-hints";
import type { PromptFeedback, PromptModel, PromptOption } from "../prompt-model";
import type { WizardAnswer, WizardModel, WizardStepChip } from "../wizard-model";
import { locateComposer, MAX_PICKER_HEADER_ROWS, paintedStatus, ruleAbove, tailRule } from "./composer";
import { keyHintPairs, listDialogHint, parsePiFooter, type PiFooter } from "./footer";

/** A full-width rule: pi's editor rules and every question extension's own top and bottom rule. */
const RULE = /^─{8,}$/;
/** Status rows pi paints under its editor: stock 2 (cwd, stats), OmO 3, the PR 397 powerbar 1. */
const MAX_STATUS_ROWS = 4;
/** A narrow pane wraps the footer; the PR 397 capture at 50 columns needs two rows. */
const MAX_FOOTER_ROWS = 3;
/** How far up the top rule may be. The bound keeps a scan out of scrollback. */
const MAX_BODY_ROWS = 200;
/** OmO's status line under its options (`Submit (0/1 answered) — Enter advances`). */
const MAX_TRAILER_ROWS = 2;
const POINTERS = new Set([">", "→"]);
/** The free-text row's label: `Type something.` (stock, PR 397), `Type your own answer...` (OmO). The
 *  `✎` follows it while its inline editor is open. */
const FREE_TEXT = /^Type\b.*(?:\.|…)(?: ✎)?$/;
/** gentle-pi's free-text row in an unnumbered list (`allowCustomResponse`); Enter on it opens an editor. */
const OTHER = /^Other(?:…|\.\.\.)$/;
/** A header row, one space in. */
const HEADER_ROW = /^ \S/;
/** A row at column 0: the footer and the header block of a frameless dialog. */
const NO_INDENT = /^\S/;
/** A frameless dialog's description paragraph, under the options, is at most this many rows. */
const MAX_NOTE_ROWS = 3;
/** An unnumbered option row at pointer column 1: the pointer or a space, a space, the label. */
const UNNUMBERED_ROW = /^ ([→ ]) (\S.*)$/;
/** A description row under an unnumbered option, four columns in. */
const DESCRIPTION_ROW = /^ {4}(\S.*)$/;
/** A title row indented deeper than one space: the command pi's permission gate quotes (`unnumberedStart`). */
const QUOTED_ROW = /^ {2,}\S/;
/** pi's own footer prints the session's cost to three decimals: stock `$0.000`, OmO `$0.064 (sub)`. */
const SESSION_COST = /(?:^|\s)\$\d+\.\d{3}(?=\s|$)/;
/** The end of a shell prompt (`$ `, `# `, `> `, `❯ `): what stands under pi's rows once pi exited. */
const SHELL_PROMPT_END = /[$#>❯]$/;
/** The first status row opens with the working directory: `/tmp/…`, `~/project`, OmO's `…/work`. */
const STATUS_PATH = /^(?:\/|~|…\/)/;
/** pi's own status block on a plain read: stock pi prints two rows and an extension-status row, OmO
 *  three (pi--omo-v5130-single-described.txt). Output under them makes the block longer. */
const MAX_PLAIN_STATUS_ROWS = 3;

/** The frame every pi question screen shares: the two rules and the footer between them. */
export interface PiFrame {
  top: number;
  /** The bottom rule, or, on an open frame, the screen's last row (the region ends there). */
  bottom: number;
  /** The bottom rule is off the screen: a dialog taller than the pane (see `openFrameTop`). */
  open: boolean;
  /** No rules: a dialog drawn under the transcript with its footer as the screen's last row (see
   *  `framelessFrame`). `top` is its title row and `bottom` its footer's last row. */
  frameless?: true;
  /** First and last row of the footer (inclusive). */
  footerStart: number;
  footerEnd: number;
  footer: PiFooter;
  texts: string[];
}

function styledRow(line: StyledLine): boolean {
  return line.segments.some((s) => s.text.trim() !== "" && (s.fg !== undefined || s.muted));
}

function ruleColor(line: StyledLine): string | undefined {
  return line.segments.find((s) => s.text.trim() !== "")?.fg;
}

/**
 * The bottom rule of the live tail: a full rule with one to four status rows under it and nothing
 * else, or a full rule that is itself the last row, or null. Stock pi and OmO paint at least one status
 * row under the area a dialog replaces, but an extension may replace pi's footer with an empty one
 * (Gentle Shell does), and then the dialog's bottom rule is the last row (issue 455,
 * pi--v130-gentle-choice.txt). A bare bottom rule counts only under a rule of its width; the frame
 * reader then demands the same colour too. Such a block is byte for byte a dialog quoted in agent
 * prose that ends the buffer, a case the screen cannot tell apart (pi/ask.test.ts, "a quoted dialog is
 * not a dialog"). Status rows are never a rule, and they are painted as `paintedStatus` (composer.ts)
 * says: pi paints its own rows muted or coloured, and only the last row, the extension-status line,
 * may be plain. A plain row straight under the frame is output written after it, such as the shell
 * prompt after pi exited (pi--prose-quoted-dialog-then-shell.txt).
 */
function statusTailBottom(lines: StyledLine[], texts: string[], end: number, plain: boolean): number | null {
  if (end >= 0 && RULE.test(texts[end]!)) {
    return ruleAbove(texts, end, texts[end]!.length, MAX_BODY_ROWS) >= 0 ? end : null;
  }
  let bottom = end;
  while (bottom >= 0 && end - bottom <= MAX_STATUS_ROWS && !RULE.test(texts[bottom]!)) bottom--;
  if (bottom < 0 || !RULE.test(texts[bottom]!) || end - bottom > MAX_STATUS_ROWS) return null;
  for (let i = bottom + 1; i <= end; i++) {
    if (/^\s*─{3,}/.test(texts[i]!)) return null;
  }
  const status = plain ? textStatus(texts.slice(bottom + 1, end + 1)) : paintedStatus(lines.slice(bottom + 1, end + 1));
  return status ? bottom : null;
}

/**
 * `paintedStatus` on a read with no styling, by the shape of pi's own footer: one to three rows, the
 * first opening with the working directory, the first or the second carrying the session cost (stock
 * pi: the path row, then the stats row, pi--v130-core-question--w120.txt; OmO: both on its first row),
 * and the last not ending like a shell prompt. So output written under the status rows (two rows or
 * more, the conformance suite's tail-anchoring case) and a dialog quoted in prose above a shell after
 * pi exited (pi--prose-quoted-dialog-then-shell.txt, stripped, also with pi's status rows quoted) stay
 * raw. One plain row under stock pi's two is an extension's status row on a styled read too, so one
 * output row there is the limit the paint test has as well. A footer that prints no cost (the PR 397
 * footer's `⎇ main`) declines here; Gentle Shell's empty footer is the bare rule and needs none.
 */
function textStatus(rows: string[]): boolean {
  const filled = rows.map((row) => row.trim()).filter((row) => row !== "");
  if (filled.length === 0 || filled.length > MAX_PLAIN_STATUS_ROWS || !STATUS_PATH.test(filled[0]!)) return false;
  if (!filled.slice(0, 2).some((row) => SESSION_COST.test(row))) return false;
  return !SHELL_PROMPT_END.test(filled.at(-1)!);
}

/** The footer ending at row `footerEnd`: one to three painted rows, one space in (`indent`: or none at
 *  all, on a frameless dialog), that parse. */
function footerAt(
  lines: StyledLine[],
  texts: string[],
  footerEnd: number,
  plain: boolean,
  indent: RegExp = HEADER_ROW,
): { start: number; footer: PiFooter } | null {
  let best: { start: number; footer: PiFooter } | null = null;
  for (let k = 1; k <= MAX_FOOTER_ROWS; k++) {
    const start = footerEnd - k + 1;
    // A footer row is painted (dim or coloured) in every capture. A plain row is text someone typed,
    // such as a key hint quoted in a draft (pi/ask.test.ts, "quoted key hints"). A plain read has no
    // paint anywhere, so the parse alone counts there (see the header).
    if (start <= 0 || !indent.test(texts[start]!) || (!plain && !styledRow(lines[start]!))) break;
    const rows = texts.slice(start, footerEnd + 1).map((t) => t.trim());
    const footer = wrappedFooter(rows);
    if (footer !== null) best = { start, footer };
  }
  return best;
}

/**
 * A footer read across the rows a narrow pane wrapped it onto. The terminal breaks a row between words,
 * so the break is either inside one hint (`enter` / `select`) or between two (`… enter select` /
 * `escape/ctrl+c cancel`). Joined with one space the second reads as one hint whose verb swallows the
 * next key, and the Escape the footer names is lost. So both joins are read, and the one that parses
 * into more hints wins: a hint split across the break does not parse as two, and falls back to one.
 */
function wrappedFooter(rows: string[]): PiFooter | null {
  const joined = parsePiFooter(rows.join(" "));
  if (rows.length < 2) return joined;
  const apart = parsePiFooter(rows.join("  "));
  if (apart === null) return joined;
  if (joined === null) return apart;
  return hintCount(apart.text) > hintCount(joined.text) ? apart : joined;
}

function hintCount(text: string): number {
  return text.split(/\s+[•·]\s+|\s{2,}/).filter((s) => s.trim() !== "" && s.trim() !== "•").length;
}

/** Read the frame at the tail of `lines`, or null. Says nothing yet about what is inside it. A frame
 *  whose bottom rule is off the screen is read too, as an open frame (`openFrameTop`), when its
 *  footer is still on the screen. */
export function readPiFrame(lines: StyledLine[]): PiFrame | null {
  const texts = lines.map((l) => lineText(l).trimEnd());
  let end = texts.length - 1;
  while (end >= 0 && texts[end] === "") end--;
  if (end < 0) return null;

  const plain = readIsUnstyled(lines);
  const bottom = statusTailBottom(lines, texts, end, plain);
  if (bottom === null) {
    // A frameless dialog is told from prose by its paint alone: none on a plain read.
    const frameless = plain ? null : framelessFrame(lines, texts, end);
    if (frameless !== null) return frameless;
    const top = openFrameTop(lines, texts, end);
    if (top === null) return null;
    // The footer ends at the screen's last row: the rows under it are what the pane cut off.
    const best = footerAt(lines, texts, end, plain);
    if (best === null || best.start <= top) return null;
    return { top, bottom: end, open: true, footerStart: best.start, footerEnd: end, footer: best.footer, texts };
  }
  if (bottom < 3) return null;

  // The footer: OmO leaves one blank row above the rule, stock pi none.
  let footerEnd = bottom - 1;
  if (texts[footerEnd] === "") footerEnd--;
  const best = footerAt(lines, texts, footerEnd, plain);
  if (best === null) return null;

  // The top rule: the first full rule above, of the bottom rule's length and colour.
  // An indented rule is an inline editor's border (` ────`, pi--v110-single-editor-open.txt) and is
  // passed over here; the rows it sits in are judged by the reader, not by the frame.
  let top = best.start - 1;
  while (top >= 0 && !RULE.test(texts[top]!)) {
    if (best.start - top > MAX_BODY_ROWS) return null;
    top--;
  }
  if (top < 0 || texts[top] !== texts[bottom] || ruleColor(lines[top]!) !== ruleColor(lines[bottom]!)) return null;
  return { top, bottom, open: false, footerStart: best.start, footerEnd, footer: best.footer, texts };
}

/**
 * A dialog with no rules at all: its footer is the last non-blank row of the screen, painted, at
 * column 0, and above it stand the numbered options with one pointer and a header block of rows at
 * column 0 whose first row is painted (the title). That is the Gentle AI review-consent screen
 * (pi--v130-gentle-review-consent.txt, pi 1.3.0 with gentle-pi 4.2.0): the extension draws it
 * under the transcript with no rule frame and no editor or status row under it. Read by shape and
 * footer, never by title or labels. Plain agent prose that quotes such rows never gets here, for
 * three reasons: pi's real editor, with its rules, is the last thing on the screen while pi runs
 * (so `statusTailBottom` takes it), the footer must be painted, and nothing may follow it.
 * `top` is the title row, the first row of the block that holds the first option; null when no
 * painted footer ends the screen or no `1.` option row with a header above it is found.
 */
function framelessFrame(lines: StyledLine[], texts: string[], end: number): PiFrame | null {
  const best = footerAt(lines, texts, end, false, NO_INDENT);
  if (best === null) return null;
  let first = -1;
  for (let r = best.start - 1; r >= 0 && best.start - r <= MAX_BODY_ROWS; r--) {
    if (RULE.test(texts[r]!)) return null;
    if (optionStart(texts[r]!) === 0) {
      first = r;
      break;
    }
  }
  if (first < 1) return null;
  let top = first;
  while (top > 0 && texts[top - 1] !== "" && !RULE.test(texts[top - 1]!)) top--;
  if (top === first || !styledRow(lines[top]!)) return null;
  return { top, bottom: end, open: false, frameless: true, footerStart: best.start, footerEnd: end, footer: best.footer, texts };
}

/**
 * The top rule of a dialog whose bottom rule is off the screen, or null (ASK_NOTES.md, "A dialog
 * taller than the pane"). OmO's fullscreen mode draws a dialog from the top down, so on a short pane a
 * question or a picker runs past the last row: no bottom rule and no status rows, which is the
 * evidence every other reader here starts from. What proves the modal then, all of it:
 *   - the screen ends inside the frame: no pi status rows at the tail, nothing under the frame's top
 *     rule is a rule, and no row under it is wider than it (the rule spans the frame);
 *   - the top rule is the lowest full rule on the screen, and then one of two shapes:
 *     a. a dialog: after at most one blank row, a painted header row one space in (OmO's title
 *        `Ask user · 30m`, stock pi's question), every later row one space in or a pointer row, and
 *        either the first option row (`1.`) or the footer on the screen;
 *     b. a picker: a painted key-hint row in the header section between this rule and the rule of
 *        its width above it (`/tree`, pi--omo-v5130-panel-picker-tree-cut.txt), and no `❯` editor
 *        row under it.
 * The captures are cut from real ones (fixtures README, "derived"). Agent prose that quotes a dialog
 * stays prose: while pi runs its editor and status rows are at the tail, and after it exits the shell
 * prompt is, so neither screen ends inside a frame.
 */
export function openFrameTop(lines: StyledLine[], texts: string[], end: number): number | null {
  const plain = readIsUnstyled(lines);
  if (end < 1 || tailRule(lines) !== null || statusTailBottom(lines, texts, end, plain) !== null) return null;
  let top = end;
  while (top >= 0 && end - top <= MAX_BODY_ROWS && !RULE.test(texts[top]!)) {
    if (/^\s*─/.test(texts[top]!)) return null;
    top--;
  }
  if (top < 0 || !RULE.test(texts[top]!) || top === end) return null;
  const width = texts[top]!.length;
  for (let r = top + 1; r <= end; r++) if (texts[r]!.length > width) return null;
  return openDialog(lines, texts, top, end, plain) || openPicker(lines, texts, top, end) ? top : null;
}

/** Shape (a) of `openFrameTop`: a dialog's title under its top rule, then dialog rows to the end. */
function openDialog(lines: StyledLine[], texts: string[], top: number, end: number, plain: boolean): boolean {
  let title = top + 1;
  if (texts[title] === "") title++;
  if (title > end || !HEADER_ROW.test(texts[title]!) || (!plain && !styledRow(lines[title]!))) return false;
  let option = false;
  for (let r = title + 1; r <= end; r++) {
    const t = texts[r]!;
    if (t === "") continue;
    if (!t.startsWith(" ") && !/^[>→] /.test(t)) return false;
    if (optionStart(t) !== null) option = true;
  }
  return option || footerAt(lines, texts, end, plain) !== null;
}

/** Shape (b) of `openFrameTop`: a picker's key-hint row over its inner rule, no editor under it. */
function openPicker(lines: StyledLine[], texts: string[], top: number, end: number): boolean {
  for (let r = top + 1; r <= end; r++) if (texts[r]!.startsWith("❯")) return false;
  const header = ruleAbove(texts, top, texts[top]!.length, MAX_PICKER_HEADER_ROWS + 1);
  if (header < 0) return false;
  for (let r = header + 1; r < top; r++) {
    if (paintedRow(lines[r]!) && (keyHintPairs(texts[r]!) >= 2 || listDialogHint(texts[r]!))) return true;
  }
  return false;
}

/**
 * Positive evidence that a pi modal is up (the unread-dialog card's fifth condition, ADR 0053): a
 * rule-bounded frame at the tail whose footer names an Escape key, or a picker's key-hint row. A
 * composer prints neither, so a live editor never answers true.
 */
export function piModalOnScreen(lines: StyledLine[]): boolean {
  if (readPiFrame(lines)?.footer.escapeVerb != null) return true;
  if (pickerOnScreen(lines)) return true;
  const texts = lines.map((l) => lineText(l).trimEnd());
  let end = texts.length - 1;
  while (end >= 0 && texts[end] === "") end--;
  return openFrameTop(lines, texts, end) !== null;
}


/** The banner's first row: `? Question pending (1 unanswered)`, with OmO's countdown after it. */
const BANNER_TITLE = /^\? Question pending \(\d+ unanswered\)/;
/** How far above the editor's top rule the banner's first row may stand (five rows in the capture). */
const MAX_BANNER_ROWS = 8;

/**
 * OmO's question banner is up over a ready editor (ASK_NOTES.md, "OmO's question banner"): a question
 * waits in the terminal, and no card can answer it, because the banner prints no keys of its own
 * beyond Enter and a free-text reply. A send while it shows is OmO's free-text answer, so the editor
 * stays ready and this is a cue only, never a card. Read from pi--omo-v5130-question-banner.txt:
 *   - the editor is on screen and no pi modal is (the banner is not a dialog);
 *   - at most eight rows above the editor's top rule, a row that opens with a painted `?` and reads
 *     `? Question pending (N unanswered)`;
 *   - no blank row between it and the top rule: the banner stands on the editor as one block.
 */
export function piQuestionBanner(lines: StyledLine[]): boolean {
  const editor = locateComposer(lines);
  if (editor === null || piModalOnScreen(lines)) return false;
  for (let r = editor.top - 1; r >= 0 && editor.top - r <= MAX_BANNER_ROWS; r--) {
    const text = lineText(lines[r]!).trimEnd();
    if (text === "") return false;
    const first = lines[r]!.segments.find((s) => s.text.trim() !== "");
    if (BANNER_TITLE.test(text) && first !== undefined && first.text.trim() === "?" && first.fg !== undefined) return true;
  }
  return false;
}

/** Every visible segment painted: a hint row is dim, and pi never paints what the operator typed. */
function paintedRow(line: StyledLine): boolean {
  const visible = line.segments.filter((s) => s.text.trim() !== "");
  return visible.length > 0 && visible.every((s) => s.fg !== undefined || s.muted);
}

/**
 * A picker is up (.adr/0098, "Pickers"): pi's own `/model`, `/tree` and `/resume`, OmO's, and any
 * other selector an extension draws in the editor's place. Every one prints a key-hint row, and a
 * picker is told by that row alone, never by its title, its name or the extension behind it:
 *   - a painted row that is nothing but two or more key/action pairs (`keyHintPairs`, footer.ts), or one
 *     of the two 1.2.0 list-dialog hint rows keyHintPairs cannot read (`listDialogHint`, footer.ts);
 *   - between the bottom rule over the live status rows and the nearest rule of its width above, or,
 *     when that section is not an editor, in a header section of at most eight rows above that
 *     (`/tree` puts its hints over an inner rule, pi--omo-v5130-picker-tree.txt);
 *   - never in an OmO editor: a `❯` frame is the editor, so its rows are the operator's draft. A
 *     stock editor's rows are the draft too, and typed text is never painted.
 * Read for the card's evidence only; nothing is lifted from it.
 */
function pickerOnScreen(lines: StyledLine[]): boolean {
  const texts = lines.map((l) => lineText(l).trimEnd());
  let end = texts.length - 1;
  while (end >= 0 && texts[end] === "") end--;
  // A picker is told by its painted hint row alone, so the paint tests stand here on any read.
  const bottom = statusTailBottom(lines, texts, end, false);
  if (bottom === null || bottom < 1) return false;
  const editor = locateComposer(lines);
  if (editor?.layout === "omo") return false;
  const width = texts[bottom]!.length;
  const hintIn = (from: number, to: number): boolean => {
    for (let r = from; r < to; r++) {
      if (paintedRow(lines[r]!) && (keyHintPairs(texts[r]!) >= 2 || listDialogHint(texts[r]!))) return true;
    }
    return false;
  };
  const top = ruleAbove(texts, bottom, width, MAX_BODY_ROWS);
  if (top < 0) return false;
  if (hintIn(top + 1, bottom)) return true;
  if (editor !== null) return false;
  const header = ruleAbove(texts, top, width, MAX_PICKER_HEADER_ROWS + 1);
  return header >= 0 && hintIn(header + 1, top);
}

/** One option row, read. */
interface OptionRow {
  label: string;
  /** The row's number as printed, or null for an unnumbered free-text row. */
  n: number | null;
  pointed: boolean;
  checkbox: boolean;
  freeText: boolean;
  description?: string;
  /** Index into `texts`. */
  row: number;
}

/** One chip of a tab strip. */
interface Chip {
  label: string;
  answered: boolean;
  current: boolean;
  submit: boolean;
}

interface Strip {
  row: number;
  chips: Chip[];
}

export type PiQuestion =
  | { kind: "prompt-select"; model: PromptModel; startLine: number }
  | { kind: "wizard"; model: WizardModel; startLine: number };

/**
 * Detect a pi-family question screen at the tail of `lines` and the block it lifts as, or null.
 */
export function detectPiQuestion(lines: StyledLine[]): PiQuestion | null {
  const frame = readPiFrame(lines);
  if (frame === null) return null;
  const { texts, top, bottom, footer } = frame;
  if (footer.escapeVerb === null) return null;
  const plain = readIsUnstyled(lines);

  // Header rows, then the options, then trailer rows; every body row must be one of these. A frameless
  // dialog has no top rule: its title is the first row, and its rows sit at column 0.
  const frameless = frame.frameless === true;
  const headerRow = frameless ? NO_INDENT : HEADER_ROW;
  let at = frameless ? top : top + 1;
  const bodyEnd = frame.footerStart; // exclusive
  let header: number[] = [];
  let pointerCol: 0 | 1 | null = null;
  while (at < bodyEnd) {
    pointerCol = optionStart(texts[at]!);
    if (pointerCol !== null) break;
    if (texts[at] !== "" && !headerRow.test(texts[at]!)) break;
    header.push(at);
    at++;
  }

  let strip = readStrip(lines, header, plain);
  if (strip === "invalid") return null;
  // No numbered option: the rows may be an unnumbered list (see the header). Never beside a tab strip,
  // whose OmO form (` → Color    Submit`) is the shape of a pointed unnumbered row.
  let numbered = true;
  if (pointerCol === null && strip === null && !frameless) {
    const start = unnumberedStart(texts, top + 1, bodyEnd);
    if (start !== null) {
      numbered = false;
      pointerCol = 1;
      at = start;
      header = [];
      for (let r = top + 1; r < start; r++) header.push(r);
      strip = readStrip(lines, header, plain);
      if (strip !== null) return null;
    }
  }
  if (pointerCol === null && at < bodyEnd) return null;
  // Frameless: numbered rows with the pointer at column 0, no tab strip, nothing else.
  if (frameless && (pointerCol !== 0 || strip !== null)) return null;

  const region = texts.slice(top, bottom + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;

  if (pointerCol === null) {
    // No options: only the Submit page of a tabbed dialog lifts.
    return strip === null ? null : readSubmitPage(frame, header, strip, signature, plain);
  }

  const options = numbered ? readOptions(texts, at, bodyEnd, pointerCol) : readUnnumbered(texts, at, bodyEnd);
  if (options === null) return null;
  // Trailer rows: blank, or at most two header-like rows that are not a rule or an editor. Only OmO's
  // numbered dialog prints one; under unnumbered rows a header-like row is a label wrapped back to
  // column 1, so it declines.
  let trailers = 0;
  let counter: { answered: number; total: number } | null = null;
  if (frameless && !framelessNote(lines, texts, options.end, bodyEnd)) return null;
  for (let i = frameless ? bodyEnd : options.end; i < bodyEnd; i++) {
    const t = texts[i]!;
    if (t === "") continue;
    if (!numbered || !HEADER_ROW.test(t) || /^ [─>]/.test(t) || ++trailers > MAX_TRAILER_ROWS) return null;
    // An answered counter (`Submit (0/1 answered)`, pi--omo-v5130-single-described.txt) is a second
    // count of the questions; read it so it can only narrow what lifts.
    const m = /\((\d+)\/(\d+) answered\)/.exec(t);
    if (m !== null) {
      if (counter !== null) return null;
      counter = { answered: Number(m[1]), total: Number(m[2]) };
    }
  }
  const rows = options.rows;
  // Checkbox rows, or a footer that gives Space a tick or a toggle, are a multi-select question,
  // which this reader leaves raw (.adr/0098). OmO's multi-select prints no checkbox at all and says
  // so only in its footer (`space toggle  enter toggle`, pi--omo-v5130-multi.txt).
  if (rows.some((r) => r.checkbox) || footer.spaceToggles) return null;

  const questionRows = strip === null ? header : header.filter((r) => r > strip.row);
  const question = questionRows
    .map((r) => texts[r]!.trim())
    .filter((t) => t.length > 0)
    .join(" ");
  if (question.length === 0) return null;

  const questions = strip === null ? 1 : strip.chips.filter((c) => !c.submit).length;
  if (counter !== null && counter.total !== questions) return null;
  const pointed = rows.findIndex((r) => r.pointed);
  const free = rows.at(-1)!.freeText ? rows.at(-1)! : null;
  // A pointer on the free-text row stays raw: one keystroke there (Enter) opens the extension's own
  // editor, and the phone never types into it (pi--v0871-question-other-focused.txt,
  // pi--omo-v5130-single-other-focused.txt).
  if (free?.pointed === true) return null;
  const choices = free === null ? rows : rows.slice(0, -1);
  if (choices.length < 1) return null;

  let plan: "walk" | "digit";
  if (footer.arrowsMove && footer.enter === "select") plan = "walk";
  else if (footer.digitsSelect && footer.enter !== "select" && questions === 1) plan = "digit";
  else return null;
  if (plan === "digit" && choices.some((r) => r.n === null)) return null;
  // A digit on a question already answered is a state no capture shows; fail closed (PR 412's notes).
  if (plan === "digit" && counter !== null && counter.answered !== 0) return null;

  let caption: string | undefined;
  if (strip !== null && questions > 1) {
    // A page of several questions: (a) only, and the page must be named by its current chip.
    if (plan !== "walk") return null;
    const current = strip.chips.filter((c) => c.current);
    // A plain read cannot tell the current chip (`readStrip`): the page lifts uncaptioned, named by
    // its own question row.
    const unmarked = plain && current.length === 0;
    if (!unmarked && (current.length !== 1 || current[0]!.submit)) return null;
    if (!unmarked) caption = current[0]!.label;
  }

  const glyph = texts[rows[pointed]!.row]![pointerCol]!;
  const options_: PromptOption[] = choices.map((r, i) => {
    const option: PromptOption =
      plan === "walk"
        ? { label: r.label, keys: pointerWalk(pointed, i), keyLabel: i === pointed ? glyph : "" }
        : { label: r.label, keys: [String(r.n)] };
    if (r.description !== undefined) option.description = r.description;
    return option;
  });
  options_.push({ label: capitalise(footer.escapeVerb), keys: ["Escape"], keyLabel: "Esc" });

  const model: PromptModel = {
    question,
    options: options_,
    family: "select",
    signature,
    coreSignature: coreSignatureOf(texts, top, bottom, rows[pointed]!.row, pointerCol, header, strip, frameless ? options.end : bodyEnd, bodyEnd),
  };
  if (caption !== undefined) model.caption = caption;
  if (free !== null) {
    const feedback: PromptFeedback = {
      // No key: nothing is ever sent for this row (prompt-action refuses the `free-text` purpose), and
      // its printed number is not a key the footer names (ADR 0009).
      key: "",
      focused: false,
      text: "",
      purpose: "free-text",
    };
    model.feedback = feedback;
  }
  return { kind: "prompt-select", model, startLine: top };
}

/**
 * What a frameless dialog may print between its options and its footer: one blank row, one painted
 * description paragraph of at most `MAX_NOTE_ROWS` rows at column 0 (the pointed option's effect, in
 * the capture), one blank row; every part optional. Anything else declines.
 */
function framelessNote(lines: StyledLine[], texts: string[], from: number, to: number): boolean {
  let r = from;
  if (r < to && texts[r] === "") r++;
  const start = r;
  while (r < to && texts[r] !== "") {
    if (!NO_INDENT.test(texts[r]!) || !styledRow(lines[r]!) || r - start >= MAX_NOTE_ROWS) return false;
    r++;
  }
  if (r < to && texts[r] === "") r++;
  return r === to;
}

/** The pointer column (0 or 1) when `text` is the first option row, `1.`, else null. */
function optionStart(text: string): 0 | 1 | null {
  for (const col of [0, 1] as const) {
    const lead = text.slice(0, col);
    if (lead.trim() !== "") continue;
    const ptr = text[col];
    if (ptr === undefined || (ptr !== " " && !POINTERS.has(ptr)) || text[col + 1] !== " ") continue;
    if (/^(?:\[[ x]\] )?1\. \S/.test(text.slice(col + 2))) return col;
  }
  return null;
}

/**
 * The option rows from `start`, contiguous: numbered rows 1..n with their description rows, then an
 * optional free-text row. Exactly one row carries the pointer. Null on anything else.
 */
function readOptions(
  texts: string[],
  start: number,
  end: number,
  col: 0 | 1,
): { rows: OptionRow[]; end: number } | null {
  const rows: OptionRow[] = [];
  let boxed: boolean | null = null;
  let labelCol = 0;
  let at = start;
  for (; at < end; at++) {
    const t = texts[at]!;
    if (t === "") break;
    const lead = t.slice(0, col);
    const ptr = t[col];
    const isPrefix = lead.trim() === "" && ptr !== undefined && (ptr === " " || POINTERS.has(ptr)) && t[col + 1] === " ";
    const rest = isPrefix ? t.slice(col + 2) : "";
    const numbered = isPrefix ? /^(\[[ x]\] | {4})?([1-9])\. (\S.*)$/.exec(rest) : null;
    if (numbered !== null && (rows.length === 0 || !rows.at(-1)!.freeText)) {
      const box = numbered[1];
      const checkbox = box !== undefined && box.startsWith("[");
      const n = Number(numbered[2]);
      if (n !== rows.length + 1) return null;
      const label = numbered[3]!;
      const freeText = FREE_TEXT.test(label);
      if (boxed === null) boxed = checkbox;
      // Every choice of a checkbox list carries a box, and the free-text row's column is padded.
      if (!freeText && checkbox !== boxed) return null;
      if (freeText && boxed && box !== "    ") return null;
      if (!boxed && box !== undefined) return null;
      labelCol = col + 2 + (boxed ? 4 : 0) + 3;
      rows.push({ label, n, pointed: ptr !== " ", checkbox, freeText, row: at });
      continue;
    }
    // An unnumbered free-text row (OmO's `Type your own answer...`), at the pointer's column.
    if (isPrefix && rows.length > 0 && !rows.at(-1)!.freeText && FREE_TEXT.test(rest)) {
      rows.push({ label: rest, n: null, pointed: ptr !== " ", checkbox: false, freeText: true, row: at });
      continue;
    }
    // A description row: exactly the label's column, under a choice (never under the free-text row).
    const owner = rows.at(-1);
    const desc = new RegExp(`^ {${labelCol}}(\\S.*)$`).exec(t);
    if (desc !== null && owner !== undefined && !owner.freeText) {
      owner.description = owner.description === undefined ? desc[1]! : `${owner.description} ${desc[1]!}`;
      continue;
    }
    break;
  }
  if (rows.length === 0 || rows.length > 9) return null;
  if (rows.filter((r) => r.pointed).length !== 1) return null;
  // One pointer glyph on the pointed row; a free-text row may only be the last.
  if (rows.slice(0, -1).some((r) => r.freeText)) return null;
  return { rows, end: at };
}

/**
 * The first row of an unnumbered list in `[from, to)`, or null. The list is the run of option rows
 * (` → Label`, `   Label`) and description rows that holds the one pointed row, read up from it, and it
 * must open on an option row. Above it stand header rows only: blank, or one space in.
 *
 * One more header row is read, for pi's own selector with a title of several rows. pi's example
 * permission gate asks `ctx.ui.select("⚠️ Dangerous command:\n\n  <command>\n\nAllow?", …)`, and the
 * command row is three columns in, the shape of an unpointed option (pi--v0871-permission-gate.txt). So a
 * row indented deeper is a header row only when the selector's blank row stands right over the list and
 * a row one space in (`Allow?`) stands between them: an option cut off by a blank row, or a label wrapped
 * back to column 1 over the pointer, has neither, and declines.
 */
function unnumberedStart(texts: string[], from: number, to: number): number | null {
  const pointed: number[] = [];
  for (let r = from; r < to; r++) if (UNNUMBERED_ROW.exec(texts[r]!)?.[1] === "→") pointed.push(r);
  if (pointed.length !== 1) return null;
  let start = pointed[0]!;
  while (start > from && (UNNUMBERED_ROW.test(texts[start - 1]!) || DESCRIPTION_ROW.test(texts[start - 1]!))) start--;
  if (!UNNUMBERED_ROW.test(texts[start]!)) return null;
  const separated = start > from && texts[start - 1] === "";
  let titled = false;
  for (let r = start - 1; r >= from; r--) {
    const t = texts[r]!;
    if (t === "") continue;
    if (HEADER_ROW.test(t)) titled = true;
    else if (!(separated && titled && QUOTED_ROW.test(t))) return null;
  }
  return start;
}

/**
 * Unnumbered option rows from `start`, contiguous: ` → Label` or `   Label`, each with optional
 * description rows four columns in (gentle-pi's NativeChoiceList draws `\n   description` inside a
 * one-column padding), then an optional free-text row, `Other…` or `Type …`, last. Exactly one row
 * carries the pointer. A label wrapped back to column 1 ends the list here, and the caller declines
 * the row it stops at.
 */
function readUnnumbered(texts: string[], start: number, end: number): { rows: OptionRow[]; end: number } | null {
  const rows: OptionRow[] = [];
  let at = start;
  for (; at < end; at++) {
    const t = texts[at]!;
    if (t === "") break;
    const option = UNNUMBERED_ROW.exec(t);
    if (option !== null) {
      if (rows.at(-1)?.freeText === true) return null;
      const label = option[2]!;
      const freeText = OTHER.test(label) || FREE_TEXT.test(label);
      rows.push({ label, n: null, pointed: option[1] === "→", checkbox: false, freeText, row: at });
      continue;
    }
    const desc = DESCRIPTION_ROW.exec(t);
    const owner = rows.at(-1);
    if (desc !== null && owner !== undefined) {
      owner.description = owner.description === undefined ? desc[1]! : `${owner.description} ${desc[1]!}`;
      continue;
    }
    break;
  }
  if (rows.length === 0 || rows.length > 9) return null;
  if (rows.filter((r) => r.pointed).length !== 1) return null;
  return { rows, end: at };
}

/**
 * A tab strip among the header rows, null when there is none, `"invalid"` when a row looks like one
 * and does not read whole. Two forms:
 *   `←  □ Color   ■ Size   ✓ Submit  →`      stock questionnaire, PR 397 (`▢`/`▣`); the current chip
 *                                              is the one with a background colour
 *   `→ Color    Submit`                      OmO; the current chip carries the `→`
 */
function readStrip(lines: StyledLine[], header: number[], plain: boolean): Strip | null | "invalid" {
  let found: Strip | null = null;
  for (const row of header) {
    const text = lineText(lines[row]!).trim();
    if (text.startsWith("←")) {
      if (found !== null) return "invalid";
      const chips = boxedChips(text);
      if (chips === null) return "invalid";
      // The current chip is a background colour and nothing else, so a plain read leaves every chip
      // unmarked and the reader names the page another way (`detectPiQuestion`, `readSubmitPage`).
      if (!plain && !markCurrentByBackground(lines[row]!, chips)) return "invalid";
      found = { row, chips };
      continue;
    }
    const tokens = text.split(/\s{2,}/);
    if (tokens.length >= 2 && tokens.at(-1) === "Submit" && tokens[0]!.startsWith("→ ")) {
      if (found !== null) return "invalid";
      const chips: Chip[] = tokens.map((tok, i) => {
        const current = tok.startsWith("→ ");
        return {
          label: current ? tok.slice(2) : tok,
          answered: false,
          current,
          submit: i === tokens.length - 1,
        };
      });
      if (chips.filter((c) => c.current).length !== 1 || chips.some((c) => c.label.trim() === "")) return "invalid";
      found = { row, chips };
    }
  }
  return found;
}

/** The chips of a `← … →` strip, or null. */
function boxedChips(text: string): Chip[] | null {
  if (!text.endsWith("→")) return null;
  const tokens = text.slice(1, -1).trim().split(/\s{2,}/);
  const chips: Chip[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const box = /^([□■▢▣])(?: (\S.*))?$/.exec(tok);
    if (box !== null) {
      const label = box[2] ?? tokens[++i];
      if (label === undefined || /^[□■▢▣✓]/.test(label)) return null;
      chips.push({ label, answered: box[1] === "■" || box[1] === "▣", current: false, submit: false });
      continue;
    }
    const submit = /^✓(?: (\S.*))?$/.exec(tok);
    if (submit !== null && i === tokens.length - 1) {
      chips.push({ label: submit[1] ?? "✓", answered: false, current: false, submit: true });
      continue;
    }
    return null;
  }
  if (chips.length < 2 || !chips.at(-1)!.submit) return null;
  return chips;
}

/** Mark the one chip whose text carries a background colour as current. False unless exactly one. */
function markCurrentByBackground(line: StyledLine, chips: Chip[]): boolean {
  const highlighted = line.segments
    .filter((s) => s.bg !== undefined && s.text.trim() !== "")
    .map((s) => s.text.trim());
  if (highlighted.length !== 1) return false;
  const hit = chips.filter((c) => highlighted[0]!.endsWith(c.label) && highlighted[0]!.length <= c.label.length + 3);
  if (hit.length !== 1) return false;
  hit[0]!.current = true;
  return true;
}

/**
 * The Submit page of a tabbed dialog, as a wizard review: the Submit chip is current, every question
 * chip has an answer row, and the screen names Enter as submit (the footer, or `Press Enter to submit`
 * / `Enter to submit` in the body). Anything else, an incomplete page included, stays raw. On a plain
 * read no chip is marked; the caller reaches here only for a page with no option row under the
 * strip, and every question page draws its options, so that page is the Submit page.
 */
function readSubmitPage(frame: PiFrame, header: number[], strip: Strip, signature: string, plain: boolean): PiQuestion | null {
  const { texts, footer } = frame;
  const chips = strip.chips;
  const submitChip = chips.at(-1)!;
  const current = submitChip.current || (plain && chips.every((c) => !c.current));
  if (!current || chips.length < 3) return null;
  const rows = header.filter((r) => r > strip.row && texts[r] !== "").map((r) => texts[r]!.trim());
  const namesSubmit = footer.enter === "submit" || rows.some((t) => /\bEnter to submit$/i.test(t));
  if (!namesSubmit || footer.enter === "other") return null;
  // A title row, one answer row per question chip, in order, then the line that names Enter.
  const questions = chips.slice(0, -1);
  if (rows.length !== questions.length + 2 && rows.length !== questions.length + 1) return null;
  const answerRows = rows.slice(1, 1 + questions.length);
  const answers: WizardAnswer[] = [];
  for (let i = 0; i < questions.length; i++) {
    const answer = readAnswerRow(answerRows[i]!, questions[i]!.label, i + 1);
    if (answer === null) return null;
    answers.push(answer);
  }
  const steps: WizardStepChip[] = questions.map((c) => ({ label: c.label, answered: c.answered, current: false }));
  if (!steps.every((s) => s.answered)) return null;
  const model: WizardModel = {
    phase: "review",
    steps,
    answers,
    incomplete: false,
    submitKeys: ["Enter"],
    cancelKeys: ["Escape"],
    signature,
  };
  if (footer.escapeVerb!.toLowerCase() !== "cancel") model.cancelLabel = capitalise(footer.escapeVerb!);
  return { kind: "wizard", model, startLine: frame.top };
}

/** `Color: Green` (stock) or `1. Auth      OAuth 2.0 / OIDC` (PR 397) for the chip `label`. */
function readAnswerRow(text: string, label: string, n: number): WizardAnswer | null {
  if (text.startsWith(`${label}: `)) {
    const answer = text.slice(label.length + 2).trim();
    return answer === "" ? null : { question: label, answer };
  }
  const numbered = new RegExp(`^${n}\\. ${escapeRegExp(label)} {2,}(\\S.*)$`).exec(text);
  return numbered === null ? null : { question: label, answer: numbered[1]! };
}

/**
 * `signature` with what the pointer's own move changes blanked: the pointer glyph on the pointed row.
 * Plus one clock: OmO's title row counts down (` · 30m` → ` · 29m`, pi--omo-v5130-single-described.txt
 * against pi--omo-v5130-single-other-focused.txt), so a countdown token ending a title row above the
 * strip is blanked here, and only here; `signature` keeps it, so the entry guard still refuses a tap
 * on a screen whose clock moved. A frameless dialog's note rows (what the pointed option does) are
 * blanked too: they follow the pointer.
 */
function coreSignatureOf(
  texts: string[],
  top: number,
  bottom: number,
  pointedRow: number,
  col: 0 | 1,
  header: number[],
  strip: Strip | null,
  noteFrom: number,
  noteTo: number,
): string {
  const titleRows = new Set(strip === null ? [] : header.filter((r) => r < strip.row));
  const out: string[] = [];
  for (let r = top; r <= bottom; r++) {
    let t = texts[r]!;
    if (r === pointedRow) t = `${t.slice(0, col)} ${t.slice(col + 1)}`;
    // A frameless dialog's description paragraph describes the pointed option, so it moves with the
    // pointer (pi--v130-gentle-review-consent-moved.txt); its presence stays, its words do not.
    if (r >= noteFrom && r < noteTo && t !== "") t = "~";
    if (titleRows.has(r)) t = t.replace(/ · (?:\d+m|\d{1,2}:\d{2})$/, " · ~");
    out.push(t);
  }
  return out.join("\n");
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
