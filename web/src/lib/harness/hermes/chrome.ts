// The input frame of Hermes Agent's classic CLI, found at the buffer's tail, and the probes the reply
// path asks of it. prompt_toolkit lays the bottom of the screen out in a fixed order
// (`_build_tui_layout_children` in hermes_cli/cli_tui_mixin.py, Hermes v0.22.2):
//
//     ╭─ Hermes Agent needs your input ─╮   a modal panel, when one is up (clarify.ts, approval.ts)
//     ╰─────────────────────────────────╯
//       ❓ Which database…  ( 52.6s · …)    the spinner row (wide panes only)
//       ↑/↓ to select, Enter to lock…      the panel's key hint, with its countdown
//      ☤ lab-model │ 1.24K/128K │ … ⏱ 53s   the status bar
//     ────────────────────────────────     the top rule
//     ? ❯ <input>                          the input row(s): a prompt prefix, then the draft
//     ────────────────────────────────     the bottom rule (absent below 64 columns)
//      /model  Switch model …               the completion menu, when one is open
//
// THE PROMPT PREFIX IS THE STATE. `_get_tui_prompt_fragments` paints `[<profile> ]❯ ` while the input
// is idle and `<icon> ❯ ` (just `<icon> ` below 64 columns) in every other state: `☤` while the agent
// runs, `?` while a clarify waits for a choice, `✎` while it waits for typed text, `⚠` while an
// approval (or a slash command's confirm) waits, and the secret, voice and connection icons. The
// draft follows the prefix. Typing reaches the input only in the idle, running and `✎` states; in
// `✎` it IS the clarify's answer, which is how a phone reply answers "Other (type your answer)".
//
// A PICKER LEAVES THE INPUT LOOKING IDLE. The model picker and the command palette keep the input row
// and its idle placeholder, but they own the keyboard (typing filters them), and the status bar
// renders EMPTY while one is open (`_get_status_bar_fragments` returns nothing for either state). A
// blank status slot under a panel box is the picker's positive evidence; a status bar the operator
// turned off removes the row instead, so it is not mistaken for one.
//
// Conservative: every step can only reject, and anything short of the whole frame at the tail is
// "no input here". Pure; no pane access, no network.

import { trimTrailingBlank, type StyledLine } from "../../blocks";
import { DEFAULT_TAIL_LINES } from "../../tail-lines";
import { displayWidth } from "../../text-width";
import {
  isBlank,
  isPanelRow,
  isRule,
  lastNonBlankIndex,
  lineText,
  PANEL_BOTTOM,
  rowTexts,
  rstrip,
  STATUS_BAR,
  WIDE_COLUMNS,
} from "./markers";

/** What the input row's prefix says the input is doing. */
export type PromptState = "idle" | "running" | "freetext" | "clarify" | "approval" | "other";

/** The input frame located at the tail. Every index is into the ORIGINAL `lines` array. */
export interface InputFrame {
  /** The status bar, directly above the top rule; null when that slot is blank, or the operator
   *  turned the bar off and another row sits there. */
  statusRow: number | null;
  /** Whether the slot above the top rule is a blank row: the status bar rendering nothing. */
  statusSlotBlank: boolean;
  topRule: number;
  /** The first input row, which carries the prompt prefix. */
  promptRow: number;
  /** The last input row (equals `promptRow` for a one-row input). */
  lastInputRow: number;
  /** The rule under the input; null on a narrow pane, which draws none. */
  bottomRule: number | null;
  state: PromptState;
  /** How many characters of the prompt row the prefix takes. */
  prefixLength: number;
}

// The icons `_get_tui_prompt_fragments` paints in front of a state prompt. Anything else in that
// position (a bang command's spinner frame, a skin's own icon) is a state not read here.
const STATE_ICONS = new Map<string, PromptState>([
  ["☤", "running"],
  ["✎", "freetext"],
  ["?", "clarify"],
  ["⚠", "approval"],
  ["🔐", "other"],
  ["🔑", "other"],
  ["⚙", "other"],
  ["◉", "other"],
  ["●", "other"],
  ["🎤", "other"],
]);

// The idle prompt: an optional profile name (`assistant ❯ ` on a named profile), then the skin's
// symbol. Only Hermes's default symbol is read; a skin that changes it leaves the input unrecognised.
const IDLE_PREFIX = /^(?:[\w.-]+ )?❯ ?/;
// A state prompt: the icon, then ` ❯ ` on a wide pane or a bare space on a narrow one.
const STATE_PREFIX = /^(\S+?)(?: ❯ ?| |$)/u;

/** The states in which typing reaches the input: idle, the agent running, a clarify's typed answer. */
export function takesText(state: PromptState): boolean {
  return state === "idle" || state === "running" || state === "freetext";
}

