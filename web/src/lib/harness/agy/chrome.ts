import { parseAnsi, type AnsiSegment } from "../../ansi";
import type { StyledLine } from "../../blocks";
import { findInputFrame, type RowSpan } from "../../surface/frame";
import { requireProfile } from "../../surface/profile";
import { detectArtifactRegion } from "./artifact";
import { detectConversationsRegion } from "./conversations";
import { classifyFooter, isBlank, isBoxBorder, lineText } from "./markers";
import { detectAgyModalRegion } from "./modals";
import { detectModelRegion } from "./model";
import { detectPromptSelectRegionIn, parseOptionRow, trailingMenuRows } from "./prompt-select";

// Rows under the bottom border. A custom `statusLine` command prints as many rows as the user wrote,
// so this matches the Claude reader's ceiling (the Claude profile's `idle.volatile.below.maxRows`).
const MAX_STATUS_LINES = 8;
const MAX_DRAFT_LINES = 100;
const PROMPT_REGEX = /^[❯›>]\s*/;
const ESC_TO_CANCEL = /\besc(?:ape)?\s+to\s+cancel\b/i;
const OWN_ESC_STATUS = /^esc to cancel(?:\s|$)/i;
const BACKGROUND_TASK_ROW = /^ {2}● \[\d{2}:\d{2}:\d{2}\] .+ running$/;
const MAX_TASK_FOOTER_ROWS = 15;
const AGY_IDLE = requireProfile("agy").idle;

// The slash-command completion popup (agy 1.3.5, live 2026-10-15) paints UNDER the box's bottom rule:
// suggestion rows, the highlighted one led by `>` (`> /model  Set a model…`) and the rest by two
// spaces, then `↓ 1 more` or `No matches`, then its own footer `↑/↓ Navigate · enter Select · tab
// Complete` and an `esc to cancel` row. The box above stays live: typing still lands in it. The popup
// is named by that whole footer row and by every row between the rule and it being one the popup
// paints. The phrase `tab Complete` alone is not enough: a modal's hint row may say `tab Complete
// search` (review, 2026-10-15), and taking it for the popup would skip the modal check. 1.4.x adds a
// command's aliases in brackets after it (`> /config (settings)`).
const COMPLETION_FOOTER = /^\s*↑\/↓ Navigate · enter Select · tab Complete\s*$/;
const COMPLETION_POINTED = /^>\s+(\/\S+)(?:\s+\(([^()]+)\))?/;
const COMPLETION_POINTED_ALIAS = /^(>\s+)(\/\S+)\s+\(([^()]+)\)(\s{2,}.*)?$/;
const COMPLETION_ROW = /^(?:> | {2})\/\S+(?:\s+\([^()]+\))?(?:\s{2,}\S.*)?$/;
const COMPLETION_MORE = /^\s*[↑↓] \d+ more$/;
const COMPLETION_NONE = /^\s*No matches$/;
// The popup's own rows on top of the status rows: five suggestions, a `↓ n more`, an `↑ n more` once
// scrolled, the footer, with margin.
const MAX_POPUP_LINES = 10;

function parseAliases(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((alias) => (alias.startsWith("/") ? alias : `/${alias}`));
}

function withSegmentText(seg: AnsiSegment, text: string): AnsiSegment {
  return { ...seg, text };
}

function replaceRowPrefix(line: StyledLine, len: number, replacement: string): StyledLine {
  let pos = 0;
  const segments = line.segments.map((seg) => {
    if (pos >= len) return seg;
    const end = pos + seg.text.length;
    const sliceStart = pos;
    pos = end;
    if (end <= len) {
      return withSegmentText(seg, replacement.slice(sliceStart, end));
    }
    return withSegmentText(seg, replacement.slice(sliceStart, len) + seg.text.slice(len - sliceStart));
  });
  return { ...line, segments };
}

function isGhostSegment(seg: AnsiSegment): boolean {
  return seg.dim === true || seg.fg === "var(--ansi-8)";
}

