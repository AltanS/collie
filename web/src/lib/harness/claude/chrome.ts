// Chrome stripping — trims the agent's own TUI chrome off the TAIL of a parsed buffer so the app's
// composer/statusline supersedes it instead of duplicating it. Today that's the Claude Code input
// box (the "❯ …" prompt line sandwiched between two rules) plus the statusline / hint lines below it
// and any trailing blank runs.
//
// Deliberately CONSERVATIVE: it strips only when the WHOLE input-box frame matches confidently at
// the tail, never removes content above it, and leaves rows below the box it cannot name on the
// mirror — when unsure it returns the buffer untouched (the T1 raw-mirror fallback). Pure; operates on parsed line text, so a user-configured statusline is
// matched by POSITION (below the box's bottom border), never by its content strings.

import type { StyledLine } from "../../blocks";
import { namesAMenuKey } from "../menu-hints";
import { findAutocompleteRun, MAX_AUTOCOMPLETE_LINES } from "./autocomplete";
import {
  classifyFooter,
  isBareBoxBorder,
  isBlank,
  isBoxBorder,
  isHorizontalRule,
  isInputBoxTopBorder,
  isMultiStepHeader,
  lineText,
} from "./markers";
import { detectMultiSelectRegion } from "./multi-select";
import { detectPreviewSelectRegion } from "./preview-select";
import { detectPromptSelectRegion } from "./prompt-select";
import { detectWizardRegion } from "./wizard";

// Rows the view strips DIRECTLY under the input box's bottom border as a statusline: the statusline
// plus its hint row(s) ("← for agents", "⏵⏵ bypass permissions on …"). A statusline is an arbitrary
// user command's output, so this run is as tall as the user made it. The ceiling bounds only what is
// stripped and re-surfaced as a statusline, and mirrors MAX_FOOTER_LINES (ADR 0004). It no longer
// decides whether the box exists: a taller run is an `unknown` tail that stays on the mirror, and the
// send path still sees the box (ADR 0048).
const MAX_STATUS_LINES = 8;

// A newer Claude Code UI paints a "background agents" footer BELOW the statusline/hint, separated from
// them by a blank line: a bold "● main" header and one row per background agent
// ("◯ <agent>  <task…>   <elapsed> · ↓ <tokens>"). We peel it off the tail as chrome too, bounded to
// this many rows (header + a handful of agents, plus a possible "… +N more" line) so a borderless
// buffer still can't strip unboundedly — an over-long block just falls back to the raw mirror.
const MAX_FOOTER_LINES = 8;

// A long draft WRAPS inside the input box: the "❯ …" prompt line plus continuation lines (indented,
// no leading "❯") before the bottom border. We scan up past those to find the prompt, bounded by
// MAX_DRAFT_LINES — but as DEFENSE-IN-DEPTH, not a correctness bound. The caller's read window
// defaults to 200 lines (COLLIE_READ_LINES, bridge/config.ts) and is client-requestable up to
// MAX_READ_LINES (10,000, bridge/server.ts), so an unbounded walk would let a stray line that happens
// to look like a border (see isBoxBorder in markers.ts) pair up with an unrelated quoted "❯" line
// dozens (or thousands) of lines further up to complete a full (bogus) box shape — the cap, not the
// border test alone, is what keeps that match from reaching all the way there. Every line the walk
// crosses counts against this cap, blank or not: a run of blank padding is not a free pass either
// (see the blank-line skips inside locateInputBox below, both bounded by the same counter). The OLD
// cap (12) was simply too tight: a real 610-char/25-line CJK draft wraps to ~40 rows at a narrow
// pane's column count (CJK glyphs are 2 cells wide), well past it, which made locateInputBox return
// null and stalled the send guard for good (issue #76). Removing the cap entirely was considered and
// rejected for the reason above. 100 comfortably covers the observed ~40-row case plus a worst case
// around 70–80 rows at a 19-column pane, with margin, while still capping how far the walk can reach.
const MAX_DRAFT_LINES = 100;

// Text Claude draws on the "❯" prompt line that is NOT a real user draft — it's a hint the TUI paints
// when the box is otherwise empty. Must never be surfaced as a recoverable draft. Kept as a set so
// more variants can be added without touching the extraction logic.
const INPUT_PLACEHOLDERS = new Set(["Press up to edit queued messages"]);

