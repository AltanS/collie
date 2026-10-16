// Chrome stripping — trims the agent's own TUI chrome off the TAIL of a parsed buffer so the app's
// composer/statusline supersedes it instead of duplicating it. Today that's the Claude Code input
// box (the "❯ …" prompt line, or "! …" in shell mode, sandwiched between two rules) plus the
// statusline / hint lines below it
// and any trailing blank runs.
//
// Deliberately CONSERVATIVE: it strips only when the WHOLE input-box frame matches confidently at
// the tail, never removes content above it, and leaves rows below the box it cannot name on the
// mirror — when unsure it returns the buffer untouched (the T1 raw-mirror fallback). Pure; operates on parsed line text, so a user-configured statusline is
// matched by POSITION (below the box's bottom border), never by its content strings.

import type { StyledLine } from "../../blocks";
import { findInputFrame, type Frame } from "../../surface/frame";
import { namesAMenuKey, SEGMENT_SPLIT } from "../menu-hints";
import { findAutocompleteRun } from "./autocomplete";
import {
  CLAUDE_IDLE,
  classifyFooter,
  isBareBoxBorder,
  isBlank,
  isHorizontalRule,
  isInputBoxTopBorder,
  isMultiStepHeader,
  lineText,
  namesPlanDialog,
} from "./markers";
import { detectMultiSelectRegion } from "./multi-select";
import { detectPreviewSelectRegion } from "./preview-select";
import { detectPromptSelectRegion } from "./prompt-select";
import { detectWizardRegion } from "./wizard";