/**
 * Normalize AGY composer decorations before reading the input frame or draft:
 * 1. Blank trailing ghost (`dim: true` or `fg: "var(--ansi-8)"`) inline autocomplete / subcommand
 *    hints (e.g. `reload` after `/skills`) when the prompt row already holds non-ghost typed text.
 * 2. Rewrite pointed completion popup rows with parenthesized aliases (e.g. `> /config (settings)`)
 *    when the user typed one of those aliases (`/settings`).
 */
export function normalizeAgyScreenRows(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines;

  const bot = end - 1;
  let reach = MAX_STATUS_LINES;
  for (let s = 0; s <= MAX_STATUS_LINES && bot - s >= 0; s++) {
    if (COMPLETION_FOOTER.test(texts[bot - s]!)) reach = MAX_STATUS_LINES + MAX_POPUP_LINES;
  }
  let bottomBorder = -1;
  for (let s = 0; s <= reach && bot - s >= 0; s++) {
    const idx = bot - s;
    if (isBoxBorder(texts[idx]!)) {
      bottomBorder = idx;
      break;
    }
  }
  if (bottomBorder <= 1) return lines;

  // Step across a background-task rail if `bottomBorder` is its closing rule.
  let taskScan = bottomBorder;
  while (taskScan > 0 && bottomBorder - taskScan < MAX_TASK_FOOTER_ROWS) {
    if (!BACKGROUND_TASK_ROW.test(texts[taskScan - 1]!.trimEnd())) break;
    taskScan--;
  }
  if (
    taskScan < bottomBorder &&
    taskScan > 0 &&
    isBoxBorder(texts[taskScan - 1]!) &&
    texts[taskScan - 1]!.trimEnd() === texts[bottomBorder]!.trimEnd()
  ) {
    bottomBorder = taskScan - 1;
  }
  if (bottomBorder <= 1) return lines;

  const prompt = bottomBorder - 1;
  if (!PROMPT_REGEX.test(texts[prompt]!)) return lines;
  let top = prompt - 1;
  while (top >= 0 && isBlank(texts[top]!)) top--;
  if (top < 0 || !isBoxBorder(texts[top]!)) return lines;

  const promptLine = lines[prompt]!;
  const holeStart = PROMPT_REGEX.exec(texts[prompt]!)?.[0].length ?? 0;
  let offset = 0;
  let lastTypedIdx = -1;
  for (let i = 0; i < promptLine.segments.length; i++) {
    const seg = promptLine.segments[i]!;
    const inHole = seg.text.slice(Math.max(0, holeStart - offset));
    offset += seg.text.length;
    if (inHole.trim().length > 0 && !isGhostSegment(seg)) {
      lastTypedIdx = i;
    }
  }

  let normalizedPrompt = promptLine;
  let changed = false;
  if (
    lastTypedIdx >= 0 &&
    promptLine.segments.some((seg, i) => i > lastTypedIdx && isGhostSegment(seg) && seg.text.trim().length > 0)
  ) {
    changed = true;
    normalizedPrompt = {
      ...promptLine,
      segments: promptLine.segments.map((seg, i) =>
        i > lastTypedIdx && isGhostSegment(seg) && seg.text.trim().length > 0
          ? withSegmentText(seg, " ".repeat(seg.text.length))
          : seg,
      ),
    };
  }

  const typed = lineText(normalizedPrompt).replace(PROMPT_REGEX, "").trim();
  const footer = completionFooter(texts, bottomBorder, end);
  let aliasRowIdx = -1;
  let aliasRowReplacement: StyledLine | null = null;
  if (footer !== -1 && /^\/\S+$/.test(typed)) {
    for (let j = bottomBorder + 1; j < footer; j++) {
      const match = COMPLETION_POINTED_ALIAS.exec(texts[j]!.trimEnd());
      if (match === null) continue;
      const aliases = parseAliases(match[3]);
      if (typed !== match[2] && aliases.includes(typed)) {
        const oldPrefix = `${match[1]}${match[2]} (${match[3]})`;
        const newPrefix = `${match[1]}${typed}`.padEnd(oldPrefix.length, " ");
        if (newPrefix.length === oldPrefix.length) {
          aliasRowIdx = j;
          aliasRowReplacement = replaceRowPrefix(lines[j]!, oldPrefix.length, newPrefix);
          changed = true;
        }
      }
      break;
    }
  }

  if (!changed) return lines;
  return lines.map((line, i) => {
    if (i === prompt) return normalizedPrompt;
    if (i === aliasRowIdx && aliasRowReplacement !== null) return aliasRowReplacement;
    return line;
  });
}