/**
 * GHOST TEXT — the generated "suggested next prompt" a newer Claude Code paints inside an otherwise
 * empty input box (a whole plausible message: "fix it", "run the tests", …). It is NOT a draft: it is
 * a suggestion the operator has not written and, until they act on it, the box is empty.
 *
 * Content cannot tell the two apart — the suggestion is arbitrary generated prose and changes every
 * turn, so INPUT_PLACEHOLDERS (which knows one fixed literal) can never grow to cover it. STYLE can.
 * Measured on a live Claude Code v2.1.235 pane through the bridge (2026-08-19): the prompt line comes
 * over the wire as
 *
 *     ❯ \x1b[0m\x1b[2mfix it\x1b[0m
 *
 * — the suggestion is a run of SGR 2 (faint) with no colour of its own, while the "❯" marker and every
 * real draft on the same line carry no SGR at all (`dim: false`). Typing replaces the suggestion
 * outright, so a box never holds both at once; that is what makes "EVERY visible run is faint" sound
 * as the whole-box test rather than a per-run one.
 *
 * Three consequences follow from misreading one as a draft, and all three are fixed by classifying it
 * here, at the single place a draft is derived (lib/reply-action.ts and composer.tsx both take their
 * draft from `extractInputDraft`, so neither needs its own ghost test):
 *
 *  1. the app offered to "recover" a stranded draft the operator never wrote;
 *  2. the composer's pre-clear sweep fired `ctrl+k` + a burst of Backspaces at it — and the ghost is
 *     not editable text, so it clears NOTHING (verified live: after a full sweep the same faint run is
 *     still on the line). Destructive keys, no effect, every send;
 *  3. worst, it could VOUCH FOR A SEND THAT NEVER LANDED. `draftCarriesSend` accepts a draft whose
 *     visible characters appear contiguously in the sent text, so a suggestion that happens to be an
 *     8-character substring of the message ("fix the parser…" vs a ghost "fix the ") would satisfy the
 *     guard against a box our text never reached — Collie then fires the submit key and reports
 *     `sent`, and the message is lost. Returning null here keeps a ghost out of that comparison
 *     entirely, which is the defense in depth: the guard never sees a ghost to be fooled by.
 *
 * A false POSITIVE is survivable in the one direction that matters: if a genuine draft were ever
 * painted faint we would neither preview nor sweep it, `pane.send_text` would append to it, and the
 * appended line would then fail `draftCarriesSend` — the send stalls with nothing submitted, which is
 * this module's designed failure mode. A false NEGATIVE (treating a ghost as a draft) is the bug above.
 *
 * `hasInputBox`/`composerReady` deliberately do NOT consult this: a box holding ghost text is a real,
 * typeable box, and refusing to type into it would break every send after the first turn.
 */
function inputBoxHoldsGhostText(lines: StyledLine[], box: InputBox): boolean {
  let sawContent = false;
  for (let j = box.prompt; j < box.bottomBorder; j++) {
    // The "❯" marker is unstyled and may share a segment with the text that follows it (a real draft
    // arrives as one segment, "❯ hello"), so it is stripped from the text rather than skipped as a
    // segment — otherwise the marker's own non-faint run would answer "not a ghost" every time.
    let beforeMarker = j === box.prompt;
    for (const seg of lines[j]!.segments) {
      let text = seg.text;
      if (beforeMarker) {
        const head = text.trimStart();
        if (!head.startsWith("❯")) {
          if (head.length === 0) continue; // indent ahead of the marker
        } else {
          text = head.slice(1);
          beforeMarker = false;
        }
      }
      if (text.trim().length === 0) continue;
      if (seg.dim !== true) return false;
      sawContent = true;
    }
  }
  return sawContent;
}

