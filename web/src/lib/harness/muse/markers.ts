// Shared lexing primitives for the Muse adapter (Muse Code 1.3.0 grammar).
//
// Muse pads every PTY row to full width and opens content rows with a 2-column
// grey gutter, so every matcher here runs on rstripped text and tolerates the
// gutter explicitly. Matching is on SHAPE, never colour: the palette answers
// OSC 10/11 (light/dark/none responders paint different SGR), so any SGR value
// a matcher leaned on would move between installs.
//
// Pure geometry + text predicates only — this module imports nothing from the
// adapter (no chrome, no detectors), so detectors can share the tail locator
// without an import cycle. Types + pure functions.

import { isBlank, lineText, type StyledLine } from "../../blocks";

/** Trailing pad off. Muse pads every row to the terminal width. */
export function rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/** Index of the last non-blank row, or -1 when the buffer holds nothing. */
export function lastNonBlankIndex(texts: string[]): number {
  let i = texts.length - 1;
  while (i >= 0 && isBlank(texts[i]!)) i--;
  return i;
}

// A full-width rule of box-drawing horizontals. The composer's bottom rule spans
// the pane (over a hundred cells on the capture host); 8 is unreachable by any
// shorter run while staying far below any plausible pane width. Never matches
// the Voice rule (it carries a label) or ASCII `---` content (wrong glyph).
const BOTTOM_RULE = /^─{8,}$/;

/** True when the row is the composer's full-width bottom rule. */
export function isBottomRule(text: string): boolean {
  return BOTTOM_RULE.test(rstrip(text));
}

// The `── Voice input (⌥ + v to start) ──…` rule above the composer. Matched on
// SHAPE (rule, non-rule middle, rule), never the label text — the tip may
// rotate while the geometry is what the strip needs. Optional everywhere it is
// used: a session that stops painting it must not lose its composer.
const VOICE_RULE = /^──[^─]+─+$/;

/** True when the row is the titled rule Muse paints above its composer. */
export function isVoiceRule(text: string): boolean {
  return VOICE_RULE.test(rstrip(text));
}

// The statusline (`  muse-spark-1.3 · max · <cwd> · <mode>`): opaque fields the
// adapter never parses, joined by ` · ` separators that ARE structural. The
// leading two spaces are the gutter. Required below the bottom rule so a
// transcript row under an agent-drawn rule cannot pose as chrome.
const STATUSLINE = /^  \S.*·/;

/** True when the row has the Muse statusline's shape (gutter + `·` fields). */
export function isStatusline(text: string): boolean {
  return STATUSLINE.test(rstrip(text));
}

// The composer prompt row: a column-0 `❯` (no gutter — verified on the wire)
// plus whatever the box holds. Submitted `❯` echoes share the shape; position
// (directly heading the run above the bottom rule) is what makes one the box.
const PROMPT_ROW = /^❯ ?(.*)$/;

/** The box's content after the `❯` marker, or null when the row is not one. */
export function promptRowText(text: string): string | null {
  const m = PROMPT_ROW.exec(rstrip(text));
  return m ? m[1]! : null;
}

// A draft continuation: the 2-space-indented wrap rows below the `❯` row. Only
// ever read as part of the located composer run (see locateTail), never
// scanned for — dialog rows share the indentation.
const CONTINUATION_ROW = /^  \S/;

/** True when the row could continue a draft (2-space indent, non-blank). */
export function isContinuationRow(text: string): boolean {
  return CONTINUATION_ROW.test(rstrip(text));
}

// A long draft wraps onto continuation rows below the prompt. Cap is
// defense-in-depth so a stray `❯` cannot pair with an unrelated rule hundreds
// of rows down. Same number as the other adapters.
const MAX_DRAFT_ROWS = 100;

/**
 * Muse's composer tail located at the buffer's end. Every index is into the
 * ORIGINAL `lines` array. Pure geometry: no dialog is consulted here, so a
 * screen whose box is real but covered (a question dialog leaves the bare `❯`
 * under it) still locates — the READY gate (chrome.ts) is what declines it.
 */
export interface MuseTail {
  /** The full-width `─` bottom rule. */
  rule: number;
  /** The statusline directly below it (always the last non-blank row). */
  status: number;
  /** The `❯` prompt row heading the draft run, or null when the tail holds no
   *  box (an approval dialog replaces it; trust is pre-session). The draft run
   *  is `prompt + 1 … rule - 1` (empty when `prompt` is null). */
  prompt: number | null;
  /** The Voice rule directly above the prompt, or null when absent. */
  voice: number | null;
}