/** The prompt row's state and how long its prefix is, or null when the row is not an input row. */
export function parsePrompt(text: string): { state: PromptState; length: number } | null {
  const idle = IDLE_PREFIX.exec(text);
  if (idle !== null) return { state: "idle", length: idle[0].length };
  const state = STATE_PREFIX.exec(text);
  if (state === null) return null;
  const known = STATE_ICONS.get(state[1]!);
  return known === undefined ? null : { state: known, length: state[0].length };
}

// prompt_toolkit's completion menu, painted under the input: every printed cell sits on a background.
// Capped like Hermes's own menu (`CompletionsMenu(max_height=12)`), with room for a scrollbar row.
const MAX_MENU_ROWS = 14;
// A long or multi-line draft wraps the input onto more rows. A bound, so a stray rule far up the
// buffer cannot pair with the tail.
const MAX_INPUT_ROWS = 100;

function isMenuRow(line: StyledLine): boolean {
  const printed = line.segments.filter((s) => s.text !== "");
  return (
    printed.length > 0 &&
    !isBlank(lineText(line)) &&
    printed.every((s) => s.style.backgroundColor !== undefined)
  );
}

/** Locate the input frame at the tail, or null. Bottom-up; every step can only reject. */
export function locateInput(lines: StyledLine[]): InputFrame | null {
  const texts = rowTexts(lines);
  let end = lastNonBlankIndex(texts);
  // (a) A completion menu under the input.
  let menuRows = 0;
  while (end >= 0 && isMenuRow(lines[end]!)) {
    if (++menuRows > MAX_MENU_ROWS) return null;
    end = lastNonBlankIndex(texts, end - 1);
  }
  if (end < 0) return null;

  // (b) The rules. A wide pane closes the input with a rule as long as the one above it; a narrow
  // pane (and only a narrow one) ends on the input itself.
  let topRule = -1;
  let bottomRule: number | null = null;
  if (isRule(texts[end]!) && displayWidth(texts[end]!) >= WIDE_COLUMNS) {
    bottomRule = end;
    for (let i = end - 1; i >= Math.max(0, end - 1 - MAX_INPUT_ROWS); i--) {
      if (isRule(texts[i]!)) {
        topRule = i;
        break;
      }
    }
    if (topRule < 0 || texts[topRule] !== texts[bottomRule] || topRule === end - 1) return null;
  } else {
    for (let i = end; i >= Math.max(0, end - MAX_INPUT_ROWS); i--) {
      if (isRule(texts[i]!)) {
        topRule = i;
        break;
      }
    }
    if (topRule < 0 || topRule === end || displayWidth(texts[topRule]!) >= WIDE_COLUMNS) return null;
  }
  const promptRow = topRule + 1;
  const lastInputRow = bottomRule === null ? end : bottomRule - 1;
  const prompt = parsePrompt(texts[promptRow]!);
  if (prompt === null) return null;
  // Only an input that takes text can run onto more rows. A state that takes none (a clarify waiting
  // for a choice, an approval) is the one row, so on a narrow pane, which draws no rule under the
  // input, anything printed below it means the frame is not at the tail.
  if (!takesText(prompt.state) && lastInputRow !== promptRow) return null;

  // (c) The status slot directly above the top rule: the bar itself, recognised by its own marker,
  // so a bar the operator turned off is not mistaken for the row that then sits there (a key hint,
  // a reply's box).
  const above = topRule - 1;
  const statusSlotBlank = above >= 0 && isBlank(texts[above]!);
  const statusRow = above >= 0 && STATUS_BAR.test(texts[above]!) ? above : null;

  return {
    statusRow,
    statusSlotBlank,
    topRule,
    promptRow,
    lastInputRow,
    bottomRule,
    state: prompt.state,
    prefixLength: prompt.length,
  };
}

// How far above the status slot a picker's box may end: the model picker pads its list with blank
// rows to a fixed height (captured: four).
const PICKER_REACH = 8;

/**
 * The model picker or the command palette is open. Both draw a box straight above the input, with
 * nothing of their own between (no hint row, no spinner), and the status bar renders EMPTY while
 * either is up (fixtures hermes--model-picker, hermes--palette). So the evidence is: no status bar,
 * and the nearest printed row above the input is that box, a side `│ … │`, or a bottom `╰─╯`
 * narrower than the input's rule. A reply's own box is closed by a bottom as wide as the rule, which
 * is what sits there on an idle screen when the operator has turned the bar off. A picker as wide as
 * a narrow pane is not told apart from that, and reads as no picker.
 */