/**
 * Return `lines` with any confidently-matched trailing chrome removed. When nothing matches the
 * input is returned as-is (same reference), so callers can treat an unchanged result as "no chrome".
 *
 * Only CLASSIFIED chrome is removed. The box itself always goes (the composer supersedes it), and so
 * does a tail below it that is a statusline run or a completion popup. A tail nothing classifies
 * (`unknown`) stays on the mirror, below the transcript, exactly as the terminal shows it: the send
 * path may trust the box above it (see locateInputBox), but the view does not pretend to know what
 * those rows are.
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length; // exclusive bound of the kept range

  // 1. Drop a trailing run of blank lines.
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  // 2. Peel the input box off the tail if the full shape is present. Only then; otherwise the
  //    blank-trim above is the sole (safe) change.
  const box = locateInputBox(lines, texts, end);
  if (box === null) return end === lines.length ? lines : lines.slice(0, end);

  // Drop the blank run now exposed above the box (a fresh session has an empty body above it).
  let above = box.top;
  while (above > 0 && isBlank(texts[above - 1]!)) above--;
  if (box.tail === "unknown") return [...lines.slice(0, above), ...lines.slice(box.bottomBorder + 1, end)];
  return lines.slice(0, above);
}

/**
 * The statusline RUN the agent draws just under its input box — model, ctx%, cwd, branch, tokens,
 * permission mode, whatever the user configured, plus the TUI's own hint row(s). We strip the box
 * off the mirror (stripChrome), so this re-surfaces those rows as app chrome above the composer
 * instead of losing them.
 *
 * ALL of them, not just the first: a statusline is an arbitrary user command's output and is
 * routinely 2–3 rows (ctx/limits on one, model + cwd + branch on the next, permission mode on the
 * third). Surfacing only the first row silently dropped everything after it — the very fields the
 * mirror can no longer show.
 *
 * POSITIONAL only: every non-blank line strictly below the box's bottom border and above where the
 * background-agents footer starts (locateInputBox draws that line, so the footer never leaks in
 * here). Returns the rows STYLED, top to bottom, or `[]` when there's no input box at the tail (a
 * menu is up, or a non-Claude / torn buffer), or when the rows under the box are not a statusline
 * run (a completion popup, or an `unknown` tail, which stays on the mirror instead). Never interprets
 * the content — the caller renders it verbatim.
 *
 * Styled, not flattened, because a statusline is colour-carrying by design: the model, the context
 * meter and the git branch are told apart by colour before they're read. Flattening to text here
 * threw that away one call before the strip that renders it. The caller draws these in the mirror's
 * dark space (see mirror-space.ts) — terminal colour only means what it means against a dark
 * background.
 */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return [];

  const box = locateInputBox(lines, texts, end);
  if (box === null) return [];

  const rows: StyledLine[] = [];
  for (let j = box.bottomBorder + 1; j < box.statusEnd; j++) {
    if (!isBlank(texts[j]!)) rows.push(lines[j]!);
  }
  return rows;
}

/**
 * The user's draft text stranded on the input box's "❯" prompt line. When a message is queued while
 * the agent is busy and then recalled (Up/Esc), the text lands here and persists across turns — but
 * stripChrome peels the whole box off the mirror, so it becomes invisible, and the composer (local
 * state only) never learns of it. This re-surfaces it so the app can offer to recover it.
 *
 * Reads the prompt line found by locateInputBox: drop the leading "❯" marker and its separator space
 * (Claude renders a U+00A0 there, which JS trim() strips), then trim. A draft too long for one line
 * WRAPS onto continuation lines inside the box; those are folded back in (each trimmed of its
 * alignment indent, joined with a single space — Claude soft-wraps at word boundaries, so the dropped
 * break was a space). Returns `null` when there's no input box at the tail, the box is empty (bare
 * "❯"), the box holds GHOST TEXT (a generated suggestion — see inputBoxHoldsGhostText), or the line is
 * a known TUI placeholder (INPUT_PLACEHOLDERS) rather than a real draft.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;

  const box = locateInputBox(lines, texts, end);
  if (box === null) return null;
  // Style first, content second: a generated suggestion is arbitrary prose, so only how it is PAINTED
  // separates it from a draft (see inputBoxHoldsGhostText).
  if (inputBoxHoldsGhostText(lines, box)) return null;

  let head = texts[box.prompt]!.trimStart();
  if (head.startsWith("❯")) head = head.slice(1);
  const parts = [head.trim()];
  // Continuation lines of a wrapped draft: everything between the prompt and the bottom border,
  // de-indented. Blank lines are dropped (interior/trailing padding), so they never inject a space.
  for (let j = box.prompt + 1; j < box.bottomBorder; j++) {
    const t = texts[j]!.trim();
    if (t.length > 0) parts.push(t);
  }
  const draft = parts.join(" ").trim();
  if (draft.length === 0 || INPUT_PLACEHOLDERS.has(draft)) return null;
  return draft;
}

/**
 * Whether the agent's own free-text input box is on screen at the tail — i.e. whether typing a reply
 * would land in the composer input at all. FALSE means a modal (a menu, a dialog, a full-screen
 * picker) owns the keyboard, so `pane.send_text` would be typed INTO it.
 *
 * Two callers, both of which need exactly this and must not re-derive it:
 *  - the generic menu grammar (menu.ts), whose last-resort footer match would otherwise claim an
 *    ordinary prompt screen that happens to end in a `·`-separated hint row;
 *  - the reply path's pre-flight (lib/reply-action.ts via the adapter's `composerReady`), which
 *    refuses to type at all when the box isn't there.
 */