/**
 * Locate the composer tail, or null. Bottom-up; every step can only REJECT:
 *
 *     (optional Voice rule)     (d) titled rule, tolerated absent
 *     ❯ <draft…>                (c) the prompt row — may be missing (approval)
 *       <continuations…>        (c) 0..MAX_DRAFT_ROWS indented rows below it
 *     ─────────────────         (a) the bottom rule — the anchor
 *       <statusline>            (b) opaque status row, last non-blank
 *
 * The approval dialog replaces the box but keeps rule + statusline, so (c) is
 * what distinguishes "dialog with chrome" (prompt null) from "composer" — and
 * a screen with no rule at all (trust, plain shell) declines here, not later.
 */
export function locateTail(lines: StyledLine[]): MuseTail | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const status = lastNonBlankIndex(texts);
  if (status < 1) return null;
  if (!isStatusline(texts[status]!)) return null;
  const rule = status - 1;
  if (!isBottomRule(texts[rule]!)) return null;

  // (c) Walk up over draft continuations to the prompt row.
  let i = rule - 1;
  while (i >= 0 && rule - 1 - i < MAX_DRAFT_ROWS && isContinuationRow(texts[i]!)) i--;
  // A prompt row heading the run — or null when continuation-shaped rows (an approval option run)
  // or nothing sits above the rule. Either way the tail chrome below stays real; only the box is
  // absent.
  const prompt = i >= 0 && promptRowText(texts[i]!) !== null ? i : null;

  // (d) The Voice rule directly above the prompt (or above the rule when the
  // box is missing — the approval geometry).
  const above = prompt ?? rule;
  const voice = above > 0 && isVoiceRule(texts[above - 1]!) ? above - 1 : null;

  return { rule, status, prompt, voice };
}

// Either pointer glyph Muse paints: `›` on approval/question/checkbox rows,
// ASCII `>` on trust/review rows. Matched as text — the red bold SGR moves per
// responder (and the light responder's red differs from dark's).
const POINTER = "[›>]";

// A numbered option row: optional pointer, `N.`, the label. Matched on the LEFT-TRIMMED row:
// the indentation carries no meaning (gutter + pointer-or-indent arrange 0–4 leading spaces — an
// unpointed `    2. Green` and a pointed `  › 1. Red` are the same row with and without the glyph),
// while the pointer glyph itself survives the trim. Shared by approval, single-select and checkbox
// rows (the checkbox prefix is part of the label here and parsed off by the checkbox grammar). The
// literal dot is what separates a real option from trust's `N  Label` two-space form.
const NUMBERED_OPTION = new RegExp(`^(?:${POINTER}\\s*)?(\\d+)\\.\\s+(.+)$`);

/** Parse `› N. Label` / `N. Label` into its number + label, or null. */
export function parseNumberedOption(text: string): { n: number; label: string } | null {
  const m = NUMBERED_OPTION.exec(rstrip(text).trimStart());
  if (!m) return null;
  return { n: Number(m[1]), label: m[2]!.trim() };
}

// Trust's option form: `N` + two (or more) spaces + label, NO period — unlike
// every other Muse dialog. The `\s{2,}` both requires the gap and excludes the
// `N.` form (a period is not whitespace). Trimmed like the numbered form.
const TRUST_OPTION = /^(?:>\s*)?(\d+)\s{2,}(\S.*)$/;

/** Parse `> N  Label` / `N  Label` (trust's period-less form), or null. */
export function parseTrustOption(text: string): { n: number; label: string } | null {
  const m = TRUST_OPTION.exec(rstrip(text).trimStart());
  if (!m) return null;
  return { n: Number(m[1]), label: m[2]!.trim() };
}

// The checkbox advance row: numbered like an option, so the digit floats with
// the option count (5 on toppings, 4 on drinks — never assumed). Trimmed like options.
const SUBMIT_ROW = new RegExp(`^(?:${POINTER}\\s*)?(\\d+)\\.\\s+Submit answer \\((\\d+) checked\\)$`);

/** Parse `N. Submit answer (K checked)` into its digit + count, or null. */
export function parseSubmitRow(text: string): { n: number; checked: number } | null {
  const m = SUBMIT_ROW.exec(rstrip(text).trimStart());
  if (!m) return null;
  return { n: Number(m[1]), checked: Number(m[2]) };
}