// The input frame itself (the edges, the draft hole, the placeholder and the statusline run under
// the box) is found by the one frame module, `lib/surface/frame.ts`, from the Claude profile's
// `idle` block (M56 spec 03). The bounds that used to live here as constants are profile data now:
// the statusline run is `idle.volatile.below.maxRows` rows (ADR 0004), the background-agents footer
// under it `idle.volatile.below.footerMaxRows`, and the placeholder texts and the faint attribute
// of ghost text are `idle.placeholders`. This module keeps what the frame does not judge: the tail's
// label and every modal check (ADR 0048).

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
 * The background-agents footer ("● main" + one "◯ <agent> <task> <elapsed>" row per agent) that the
 * statusline walk peels off below the blank separator. stripChrome takes it off the mirror and
 * extractStatusLines stops above it, so without this probe the agent list was on no surface at all
 * (issue #242). It gets its own chrome element rather than more rows in the statusline strip: the
 * strip's height cap guards against an operator's script, and this block is Claude's own and already
 * bounded by the profile's `idle.volatile.below.footerMaxRows`.
 *
 * POSITIONAL, like the strip: the rows from where the frame's walk says the footer starts to the last
 * non-blank line, STYLED, top to bottom. `[]` when there is no box, the tail is not a statusline run,
 * or no footer was peeled. One content check: the block must open with Claude's "●" header. The walk
 * peels by position, so a custom statusline with a blank row in it also loses its lower rows there;
 * without the header check those rows would show on the phone labelled as agents.
 */
export function extractAgentsFooter(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return [];

  const box = locateInputBox(lines, texts, end);
  if (box === null || box.tail !== "statusline") return [];

  const rows: StyledLine[] = [];
  for (let j = box.agentsStart; j < end; j++) {
    if (!isBlank(texts[j]!)) rows.push(lines[j]!);
  }
  if (rows.length === 0 || !lineText(rows[0]!).trimStart().startsWith("●")) return [];
  return rows;
}

/**
 * GHOST TEXT is the generated "suggested next prompt" a newer Claude Code paints inside an otherwise
 * empty input box (a whole plausible message: "fix it", "run the tests", …). It is NOT a draft. Measured
 * on a live Claude Code v2.1.235 pane through the bridge (2026-08-19), the prompt line comes over the
 * wire as
 *
 *     ❯ \x1b[0m\x1b[2mfix it\x1b[0m
 *
 * The suggestion is a run of SGR 2 (faint), while the "❯" marker and every real draft carry no SGR at
 * all. Typing replaces the suggestion outright, so a box never holds both at once, which is what makes
 * "EVERY visible run is faint" sound as the whole-box test. The profile names that attribute
 * (`idle.placeholders.sgr`) and the frame module applies it.
 *
 * Misreading ghost text as a draft did three things: the app offered to "recover" a draft the
 * operator never wrote; the composer's pre-clear sweep fired destructive keys at text that is not
 * editable; and, worst, `draftCarriesSend` could vouch for a send that never landed when the
 * suggestion was a substring of the message. Returning null keeps a ghost out of that comparison.
 * A false POSITIVE (a real draft painted faint) only stalls a send, this module's designed failure.
 * `hasInputBox`/`composerReady` deliberately do NOT consult it: a box holding ghost text is a real,
 * typeable box.
 *
 * The user's draft text stranded on the input box's "❯" prompt line. When a message is queued while
 * the agent is busy and then recalled (Up/Esc), the text lands here and persists across turns — but
 * stripChrome peels the whole box off the mirror, so it becomes invisible, and the composer (local
 * state only) never learns of it. This re-surfaces it so the app can offer to recover it.
 *
 * Reads the frame's interior: the hole after the "❯" marker and its separator space (Claude renders a
 * U+00A0 there, which JS trim() strips). A draft too long for one line WRAPS onto continuation lines
 * inside the box; those are folded back in (each trimmed of its alignment indent, joined with a single
 * space, since Claude soft-wraps at word boundaries). Returns `null` when there's no input box at the
 * tail, the box is empty (bare "❯"), or the interior is a placeholder: GHOST TEXT (above) or a known
 * placeholder text from the profile.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;

  const box = locateInputBox(lines, texts, end);
  if (box === null) return null;
  // Style first, content second: ghost text (a generated suggestion) is arbitrary prose, so only how
  // it is PAINTED separates it from a draft. The frame module marks it, and a known placeholder text,
  // as `placeholder`.
  if (box.frame.placeholder) return null;
  // The frame's text is the hole after the marker plus every wrapped row, de-indented and joined with
  // one space. The marker is chrome and never reaches the draft, so shell mode's draft is the command
  // alone. Memory mode keeps its "#": there the marker is still "❯" and the "#" is typed content.
  const draft = box.frame.interior.text;
  return draft.length === 0 ? null : draft;
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
 *    (the profile's `idle.volatile.below` bounds, ADR 0004), or no rows at all;
 *  - `autocomplete`: Claude's completion popup (./autocomplete.ts) under a slash-command draft;
 *  - `unknown`: anything else that passed locateInputBox's modal checks.
 */
export type InputBoxTail = "statusline" | "autocomplete" | "unknown";

interface InputBox {
  /** The frame the frame module found (lib/surface/frame.ts): edges, interior, placeholder, volatile rows. */
  frame: Frame;
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
  /** First row of the background-agents footer the walk peeled (extractAgentsFooter), or the
   *  exclusive end of the non-blank tail when there is no footer, so the range is empty. */
  agentsStart: number;
}

/**
 * Find the input box by ITS OWN FRAME, then account for everything below it. Returns null unless all
 * of this holds, checked in order:
 *
 *     <top border>         (bare, or carrying a session label; column 0)
 *     ❯ <draft>            (the prompt line; "!" in shell mode; column 0)
 *       <continuation…>    (0..idle.frame.maxDraftRows wrapped-draft lines, INDENTED: any content,
 *                           even a rule or a "❯" line the user pasted, is draft text)
 *     <bottom border>      (bare U+2500 rule)
 *     <tail…>              (0..idle.frame.maxTailRows rows, classified by classifyTail)
 *
 *  1. THE FRAME (lib/surface/frame.ts, from the profile's `idle` anchors): the bottom border is the
 *     lowest bare column-0 rule at most `idle.frame.maxTailRows` rows (60, the completion popup's own
 *     cap) above the last non-blank line, and the frame closes above it: a prompt line carrying "❯",
 *     or "!" in shell mode, then a top border, inside the shared `idle.frame.maxDraftRows` budget.
 *     Only a column-0 row stops the walk up from the bottom border: an indented row is a
 *     wrapped-draft continuation, so a draft holding a pasted rule or shell prompt keeps its box
 *     (ADR 0048 addendum 2026-09-26). The bound buys no safety on its own; the checks below do.
 *  2. NO FRAME MARK UNDER THE BOX: the tail holds no border, no rule shaped like a top border and no
 *     "❯"-led line (isFrameMark, chevron-only and indent-blind), a select dialog's "❯ 1. Yes" row,
 *     or a second box, refuses. One exception, for a statusline that draws such a row itself (a
 *     starship-style "❯ ~/src on main", a "─ main ───" separator): an un-numbered "❯"-led row or a
 *     labelled rule is stepped over (isStatuslineFrameMark), but the box is then kept only when every
 *     such row sits inside a `statusline` tail's run and no labelled rule sits directly on a "❯" row
 *     (a second box's top border and prompt). The same step-over serves the completion popup's
 *     pointed entry ("  ❯ /model …", Claude Code 2.1.291): that row is kept only when the tail is
 *     `autocomplete` and it is the one pointer the popup grammar read.
 *  3. THE TAIL IS ACCOUNTED FOR (classifyTail): a statusline run, a completion popup, or `unknown`.
 *  4. NO MODAL IS ON SCREEN: every specific dialog grammar runs over the WHOLE screen, and none may
 *     claim it; no tail row may carry a dialog footer; no `statusline` or `unknown` tail row may carry
 *     a numbered option or a "<key> to <verb>" hint (tailNamesAMenu); an `unknown` tail may also carry
 *     no pointer glyph, rule or stepper header (tailLooksModal). An echoed box higher up with a live
 *     dialog below it is refused when the dialog paints one of those marks in the tail, or a grammar
 *     claims it. A dialog with none of them under a stale box is not refused (ADR 0048).
 *
 * Why the frame and not the old bottom-up walk: that walk had to CROSS the tail to reach the border,
 * with a row budget (the statusline bound), so anything below the box it could not name (a completion
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
  // 1. The frame.
  const frame = findInputFrame(lines, CLAUDE_IDLE);
  if (frame === null) return null;
  const b = frame.bottom;

  // 2. No frame mark under it, except one a statusline or the popup may draw: those are remembered
  //    and judged once the tail is labelled (below).
  const stepped: number[] = [];
  for (let j = end - 1; j > b; j--) {
    if (!isFrameMark(texts[j]!)) continue;
    if (!isStatuslineFrameMark(texts[j]!)) return null;
    stepped.push(j);
  }

  // 3. The tail is accounted for.
  const { tail, statusEnd, agentsStart, popupPointer } = classifyTail(texts, frame, end);
  if (!steppedMarksAreOwned(texts, stepped, tail, b, statusEnd, agentsStart, popupPointer)) return null;

  // 4. No modal on screen.
  for (let j = b + 1; j < end; j++) {
    if (classifyFooter(texts[j]!, texts) !== null) return null;
    if (tail !== "autocomplete" && tailNamesAMenu(texts[j]!, texts)) return null;
    if (tail === "unknown" && tailLooksModal(texts[j]!)) return null;
  }
  if (dialogOnScreen(lines)) return null;

  return { frame, top: frame.top, prompt: frame.interior.prompt, bottomBorder: b, tail, statusEnd, agentsStart };
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
 * Whether the marks step 2 stepped over (`stepped`, bottom-up) all belong to a run that draws them.
 * Under an `autocomplete` tail that is the popup's own pointed entry row (Claude Code 2.1.291 marks
 * the selected completion with "❯", autocomplete.ts), and nothing else: the popup grammar named every
 * row and allows exactly one pointer, so any other stepped mark refuses. Otherwise it is the statusline
 * run: the tail is `statusline` and each mark sits inside one of the two runs that tail draws — the
 * statusline run itself (`bottomBorder + 1` to `statusEnd`) or the background-agents footer peeled
 * below it (`agentsStart` to the last non-blank row). The frame module walked both inside the
 * profile's bounds, so a row inside either is in bounds. Claude Code 2.1.293 paints "❯" on the ACTIVE agent's
 * footer row (`claude--footer-pointed-agent.txt`); that pointer is the composer's own chrome, not a
 * dialog's, and refusing it used to take the whole box down with it. And no labelled rule sits
 * directly on a "❯" row, the shape of a second box's top border and prompt. True when nothing was
 * stepped over.
 */
function steppedMarksAreOwned(
  texts: string[],
  stepped: number[],
  tail: InputBoxTail,
  bottomBorder: number,
  statusEnd: number,
  agentsStart: number,
  popupPointer: number,
): boolean {
  if (stepped.length === 0) return true;
  if (tail === "autocomplete") return stepped.every((j) => j === popupPointer);
  if (tail !== "statusline") return false;
  for (const j of stepped) {
    // `agentsStart` is `end` when no footer was peeled, so a row falls into exactly one of the two.
    // A row at or past `statusEnd` and above `agentsStart` is in neither run.
    if (j <= bottomBorder || (j >= statusEnd && j < agentsStart)) return false;
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
function tailNamesAMenu(text: string, texts: string[]): boolean {
  return NUMBERED_OPTION_ROW.test(text) || namesAModalKey(text, texts);
}

// Claude's own status hints. They read like a modal's "<key> to <verb>" footer but belong to the
// live composer: the default footer paints "esc to interrupt" while a turn runs and "↓ to manage"
// while background tasks or monitors exist. Claude Code 2.1.301 paints "↓ to view" on the mode row
// while background tasks run (the 2026-10-16 incident on lane 8788, the agents panel under the box). A modal's footer says "Esc to cancel" / "to close" /
// "to select", never these. The footer is clipped with "…" on a narrow pane, so "esc to inter…" is
// the same hint cut short.
const ESC_TO_INTERRUPT = /^esc to (?:interrupt|i(?:n(?:t(?:e(?:r(?:r(?:u(?:p)?)?)?)?)?)?)?…|…)$/i;
const DOWN_TO_MANAGE = /^↓ to (?:manage|m(?:a(?:n(?:a(?:g)?)?)?)?…|…)$/i;
const DOWN_TO_VIEW = /^↓ to (?:view|v(?:i(?:e)?)?…)$/i;
// Claude Code 2.1.301 with the tasks pill focused (one ↓ from the box, lab 2026-10-16): the mode
// row's last segment reads "Enter to view tasks", or that hint cut short.
const ENTER_TO_VIEW_TASKS = /^enter to (?:view tasks|view t(?:a(?:s(?:k)?)?)?…|v(?:i(?:e(?:w)?)?)?…)$/i;

// Claude Code 2.1.291 prints "ctrl+g to edit in <editor>" while the draft holds more than one line:
// right-aligned on the statusline's row, or on a row of its own at 40 columns
// (`claude-lab--draft-adversarial--w*.txt`). The plan dialog's footer opens with the same words, so
// the hint is the composer's only while that dialog's own words are NOT on screen (namesPlanDialog),
// the rule classifyFooter applies to the plan family (ADR 0053).
const DRAFT_EDIT_HINT = /^ctrl\+g to edit\b[^·]*$/i;

function isStatusHint(segment: string, draftEditHint: boolean): boolean {
  const t = segment.trim();
  return ESC_TO_INTERRUPT.test(t) || DOWN_TO_MANAGE.test(t) || DOWN_TO_VIEW.test(t) || ENTER_TO_VIEW_TASKS.test(t) || (draftEditHint && DRAFT_EDIT_HINT.test(t));
}

/**
 * `namesAMenuKey` for a Claude row, minus Claude's own status hints. The generic test stays loose on
 * purpose (a lone "Esc to cancel" must refuse), so the exemption is a closed list of the hints the
 * composer's footer prints, not a loosening of the key grammar. Shared with the adapter's
 * `modalOnScreen` so the box locator and the unread-dialog card agree on what a modal footer is.
 *
 * `texts`, the screen's rows, admits the draft's "ctrl+g to edit" hint as a status hint when no plan
 * dialog is on screen. Without it the hint still names a key, so a caller that cannot see the screen
 * refuses rather than types.
 */
export function namesAModalKey(text: string, texts?: string[]): boolean {
  const draftEditHint = texts !== undefined && !namesPlanDialog(texts);
  const segments = text.trim().split(SEGMENT_SPLIT);
  const kept = segments.filter((segment) => !isStatusHint(segment, draftEditHint));
  if (kept.length === segments.length) return namesAMenuKey(text);
  return kept.length > 0 && namesAMenuKey(kept.join(" · "));
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

/** classifyTail's answer: the tail's label, the statusline run's exclusive end (InputBox.statusEnd),
 *  and the popup's "❯"-pointed row when the tail is a 2.1.291 popup (-1 otherwise). */
interface TailReading {
  tail: InputBoxTail;
  statusEnd: number;
  agentsStart: number;
  popupPointer: number;
}

/**
 * Label the rows between the bottom border and `end` (exclusive; `end - 1` is the last non-blank
 * line). Pure, and it never refuses: refusing is locateInputBox's job. The popup is tried first
 * because a short popup also fits the statusline walk, and its rows must not be surfaced as a
 * statusline.
 *
 * The statusline walk is the frame's own (`frame.volatile`): an optional background-agents footer
 * divided off by a blank run, then the statusline and hint rows, which must reach the bottom border.
 * Both runs are bounded by the profile (`idle.volatile.below`), positional, never by content. When the
 * rows under the box do not walk that way, both spans are null and the tail is `unknown`.
 *
 *     <bottom border>
 *     <statusline>         (statusline + hint rows together, 0..below.maxRows, by position)
 *     <hint line>
 *     <blank>              (optional, separates the background-agents footer, if present)
 *     <● main>             (0..below.footerMaxRows footer lines, matched by position not content)
 *     <◯ agent …>
 */
function classifyTail(texts: string[], frame: Frame, end: number): TailReading {
  const first = frame.bottom + 1;
  if (first >= end) return { tail: "statusline", statusEnd: first, agentsStart: end, popupPointer: -1 };

  // The popup is confirmed, not assumed: Claude paints it only while the draft STARTS WITH "/".
  const popup = findAutocompleteRun(texts, end);
  if (popup !== null && popup.start === first && promptIsSlashCommand(texts, frame.interior.prompt)) {
    return { tail: "autocomplete", statusEnd: first, agentsStart: end, popupPointer: popup.pointer };
  }

  const { status, footer } = frame.volatile;
  if (status === null && footer === null) return { tail: "unknown", statusEnd: first, agentsStart: end, popupPointer: -1 };
  return {
    tail: "statusline",
    statusEnd: status === null ? first : status.last + 1,
    agentsStart: footer === null ? end : footer.first,
    popupPointer: -1,
  };
}

/** Whether the "❯" line holds a slash command — the draft state that puts the completion popup on
 *  screen. Claude renders a U+00A0 after the marker, which JS `trim()` strips. */
function promptIsSlashCommand(texts: string[], prompt: number): boolean {
  const head = texts[prompt]!.trimStart();
  return (head.startsWith("❯") ? head.slice(1) : head).trim().startsWith("/");
}