export function hasInputBox(lines: StyledLine[]): boolean {
  return inputBoxTail(lines) !== null;
}

/**
 * What sits under the input box's bottom border, or null when there is no input box. The block
 * pipeline (index.ts) lifts a completion popup into its own block only when this says `autocomplete`:
 * a popup-shaped run under a box whose draft is not a slash command is an `unknown` tail, and it stays
 * raw.
 */
export function inputBoxTail(lines: StyledLine[]): InputBoxTail | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;
  return locateInputBox(lines, texts, end)?.tail ?? null;
}

/**
 * The rows under the bottom border, labelled:
 *  - `statusline`: the bounded statusline + hint run, with the optional background-agents footer
 *    (MAX_STATUS_LINES / MAX_FOOTER_LINES, ADR 0004), or no rows at all;
 *  - `autocomplete`: Claude's completion popup (./autocomplete.ts) under a slash-command draft;
 *  - `unknown`: anything else that passed locateInputBox's modal checks.
 */
export type InputBoxTail = "statusline" | "autocomplete" | "unknown";

interface InputBox {
  /** Index of the TOP border — the exclusive bound of everything ABOVE the box (stripChrome uses it). */
  top: number;
  /** Index of the "❯" prompt line, between the two borders — carries the draft (extractInputDraft). */
  prompt: number;
  /** Index of the BOTTOM border — the tail, if any, starts on the next line. */
  bottomBorder: number;
  /** What the rows from `bottomBorder + 1` to the last non-blank line are (classifyTail). */
  tail: InputBoxTail;
  /** EXCLUSIVE end of the statusline run: one past its last row, i.e. where the blank separator +
   *  background-agents footer begin (or the buffer's last non-blank line when there is no footer).
   *  `bottomBorder + 1` when the tail is not a statusline, or the box has no statusline at all. Only
   *  the walk down there knows where the run stops, so it hands the bound out rather than letting
   *  extractStatusLines re-derive it. */
  statusEnd: number;
}

// How many rows may sit between the bottom border and the last non-blank line — the search bound
// for the box (constraint: the box sits in the screen's final region). It is the popup's own cap,
// MAX_AUTOCOMPLETE_LINES (60), because the popup is the tallest thing Claude paints under a live box:
// the old statusline walk reached at most MAX_STATUS_LINES + a blank + MAX_FOOTER_LINES (17 rows), and
// the popup peel reached 60 more rows on top of the same border. So 60 covers every tail the old
// locator could accept, and a box further up than that is not the live one. The number buys no
// safety on its own; the modal checks below do (ADR 0048).
const MAX_TAIL_LINES = MAX_AUTOCOMPLETE_LINES;