/** The completion footer's row between the bottom rule and `end`, or -1 when no popup is open. */
function completionFooter(texts: string[], bottomBorder: number, end: number): number {
  for (let j = bottomBorder + 1; j < end; j++) {
    if (!COMPLETION_FOOTER.test(texts[j]!)) continue;
    for (let k = bottomBorder + 1; k < j; k++) if (!isPopupRow(texts[k]!)) return -1;
    return j;
  }
  return -1;
}

function isPopupRow(text: string): boolean {
  const t = text.trimEnd();
  return t === "" || COMPLETION_ROW.test(t) || COMPLETION_MORE.test(t) || COMPLETION_NONE.test(t);
}

// What a dialog paints under its rule and a status line never does: a footer hint, `esc to cancel`,
// or a numbered menu (rows 1., 2. …, as `trailingMenuRows` reads one). Idle and working composers
// print `? for shortcuts` under the box (every capture in the corpus), so any of these under a rule
// means that rule belongs to a modal. 1.4.x panels add a `Keyboard:` hint row, an `esc close` hint and
// the `Models & Quota` / `Context Usage` panel foot. One numbered item alone is not enough: a custom
// `statusLine` may print `1. build ok  2. tests ok` (claude-lab--statusline-numbered-rows--w82.txt),
// and that is still a live box. Under an open completion popup the rows below its footer get the same
// check, so a modal painted there is still a modal (second review, 2026-10-16). `ownEsc` is the first
// status row, the one row that may say `esc to cancel` without being a modal: the popup's own row, and
// since 1.4.x the working composer's status row (`OWN_ESC_STATUS`).
function dialogUnder(texts: string[], bottomBorder: number, end: number, ownEsc = -1): boolean {
  const options: { n: number }[] = [];
  for (let j = bottomBorder + 1; j < end; j++) {
    const text = texts[j]!;
    if (
      classifyFooter(text) !== null ||
      /^Keyboard:\s/.test(text) ||
      /\besc\s+close\b/i.test(text) ||
      /^└ (?:Models & Quota|Context Usage)\s*$/.test(text)
    ) {
      return true;
    }
    if (ESC_TO_CANCEL.test(text) && !(j === ownEsc && OWN_ESC_STATUS.test(text))) return true;
    const option = parseOptionRow(text);
    if (option !== null) options.push(option);
  }
  return trailingMenuRows(options).length >= 2;
}

export interface LocatedBox {
  top: number;
  prompt: number;
  bottomBorder: number;
  /** The first status row: the row under the rule, or under a completion popup's footer. */
  statusStart: number;
  statusEnd: number;
  draft: string | null;
  taskFooter?: RowSpan;
}

function locateBackgroundTaskBox(texts: string[], bot: number, end: number): LocatedBox | null {
  for (let s = 0; s <= MAX_STATUS_LINES && bot - s >= 0; s++) {
    const closingRule = bot - s;
    if (!isBoxBorder(texts[closingRule]!) || /^\s/.test(texts[closingRule]!)) continue;
    let firstTask = closingRule;
    while (firstTask > 0 && closingRule - firstTask < MAX_TASK_FOOTER_ROWS) {
      if (!BACKGROUND_TASK_ROW.test(texts[firstTask - 1]!.trimEnd())) break;
      firstTask--;
    }
    if (firstTask === closingRule || firstTask <= 2) return null;
    const bottomBorder = firstTask - 1;
    if (
      !isBoxBorder(texts[bottomBorder]!) ||
      texts[bottomBorder]!.trimEnd() !== texts[closingRule]!.trimEnd()
    ) {
      return null;
    }
    const statusStart = closingRule + 1;
    if (dialogUnder(texts, closingRule, end, statusStart) || detectPromptSelectRegionIn(texts) !== null) {
      return null;
    }
    const prompt = bottomBorder - 1;
    if (!PROMPT_REGEX.test(texts[prompt]!)) return null;
    let top = prompt - 1;
    while (top >= 0 && isBlank(texts[top]!)) top--;
    if (top < 0 || !isBoxBorder(texts[top]!) || /^\s/.test(texts[top]!)) return null;
    const draft = texts[prompt]!.replace(PROMPT_REGEX, "").trim() || null;
    return {
      top,
      prompt,
      bottomBorder,
      statusStart,
      statusEnd: end,
      draft,
      taskFooter: { first: firstTask, last: closingRule },
    };
  }
  return null;
}