// A lifted menu's rows must be CONTIGUOUS screen rows. trailingMenuRows takes a numeric suffix,
// which would otherwise fuse a transcript numbered list sitting above the menu into it whenever the
// numbering happens to continue (transcript 1,2 + menu 3,4 reads as one run) — and the fused rows
// would carry wrong buttons. Every Muse menu in the corpus is gapless; a torn blank inside one
// declines for a poll (fail-closed transient), never half-lifts.
export function menuRowsContiguous<T extends { index: number }>(menu: T[]): boolean {
  return menu.every((row, k) => k === 0 || row.index === menu[k - 1]!.index + 1);
}

// Dialog footers wrap mid-phrase at narrower widths (`Esc to` / `interrupt`), so the footer is read
// as a short RUN of rows, never one row. More rows than this above the chrome is a layout we don't
// know. (Observed: one row on single-select, two on checkbox.)
const MAX_FOOTER_ROWS = 3;

/** The footer run directly above the tail chrome (`top` = voice ?? prompt ?? rule): its start
 *  and end rows plus the rows joined with a space (a wrap seam is a word space). Null when no
 *  non-blank run sits there, or when the run is unbounded above (it swallowed option rows through a
 *  torn frame — the join would match a fragment). Callers classify the join by their lead string. */
export function footerAboveChrome(
  texts: string[],
  top: number,
): { start: number; end: number; joined: string } | null {
  let fi = top - 1;
  while (fi >= 0 && texts[fi]!.trim() === "") fi--;
  if (fi < 0) return null;
  let start = fi;
  while (start - 1 >= 0 && texts[start - 1]!.trim() !== "" && fi - (start - 1) < MAX_FOOTER_ROWS) {
    start--;
  }
  if (start - 1 >= 0 && texts[start - 1]!.trim() !== "") return null;
  const joined = texts
    .slice(start, fi + 1)
    .map((t) => t.trim())
    .join(" ");
  return { start, end: fi, joined };
}

// The live header sits just above its question; bound the upward search so it can't wander into
// unrelated history.
const HEADER_SCAN_LIMIT = 12;

/** The first row of the tail chrome (Voice rule when present, else prompt, else rule): the line
 *  above which a live dialog must sit. One definition — three detectors share the anchor. */
export function chromeTop(tail: MuseTail): number {
  return tail.voice ?? tail.prompt ?? tail.rule;
}

/** The live `Request user input` header above `firstOpt` plus the structural question between them:
 *  the header is REQUIRED (proof of a live dialog — a coincidental shape has none), and the question
 *  is the non-blank run under it (agent-authored prose that may or may not carry a "?", so located
 *  structurally, never by punctuation). Null when either is missing. */
export function headerAndQuestion(
  texts: string[],
  firstOpt: number,
): { question: string; questionAt: number } | null {
  let hi = -1;
  const top = Math.max(0, firstOpt - HEADER_SCAN_LIMIT);
  for (let i = firstOpt - 1; i >= top; i--) {
    if (isAskHeader(texts[i]!)) {
      hi = i;
      break;
    }
  }
  if (hi < 0) return null;
  const rows: number[] = [];
  for (let i = hi + 1; i < firstOpt; i++) {
    if (texts[i]!.trim() !== "") rows.push(i);
  }
  if (rows.length === 0) return null;
  const question = rows
    .map((i) => texts[i]!.trim())
    .join(" ")
    .trim();
  if (question.length === 0) return null;
  return { question, questionAt: rows[0]! };
}

// The inline note input's row (`      Note (optional): …`). Its PRESENCE is the
// whole signal: the row opens without moving the pointer or changing the
// footer, and while it is open every digit types into it (probed). Any lift
// declines a region containing one.
const NOTE_ROW = /Note \(optional\):/;

/** True when the row is the dialog's inline note input (keyboard owner). */
export function isNoteRow(text: string): boolean {
  return NOTE_ROW.test(text);
}

// The live header above a question (`◇ Request user input Color — running
// (22s)`). Anchors detection; the timer + spinner frames mean it must NEVER
// enter a signature or a bridge-bound region.
const ASK_HEADER = /[◇◆◈]\s+Request user input\b.*— running/;

/** True when the row is a question dialog's live header. */
export function isAskHeader(text: string): boolean {
  return ASK_HEADER.test(text);
}

// A dialog's region signature: the lines [`from` … `to`], joined. Pure of the buffer's own offset,
// so the frozen model and a fresh re-derivation of the SAME dialog produce equal strings — which is
// what the race guards compare. Mirrors Claude's regionSignature (adapters stay self-contained; no
// cross-adapter imports): the lookback is the CALLER's policy, not the signature's.
export function regionSignature(texts: string[], from: number, to: number): string {
  return texts.slice(Math.max(0, from), to + 1).join("\n");
}