/**
 * Find the input box by ITS OWN FRAME, then account for everything below it. Returns null unless all
 * of this holds, checked in order:
 *
 *     <top border>         (isInputBoxTopBorder: bare, or carrying a session label)
 *     ❯ <draft>            (the prompt line)
 *     <continuation…>      (0..MAX_DRAFT_LINES wrapped-draft lines, no leading "❯")
 *     <bottom border>      (bare U+2500 rule)
 *     <tail…>              (0..MAX_TAIL_LINES rows, classified by classifyTail)
 *
 *  1. THE LOWEST FRAME MARK IS THE BOTTOM BORDER. Walking up from the last non-blank line, the first
 *     row that is a box border, a top-border-shaped rule or a "❯"-led line must be a bare border, and
 *     it must come within MAX_TAIL_LINES rows. So the box is the lowest box-shaped triple on screen,
 *     and its tail holds no border, no rule shaped like a top border and no "❯" prompt line — a
 *     select dialog's "❯ 1. Yes" row, or a second box, stops the walk before any border is reached.
 *     One exception, for a statusline that draws such a row itself (a starship-style "❯ ~/src on
 *     main", a "─ main ───" separator): an un-numbered "❯"-led row or a labelled rule is stepped over
 *     (isStatuslineFrameMark), but the box is then kept only when every such row sits inside a
 *     `statusline` tail's run, at most MAX_STATUS_LINES rows under the border, and no labelled rule
 *     sits directly on a "❯" row (a second box's top border and prompt).
 *  2. THE FRAME CLOSES: a "❯" line above the bottom border and a top border above that, inside the
 *     shared MAX_DRAFT_LINES budget.
 *  3. THE TAIL IS ACCOUNTED FOR (classifyTail): a statusline run, a completion popup, or `unknown`.
 *  4. NO MODAL IS ON SCREEN: every specific dialog grammar runs over the WHOLE screen, and none may
 *     claim it; no tail row may carry a dialog footer; no `statusline` or `unknown` tail row may carry
 *     a numbered option or a "<key> to <verb>" hint (tailNamesAMenu); an `unknown` tail may also carry
 *     no pointer glyph, rule or stepper header (tailLooksModal). An echoed box higher up with a live
 *     dialog below it is refused when the dialog paints one of those marks in the tail, or a grammar
 *     claims it. A dialog with none of them under a stale box is not refused (ADR 0048).
 *
 * Why the frame and not the old bottom-up walk: that walk had to CROSS the tail to reach the border,
 * with a row budget (MAX_STATUS_LINES), so anything below the box it could not name (a completion
 * popup whose command names Claude clipped with "…", say) hid a live box and stalled every send.
 * The budget still bounds what the VIEW strips as a statusline; it no longer decides whether the box
 * exists (ADR 0048, amending ADR 0004).
 *
 * The generic menu grammar (menu.ts) cannot run here, because it asks this function first. What it
 * claims is covered by its footer instead: the grammar claims a screen only when a footer row names
 * keys, and tailNamesAMenu refuses that row in a `statusline` or `unknown` tail. Its rule under the
 * region's top adds a second refusal: step 1 stops there when the rule is a bare border, and
 * tailLooksModal refuses any other rule in an `unknown` tail (a `statusline` tail is exempt from it).
 * A popup tail is not checked, but a popup is only named under a slash-command draft.
 */
function locateInputBox(lines: StyledLine[], texts: string[], end: number): InputBox | null {
  // 1. The lowest frame mark, within the tail bound. A mark a statusline may draw is stepped over and
  //    remembered; it is judged once the tail is labelled (below).
  let b = end - 1;
  const stepped: number[] = [];
  while (b >= 0) {
    const text = texts[b]!;
    if (isFrameMark(text)) {
      if (isBareBoxBorder(text)) break;
      if (!isStatuslineFrameMark(text)) return null;
      stepped.push(b);
    }
    if (end - 1 - b >= MAX_TAIL_LINES) return null;
    b--;
  }
  if (b < 0) return null;

  // 2. The frame closes above it.
  const frame = walkFrame(texts, b);
  if (frame === null) return null;

  // 3. The tail is accounted for.
  const { tail, statusEnd } = classifyTail(texts, { prompt: frame.prompt, bottomBorder: b }, end);
  if (!steppedMarksAreStatusline(texts, stepped, tail, b, statusEnd)) return null;

  // 4. No modal on screen.
  for (let j = b + 1; j < end; j++) {
    if (classifyFooter(texts[j]!) !== null) return null;
    if (tail !== "autocomplete" && tailNamesAMenu(texts[j]!)) return null;
    if (tail === "unknown" && tailLooksModal(texts[j]!)) return null;
  }
  if (dialogOnScreen(lines)) return null;

  return { top: frame.top, prompt: frame.prompt, bottomBorder: b, tail, statusEnd };
}

/** A row that belongs to a box or a dialog's frame, unless a statusline drew it (isStatuslineFrameMark):
 *  a border, a top-border-shaped rule, or a "❯"-led line (a prompt, or a select dialog's pointer row). */
function isFrameMark(text: string): boolean {
  const head = text.trimStart();
  // Every border shape opens with U+2500, so the display-width measurement is only paid for rows that do.
  return head.startsWith("❯") || (head.startsWith("─") && isInputBoxTopBorder(text));
}

// An option row the way Claude's dialogs number them ("1. Yes", "❯ 2. No, and tell Claude…").
const NUMBERED_OPTION_ROW = /^\s*(?:❯\s*)?\d+\.\s+\S/;

/** A frame mark a statusline may draw itself: a "❯"-led row that is not a numbered option (a
 *  starship-style prompt), or a labelled rule (a "─ main ───" separator). Never a bare border. */