export function locateInputBox(texts: string[], end: number): LocatedBox | null {
  if (end === 0) return null;
  let bot = end - 1;
  while (bot >= 0 && isBlank(texts[bot]!)) bot--;
  if (bot < 0) return null;

  const taskBox = locateBackgroundTaskBox(texts, bot, end);
  if (taskBox !== null) return taskBox;

  // 1. Look for bottom border within MAX_STATUS_LINES from the tail (allowing status/hint lines below)
  let bottomBorder = -1;
  const statusEnd = end;
  let reach = MAX_STATUS_LINES;
  for (let s = 0; s <= MAX_STATUS_LINES && bot - s >= 0; s++) {
    if (COMPLETION_FOOTER.test(texts[bot - s]!)) reach = MAX_STATUS_LINES + MAX_POPUP_LINES;
  }
  for (let s = 0; s <= reach && bot - s >= 0; s++) {
    const idx = bot - s;
    if (isBoxBorder(texts[idx]!)) {
      bottomBorder = idx;
      break;
    }
  }

  // The window is wide enough (8 rows) to reach the rule under a dialog's `Question` label. A short
  // `select-menu` dialog (one real option and a write-in) puts that rule inside it, and the echoed
  // user message `> …` above it then reads as an idle prompt. A modal under the rule, or a prompt
  // grammar claiming the screen, means no composer: fail closed, like step 2.
  const footer = bottomBorder === -1 ? -1 : completionFooter(texts, bottomBorder, end);
  if (bottomBorder !== -1) {
    const statusBase = footer === -1 ? bottomBorder : footer;
    const modal = dialogUnder(texts, statusBase, end, statusBase + 1);
    if (modal || detectPromptSelectRegionIn(texts) !== null) return null;
  }

  if (bottomBorder !== -1) {
    let p = bottomBorder - 1;
    let walk = 0;
    while (p >= 0 && walk < MAX_DRAFT_LINES) {
      const t = texts[p]!;
      // The box's own rules start at column 0 (every capture in the corpus). A rule the operator
      // typed or pasted sits behind the draft's two-space gutter, so it is draft text; reading it as
      // the top border refused the composer while that draft sat there (harness canary
      // 2026-10-12, agy 1.3.3, draft 15-rule).
      if (isBoxBorder(t) && !/^\s/.test(t)) return null;
      if (PROMPT_REGEX.test(t)) {
        let top = p - 1;
        while (top >= 0 && isBlank(texts[top]!)) top--;
        if (top >= 0 && isBoxBorder(texts[top]!)) {
          const head = t.replace(PROMPT_REGEX, "").trim();
          const parts = [head];
          for (let j = p + 1; j < bottomBorder; j++) {
            const cont = texts[j]!.trim();
            if (cont.length > 0) parts.push(cont);
          }
          const typed = parts.join(" ").trim() || null;
          const draft = footer === -1 ? typed : completedDraft(texts, bottomBorder, footer, typed);
          const statusStart = footer === -1 ? bottomBorder + 1 : footer + 1;
          return { top, prompt: p, bottomBorder, statusStart, statusEnd, draft };
        }
      }
      if (!isBlank(t) && !/^ {2}/.test(t)) return null;
      p--;
      walk++;
    }
  }

  // 2. No fallback. AGY's composer is ALWAYS boxed — a top rule, the `>` row, a bottom rule, then
  // the `? for shortcuts …` status row (every capture in the corpus). A bare `>` row with nothing
  // anchoring it is a TRANSCRIPT row, not a composer: AGY echoes each submitted message as `> …`
  // and paints its ask_user_question selection the same way (see agy--done.txt). Claiming those
  // would report a live composer over a busy agent, hand the echo back as the operator's draft, and
  // authorise a reply the pane cannot receive. Failing closed costs a refused send; failing open
  // types into a running turn.
  return null;
}