// A dialog's menu is the maximal SUFFIX of the collected rows reading 1,2,…,m; stray numbered lines
// from the dialog body sit ABOVE it and are excluded. Walk up from the last row while each is exactly
// one less than the row below, then require the run to start at 1. Empty when the tail isn't a real
// menu (first number ≠ 1). Mirrors Claude's trailingMenuRows (same no-cross-import rule); generic
// over the grammars' row shapes (both carry `n`).
export function trailingMenuRows<T extends { n: number }>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  let s = rows.length - 1;
  while (s > 0 && rows[s - 1]!.n === rows[s]!.n - 1) s--;
  return rows[s]!.n === 1 ? rows.slice(s) : [];
}

// Text Muse draws on the "❯" prompt line that is NOT a real user draft — the tip it paints when the
// box is otherwise empty (observed after the first turn; a fresh box is bare). Must never be
// surfaced as a recoverable draft. Kept as a set so more variants can be added without touching the
// extraction logic.
//
// A tip we have not seen reads as a stranded draft: a phantom preview chip plus a pre-clear sweep
// whose keys no-op against non-editable text (Claude's ghost finding, same bargain). Sends still
// verify — typing replaces the tip, so the guard compares against real text either way.
export const INPUT_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "Start a message with ! to run a shell command yourself",
]);

/**
 * True when the composer box at the tail is there and holds no draft: a bare `❯` or the tip, and
 * nothing between it and the bottom rule.
 *
 * A LIFT'S LIVENESS CHECK. A live question or review dialog leaves the bare `❯` under it and owns
 * the keyboard. A dialog only QUOTED in the transcript sits above a box that is still live, and the
 * Enter a lifted button sends would submit whatever the operator typed there. So every question,
 * checkbox and review lift requires this, and a screen that fails it stays raw.
 *
 * It narrows what is LIFTED, never what is REFUSED: `composerReady` still consults the detectors
 * themselves, so a quote above a draft stalls replies rather than letting them type into a dialog.
 */
export function boxHoldsNoDraft(lines: StyledLine[]): boolean {
  const tail = locateTail(lines);
  if (tail === null || tail.prompt === null) return false;
  const texts = lines.map((l) => rstrip(lineText(l)));
  const prompt = promptRowText(texts[tail.prompt]!)?.trim() ?? "";
  if (prompt !== "" && !INPUT_PLACEHOLDERS.has(prompt)) return false;
  for (let i = tail.prompt + 1; i < tail.rule; i++) {
    if (texts[i]!.trim() !== "") return false;
  }
  return true;
}

/**
 * True when the box is STRICTLY bare: a `❯` row holding neither draft nor placeholder tip, with
 * no continuation rows. The send gate's liveness test — stricter than {@link boxHoldsNoDraft} on
 * purpose. A live dialog owns the keyboard, so its box is always bare (probed on 1.3.0: no
 * placeholder while a dialog is up); an idle box usually shows a placeholder tip instead, but a
 * fresh or cleared box is bare too, so an exact quoted question above such a box still refuses
 * the send, a stall, never a keystroke into a dialog. Dialog shapes above a placeholder or draft
 * box are quoted transcript, never a live dialog — so on those screens the send path may type,
 * while a match above a bare box refuses (review additionally needs its live header directly
 * above, as the lift does) (#260).
 */
export function boxIsBare(lines: StyledLine[]): boolean {
  const tail = locateTail(lines);
  if (tail === null || tail.prompt === null) return false;
  const texts = lines.map((l) => rstrip(lineText(l)));
  const prompt = promptRowText(texts[tail.prompt]!)?.trim() ?? "";
  if (prompt !== "") return false;
  for (let i = tail.prompt + 1; i < tail.rule; i++) {
    if (texts[i]!.trim() !== "") return false;
  }
  return true;
}

/**
 * True when the nearest non-blank row above `row` is a live `Request user input … — running`
 * header. The review screen's lift requires it: its own rows (`> Submit answers`, `Interrupt turn`)
 * are short, fixed and easy to quote, and the header's `— running` is what only a live dialog shows.
 */
export function askHeaderDirectlyAbove(texts: string[], row: number): boolean {
  let i = row - 1;
  while (i >= 0 && texts[i]!.trim() === "") i--;
  return i >= 0 && isAskHeader(texts[i]!);
}