function isStatuslineFrameMark(text: string): boolean {
  if (text.trimStart().startsWith("❯")) return !NUMBERED_OPTION_ROW.test(text);
  return !isBareBoxBorder(text) && isInputBoxTopBorder(text);
}

/**
 * Whether the marks step 1 stepped over (`stepped`, bottom-up) all belong to the statusline run: the
 * tail is `statusline`, each mark sits inside its run (`bottomBorder + 1` to `statusEnd`) and at most
 * MAX_STATUS_LINES rows under the border, and no labelled rule sits directly on a "❯" row, the shape
 * of a second box's top border and prompt. True when nothing was stepped over.
 */
function steppedMarksAreStatusline(
  texts: string[],
  stepped: number[],
  tail: InputBoxTail,
  bottomBorder: number,
  statusEnd: number,
): boolean {
  if (stepped.length === 0) return true;
  if (tail !== "statusline") return false;
  for (const j of stepped) {
    if (j >= statusEnd || j - bottomBorder > MAX_STATUS_LINES) return false;
    const below = texts[j + 1];
    if (!texts[j]!.trimStart().startsWith("❯") && below !== undefined && below.trimStart().startsWith("❯")) {
      return false;
    }
  }
  return true;
}

/** Whether a tail row names a menu: a numbered option or a "<key> to <verb>" hint. Checked over a
 *  `statusline` tail as well as an `unknown` one: a dialog under a stale box can fit the statusline
 *  walk (its footer split off by a blank, like the background-agents footer), and only these rows
 *  tell it apart. A popup tail is exempt, because its grammar named every row. */
function tailNamesAMenu(text: string): boolean {
  return NUMBERED_OPTION_ROW.test(text) || namesAMenuKey(text);
}

/**
 * Whether a row of an `unknown` tail carries something else a modal paints: a pointer glyph anywhere,
 * a rule, or a stepper header (tailNamesAMenu covers numbered options and key hints for it too). A
 * statusline tail is exempt from these marks, because a statusline may draw a "❯" or a rule itself;
 * an `unknown` tail is trusted only when it looks like nothing a dialog draws. False refusals here
 * cost a stalled send, which is this module's designed failure mode; a false accept types into a modal.
 */
function tailLooksModal(text: string): boolean {
  return text.includes("❯") || isHorizontalRule(text) || isMultiStepHeader(text);
}

/** Whether any of Claude's specific dialog grammars claims the screen. Each is tail-anchored on its
 *  own footer and reads the full screen, independent of where this module thinks the box is. */
function dialogOnScreen(lines: StyledLine[]): boolean {
  return (
    detectPreviewSelectRegion(lines) !== null ||
    detectWizardRegion(lines) !== null ||
    detectMultiSelectRegion(lines) !== null ||
    detectPromptSelectRegion(lines) !== null
  );
}

/** The part of a box classifyTail reads: where the draft is, and where the tail starts. */
interface TailOwner {
  prompt: number;
  bottomBorder: number;
}

/** classifyTail's answer: the tail's label, and the statusline run's exclusive end (InputBox.statusEnd). */
interface TailReading {
  tail: InputBoxTail;
  statusEnd: number;
}

/**
 * Label the rows between the bottom border and `end` (exclusive; `end - 1` is the last non-blank
 * line). Pure, and it never refuses: refusing is locateInputBox's job. The popup is tried first
 * because a short popup also fits the statusline walk, and its rows must not be surfaced as a
 * statusline.
 */
function classifyTail(texts: string[], box: TailOwner, end: number): TailReading {
  const first = box.bottomBorder + 1;
  if (first >= end) return { tail: "statusline", statusEnd: first };

  // The popup is confirmed, not assumed: Claude paints it only while the draft STARTS WITH "/".
  const popup = findAutocompleteRun(texts, end);
  if (popup !== null && popup.start === first && promptIsSlashCommand(texts, box.prompt)) {
    return { tail: "autocomplete", statusEnd: first };
  }

  const statusEnd = walkStatusline(texts, box.bottomBorder, end);
  if (statusEnd !== null) return { tail: "statusline", statusEnd };
  return { tail: "unknown", statusEnd: first };
}

/** Whether the "❯" line holds a slash command — the draft state that puts the completion popup on
 *  screen. Claude renders a U+00A0 after the marker, which JS `trim()` strips. */