export function pickerOpen(lines: StyledLine[], frame: InputFrame | null = locateInput(lines)): boolean {
  if (frame === null || frame.statusRow !== null) return false;
  const texts = rowTexts(lines);
  const ruleWidth = displayWidth(texts[frame.topRule]!);
  const floor = Math.max(0, frame.topRule - 1 - PICKER_REACH);
  for (let i = frame.topRule - 1; i >= floor; i--) {
    const t = texts[i]!;
    if (isBlank(t)) continue;
    if (isPanelRow(t)) return true;
    return PANEL_BOTTOM.test(t) && displayWidth(t) < ruleWidth;
  }
  return false;
}

/** Whether typing would reach the input: an input state that takes text, and no picker over it. */
export function composerReady(lines: StyledLine[]): boolean {
  const frame = locateInput(lines);
  if (frame === null) return false;
  if (!takesText(frame.state)) return false;
  return !pickerOpen(lines, frame);
}

/**
 * The status bar, re-surfaced under the phone's composer once {@link stripChrome} takes it off the
 * mirror. Empty when there is no input frame or no status bar.
 */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const frame = locateInput(lines);
  return frame === null || frame.statusRow === null ? [] : [lines[frame.statusRow]!];
}

/** The mirror without the input frame: the status bar (or the top rule when it has none) to the end. */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const frame = locateInput(lines);
  if (frame === null) return lines;
  return trimTrailingBlank(lines.slice(0, frame.statusRow ?? frame.topRule));
}

// One input row's draft: the characters after `skip`, minus the italic placeholder Hermes paints in
// an empty input (`placeholder_*` in locales/en.yaml), as runs of [text, foreground].
function draftRuns(line: StyledLine, skip: number): { text: string; fg: string | undefined }[] {
  const runs: { text: string; fg: string | undefined }[] = [];
  let at = 0;
  for (const segment of line.segments) {
    const from = Math.max(0, skip - at);
    at += segment.text.length;
    if (from >= segment.text.length || segment.italic === true) continue;
    runs.push({ text: segment.text.slice(from), fg: segment.fg });
  }
  return runs;
}

/**
 * The draft in the input, or null when it holds none (only a placeholder, or no input at all).
 *
 * prompt_toolkit's auto-suggestion paints the rest of a matching history entry (or slash command)
 * after the cursor in a colour of its own (the grey `a` after `/mo` in hermes--slash-popup). The
 * draft is what was typed, so a trailing run in a colour other than the first typed run's is dropped.
 * Rows a long draft wrapped onto are joined as they read; a row that ends short of the pane's width
 * ended at a newline.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  const frame = locateInput(lines);
  if (frame === null) return null;
  if (!takesText(frame.state)) return null;
  const width = displayWidth(rowTexts(lines)[frame.topRule]!);
  const rows: { text: string; fg: string | undefined }[][] = [];
  for (let i = frame.promptRow; i <= frame.lastInputRow; i++) {
    rows.push(draftRuns(lines[i]!, i === frame.promptRow ? frame.prefixLength : 0));
  }
  const typedFg = rows.flat().find((r) => r.text.trim() !== "")?.fg;
  const last = rows.at(-1)!;
  while (last.length > 0 && last.at(-1)!.fg !== typedFg) last.pop();

  let draft = "";
  for (let i = 0; i < rows.length; i++) {
    const text = rows[i]!.map((r) => r.text).join("");
    if (i > 0) {
      const previous = lineText(lines[frame.promptRow + i - 1]!);
      if (displayWidth(previous) < width) draft += "\n";
    }
    draft += text;
  }
  draft = rstrip(draft);
  return draft.trim() === "" ? null : draft;
}

/**
 * The input rows, verbatim, as the region a write aimed at the input is bound to (`expected_prompt`):
 * the pre-clear sweep, and the Enter that submits a verified reply. The prefix is in it, so an Enter
 * meant for a clarify's `✎ ❯` answer is refused once that question has closed and the row reads
 * `❯ ` again. Null on the screens {@link composerReady} refuses, and when the menu under the input
 * pushes the region out of the bridge's tail window.
 */
export function composerPrompt(lines: StyledLine[]): string | null {
  if (!composerReady(lines)) return null;
  const frame = locateInput(lines);
  if (frame === null) return null;
  const texts = rowTexts(lines);
  let below = 0;
  for (let i = frame.lastInputRow + 1; i < texts.length; i++) if (!isBlank(texts[i]!)) below++;
  // The input sits at the tail, inside the bridge's default window, so it never declares a wider one.
  if (below > DEFAULT_TAIL_LINES - 1) return null;
  const region = texts.slice(frame.promptRow, frame.lastInputRow + 1).map(rstrip).join("\n");
  return region.trim() === "" ? null : region;
}