/**
 * The draft under an open completion popup. Enter runs the HIGHLIGHTED suggestion, so the typed text
 * verifies only when that suggestion is the typed command itself, one of its bracketed aliases, or
 * when the popup says `No matches` (an argument typed). On partial input (`/mo` over `> /model`) the
 * highlighted row is folded in, so the reply guard cannot match and refuses, rather than bless a
 * command nobody typed. A popup listing suggestions with none highlighted is not measured, so its
 * rows are folded in the same way: not finding the highlight is not the same as the popup saying
 * there is none. The whole popup is read before any answer: `No matches` beside a suggestion, or two
 * highlighted rows, is a screen nobody measured, and the first row that looked right must not decide
 * it (second review, 2026-10-16).
 */
function completedDraft(texts: string[], bottomBorder: number, footer: number, typed: string | null): string | null {
  if (typed === null) return null;
  const rows = texts
    .slice(bottomBorder + 1, footer)
    .map((row) => row.trim())
    .filter((row) => row !== "");
  if (rows.some((row) => COMPLETION_NONE.test(row))) return rows.length === 1 ? typed : null;
  const pointed = rows.flatMap((row) => {
    const match = COMPLETION_POINTED.exec(row);
    return match === null ? [] : [{ row, command: match[1]!, aliases: parseAliases(match[2]) }];
  });
  if (pointed.length > 1) return null;
  const [only] = pointed;
  if (only !== undefined) {
    return only.command === typed || only.aliases.includes(typed) ? typed : `${typed} ${only.row}`;
  }
  return rows.length === 0 ? null : `${typed} ${rows.join(" ")}`;
}

export function stripChrome(rawLines: StyledLine[]): StyledLine[] {
  const lines = normalizeAgyScreenRows(rawLines);
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.slice(0, 0);

  const box = locateInputBox(texts, end);
  if (box !== null) {
    if (box.taskFooter !== undefined) {
      // Keep task progress at its source rows while removing the composer and fixed status.
      return lines
        .slice(0, box.statusStart)
        .map((line, i) => (i >= box.top && i <= box.bottomBorder ? { segments: [] } : line));
    }
    end = box.top;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? rawLines : rawLines.slice(0, end);
}

export function extractStatusLines(rawLines: StyledLine[]): StyledLine[] {
  const lines = normalizeAgyScreenRows(rawLines);
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return [];

  const box = locateInputBox(texts, end);
  const statusStart =
    box?.statusStart ??
    detectModelRegion(lines)?.statusStartLine ??
    detectConversationsRegion(texts.map((t) => t.trimEnd()))?.statusStartLine ??
    detectArtifactRegion(lines)?.statusStartLine ??
    detectAgyModalRegion(lines)?.statusStartLine;
  if (statusStart === undefined) return [];

  const rows: StyledLine[] = [];
  for (let j = statusStart; j < (box?.statusEnd ?? end); j++) {
    if (!isBlank(texts[j]!)) rows.push(lines[j]!);
  }
  if (
    rows.length === 2 &&
    /^(?:\? for shortcuts|esc to cancel)\s*$/i.test(lineText(rows[0]!)) &&
    /^\s{2,}\S/.test(lineText(rows[1]!))
  ) {
    return [{ segments: [...rows[0]!.segments, ...parseAnsi("  "), ...rows[1]!.segments] }];
  }
  return rows;
}

export function extractInputDraft(rawLines: StyledLine[]): string | null {
  const lines = normalizeAgyScreenRows(rawLines);
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;
  const box = locateInputBox(texts, end);
  if (box !== null) {
    const frame = findInputFrame(lines, AGY_IDLE);
    if (frame?.top === box.top && frame.interior.prompt === box.prompt && frame.placeholder) return null;
  }
  return box?.draft ?? null;
}

export function hasInputBox(rawLines: StyledLine[]): boolean {
  const lines = normalizeAgyScreenRows(rawLines);
  const texts = lines.map(lineText);
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return false;
  return locateInputBox(texts, end) !== null;
}