function promptIsSlashCommand(texts: string[], prompt: number): boolean {
  const head = texts[prompt]!.trimStart();
  return (head.startsWith("❯") ? head.slice(1) : head).trim().startsWith("/");
}

/**
 * The statusline walk, bottom-up from `end` (exclusive): an optional background-agents footer and its
 * blank separator, then up to MAX_STATUS_LINES status/hint rows. Returns the run's exclusive end when
 * the walk lands exactly on `bottomBorder`, else null.
 *
 *     <bottom border>
 *     <statusline>         (statusline + hint rows together are 0..MAX_STATUS_LINES, by position)
 *     <hint line>
 *     <blank>              (optional — separates the background-agents footer, if present)
 *     <● main>             (0..MAX_FOOTER_LINES footer lines, matched by position not content)
 *     <◯ agent …>
 */
function walkStatusline(texts: string[], bottomBorder: number, end: number): number | null {
  let i = end - 1;

  // (a) Optional background-agents footer at the very tail (a newer Claude Code UI): a non-blank run
  //     ("● main" header + "◯ …" agent rows) divided from the statusline/hint by a blank line. Matched
  //     by POSITION, never content, and peeled only when that blank separator is found within the
  //     bound — otherwise the run we just walked IS the statusline+hint, so leave it for step (b).
  {
    let j = i;
    let footer = 0;
    while (j > bottomBorder && !isBlank(texts[j]!) && footer < MAX_FOOTER_LINES) {
      footer++;
      j--;
    }
    if (footer > 0 && j > bottomBorder && isBlank(texts[j]!)) {
      while (j > bottomBorder && isBlank(texts[j]!)) j--; // consume the blank separator run
      i = j;
    }
  }

  // (b) Up to MAX_STATUS_LINES status/hint lines directly above the bottom border: non-blank text.
  //     `i` is now the last row of that run (the footer, if any, has been peeled off above), so it
  //     fixes the run's exclusive end.
  const statusEnd = i + 1;
  let status = 0;
  while (i > bottomBorder && !isBlank(texts[i]!) && status < MAX_STATUS_LINES) {
    status++;
    i--;
  }
  return i === bottomBorder ? statusEnd : null;
}

/** The frame above a bottom border: the "❯" prompt line and the top border, or null. */
function walkFrame(texts: string[], bottomBorder: number): { top: number; prompt: number } | null {
  let i = bottomBorder - 1;

  // The "❯" prompt line — the FIRST line of the draft. A long draft wraps onto continuation lines
  // (indented, no "❯") between the prompt and the bottom border, so scan up past them to the prompt.
  // Bounded by MAX_DRAFT_LINES (see the comment above — defense-in-depth, not a correctness bound),
  // and any box border en route aborts the match (we'd have left the box). Blank padding is tolerated
  // on either side, but it draws from the SAME budget as real continuation lines — a bare
  // `while (isBlank) i--` here used to skip an unlimited run of blank lines for free before this loop
  // even started counting, which let a wall of blanks stand in for the non-blank filler the draft-walk
  // cap is supposed to bound.
  let wrapped = 0;
  while (
    i >= 0 &&
    !isBoxBorder(texts[i]!) &&
    !texts[i]!.trimStart().startsWith("❯") &&
    wrapped < MAX_DRAFT_LINES
  ) {
    wrapped++;
    i--;
  }
  if (i < 0 || !texts[i]!.trimStart().startsWith("❯")) return null;
  const prompt = i;
  i--;
  // Blank padding between the prompt and the top border (e.g. a blank first line inside a freshly
  // opened box) — same shared `wrapped` budget as above, for the same reason: this used to be its own
  // unbounded `while (isBlank) i--`, so a wall of blanks here could reach an arbitrarily distant top
  // border for free.
  while (i >= 0 && isBlank(texts[i]!) && wrapped < MAX_DRAFT_LINES) {
    wrapped++;
    i--;
  }

  // The top border — the LAST anchor checked, so it alone gets the looser flank floor
  // (isInputBoxTopBorder): the renderer can clamp a labelled top border's flank down to 1 glyph (see
  // the comment on isInputBoxTopBorder in markers.ts), and by this point the bottom border, the "❯"
  // line, and the draft-walk cap have already pinned the rest of the shape down, so the looser test
  // doesn't reopen the false-positive risk a bare 1-glyph flank would elsewhere.
  if (i < 0 || !isInputBoxTopBorder(texts[i]!)) return null;
  return { top: i, prompt };
}
