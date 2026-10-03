// The omp COMPACT MODEL PICKER grammar (.adr/0079), the fourth omp screen this adapter lifts: the
// session-only model switch omp opens for `/switch` and for Alt+P.
//
// The screen, as omp 18.4.10 draws it (`omp--v18-4-switch.txt`; pi-tui `overlays/model-picker.ts` around
// `overlays/model-browser.ts`), a box anchored to the bottom of the pane:
//
//     ╭─ Switch Model ───────────────────────────────────────────────────────╮
//     │  Session-only switch — role models stay unchanged                     │   the status row
//     │  🔍 > sonnet                                                          │   the search row
//     │                                                                       │
//     │   openrouter/google/gemini-3.8-flash      🧠 59  ~327t/s  1m ◫  $0.75/3.75█ │   the list WINDOW:
//     │   anthropic/claude-sonnet-5-5             🧠 56  ~139t/s  1m ◫     $2/10│ │   recents first,
//     │   ─────────────────────────────────────────────────────────────────  │ │   a rule after them,
//     │ ❯ anthropic/claude-opus-5-5 ●             🧠 58   ~95t/s  1m ◫     $4/20│ │   the pointer, the
//     │   openai/gpt-4 ⦸ context>8.2k              🧠 7          8.2k ◫    $30/60│ │   current model's `●`,
//     │   …                                                                │ │   a scrollbar column
//     │                                                                       │
//     │   Claude Opus 5.5 · 1m ctx · 128k out · $4/20 per M · reasoning      │   two detail rows about
//     │   ● current · ● default ◒                                             │   the POINTED model
//     │ ↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close · Alt+P task model │
//     ╰───────────────────────────────────────────────────────────────────────╯
//
// WHAT ENTER DOES HERE. Enter on a row switches the live session's model for this session only:
// `onPick` → `#applySessionModel` → `setModelTemporary` (selector-controller.ts, model-controls.ts in
// omp 18.4.10). No config is written; omp records the pick in its recent-models list and the session
// log. An OVER-CONTEXT row (`⦸ context>8.2k`: the transcript is bigger than that model's window) is
// different: Enter there COMPACTS the session with the current model first and switches after. That
// is not a model switch, so those rows are never offered (below), only counted for the walk.
//
// WHAT A TAP SENDS. ADR 0055's walk over the VISIBLE window, `pointerWalk(pointedAt, i)`: `Down` or `Up`
// from the pointed row to the tapped row, then `Enter`. Both keys are in the footer (`↑/↓ models`, `⏎ use
// for this session`), so this is inside ADR 0009's rule, and no digit is invented. The action layer
// splits the plan (ADR 0080): it sends the arrows bound to the tapped screen, reads the pointer back,
// and sends `Enter` only bound to a fresh read that shows the pointer on the tapped row, so a model
// list that moved under the walk (a compaction, a desk keystroke) sends nothing. Up and Down skip the
// rule row (it is a disabled item in omp's `MenuSelection`), so the walk counts MODEL rows, not screen
// rows. Both ends of the walk are inside the window, so it never wraps (Up on the first row would wrap
// to the last model of ~840) and never scrolls. The pointed row sends `Enter` alone; on the current
// model that re-applies the model the session already runs (no config write; see SWITCH_NOTES.md for
// what omp still does on that path). The card's last row is the footer's way out in its own word
// (`Close`), sending `Escape`. omp clears a typed search on the first Escape and closes only on an empty
// one, so while a search is on screen the row is labelled `Clear search` instead: the label says what
// the one tap does.
//
// WHAT THE CARD SHOWS. One row per model row omp printed IN FULL: the label is the whole `provider/id`,
// the description the price and context badges omp printed, as labels only. A row that omp shortened
// with `…` (a narrow pane) is not offered, because its id is not on screen; nor is an over-context row,
// nor the CURRENT model (Enter on it re-applies it, resets omp's provider session and loses the prompt
// cache). All three still count in every other row's walk, and the current model's id is in the card's
// accessible name. The way-out button's description is the footer's own `type to search`.
//
// FAIL CLOSED. Every piece below is required, and any one missing returns null, which leaves the raw
// mirror and the unread-dialog card's Escape (omp/modal.ts):
//   * the bottom border is the last non-blank row, and the footer above it is exactly the session
//     footer, character for character: `↑/↓ models · ⏎ use for this session · type to search · @ quick
//     roles · ⎋ close · Alt+P task model`. So the `@` quick-roles state, the task-model state (Alt+P), a
//     rebound key, the Nerd Font and ascii presets and a footer omp clipped with `…` all decline;
//   * the title is exactly `Switch Model` and the status row exactly `Session-only switch — role models
//     stay unchanged` (a config error replaces that row, and declines);
//   * the search row `🔍 >`, a blank row, then the window: five to sixty rows (omp sizes it to the
//     terminal, `max(5, floor(rows × 0.4) − 9)`; captured at 5, 15 and 16), each a model row or the rule;
//     with no scrollbar, blank rows may pad the window after the last model row; with a scrollbar every
//     row carries a scrollbar cell and none is blank;
//   * a model row is the pointer column (`❯ ` or two spaces), then the id, then ` ●` for the current
//     model and ` ⦸ context>N` for an over-context one, then badges that each read as one of omp's
//     columns (intelligence, speed, context, price). Anything else in a row is a row this grammar does
//     not know, and the screen declines;
//   * exactly one pointer, at most one `●`, at most one rule;
//   * a blank row, then the two detail rows: the first the pointed model's facts, the second blank, a
//     list of chips (`● current`, `● default ◒`, `○ advisor ◒`) or the over-context warning, and the
//     second must agree with the pointed row (the warning exactly when it carries `⦸`; otherwise
//     `● current` exactly when it carries `●`);
//   * at least one row the card can offer;
//   * a region short enough for the bridge to bind (32000 characters, as resume.ts).
//
// THE RACE GUARD. The signature is the whole box verbatim, title through bottom border, rows trimmed of
// trailing space: the pointer column, the search text, every row of the window, the scrollbar thumb and
// both detail rows. A pointer moved at the desk, a search typed or changed, a scroll, a current-model
// mark that moved, all refuse the tap (ADR 0055 point 6). The core signature blanks what the pointer's
// own move changes: the pointer glyph and both detail rows. omp rewrites those two rows to describe the
// pointed model, so a walk changes them (captured: `omp--v18-4-switch-ptr-*.txt`, same picker, only the
// pointer moved). Each becomes one fixed token, so the core stays sensitive to the list, the search, the
// scrollbar and every other row.
//
// NOT MODELLED. The search box: the card types nothing into it (Type mode does, SWITCH_NOTES.md), and
// each keystroke changes the signature, so the card re-derives on the next poll. `@ quick roles` and
// `Alt+P task model` stay off the card: `PromptModel` has no field for footer actions (ADR 0058 point 5),
// and both open states this grammar declines. PageUp, PageDown, Home and End are not in the footer.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other grammar.

import type { StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lineText, rstrip } from "./markers";
import { readOmpHintList } from "./modal";

export interface SwitchPickerRegion {
  model: PromptModel;
  /** Index of the window's first row. The title, status and search rows above it stay in the raw
   *  mirror, so the operator reads the typed search verbatim; the card replaces the rest of the box. */
  startLine: number;
}

/** The session footer, exactly (`footerHint("session")` plus the task-mode toggle, model-picker.ts). */
const FOOTER = "↑/↓ models · ⏎ use for this session · type to search · @ quick roles · ⎋ close · Alt+P task model";
const TITLE = /^╭─ Switch Model ─+╮$/;
const STATUS = /^│ {2}Session-only switch — role models stay unchanged\s*│$/;
/** The search row: the `unicode` preset's search icon, the input's `>` prompt, then the query. */
const SEARCH = /^│ {2}🔍 >(?: ([\s\S]*?))?\s*│$/u;
const BOTTOM = /^╰─+╯$/;
const BLANK_ROW = /^│\s*│$/;
const BOXED = /^│ ([\s\S]*?)\s*│$/;

/** omp's `MIN_VISIBLE`, and a bound well past any real terminal (sixty rows is a 172-row pane). */
const MIN_WINDOW = 5;
const MAX_WINDOW = 60;

/** The bridge's cap on a bound region less a margin, as resume.ts. */
const MAX_REGION_CHARS = 32_000;

/** How far above the footer the title may sit: the window bound plus the fixed rows. */
const TITLE_SCAN_WINDOW = MAX_WINDOW + 12;

const POINTER = "❯";
/** What the core signature keeps of the two detail rows, which follow the pointer (see below). */
const DETAIL_FACTS_BLANK = "<detail facts>";
const DETAIL_CHIPS_BLANK = "<detail chips>";
/** The last row's label while a search is typed: omp's first Escape clears it rather than closing. */
const CLEAR_SEARCH = "Clear search";
const CURRENT_MARK = "●";
const SCROLL_CELLS = new Set(["█", "│"]);

/** A model row's text after the pointer column: the id (no spaces, at least one `/`), ` ●` for the
 *  current model, ` ⦸ context>N` for an over-context one, then the badge columns. The id is the whole
 *  `provider/id`: the session state always prints the provider (`setShowProvider(!roleMode)` in
 *  model-picker.ts), and only the declined role state drops it. */
const MODEL_ROW = /^(\S+\/\S+)( ●)?( ⦸ context>\S+)?(?: +(\S[\s\S]*))?$/u;
/** The rule omp draws between the recents and the rest: two spaces, then dashes (its two trailing
 *  spaces are padding, taken off with the rest). */
const RULE = /^ {2}─+$/;

/** The badge columns, one per kind (model-browser.ts `#renderRow`), in the `unicode` preset. Each cell
 *  is padded on the left and separated by two spaces. A cell that matches none of them is text this
 *  grammar does not know, and the row is read as unknown. */
const BADGE_CELLS: readonly RegExp[] = [
  /^🧠 \d+$/u, // intelligence
  /^(?:\d+(?:\.\d+)?s )?~?\d+(?:\.\d+)?t\/s$/, // speed: estimated `~95t/s`, measured `118t/s` or `0.9s 118t/s`
  /^\d+(?:\.\d+)?[kmbt]? ◫$/, // context window
  /^(?:\$[\d.?]+\/[\d.?]+(?: [\d.?]+×)?|[\d.?]+×|free|included|varies|unknown)$/, // price, `?` for an unknown leg
];

/** The second detail row: chips that each open with a status dot, or the over-context warning. */
const CHIP = /^[●○] \S(?:[^·]*\S)?$/u;
const OVER_CONTEXT_WARNING = /^⦸ context \S+ exceeds \S+ limit/u;

interface ModelRow {
  kind: "model";
  pointed: boolean;
  /** The full id, or null when omp shortened the row with `…` and the id is not all on screen. */
  id: string | null;
  current: boolean;
  overContext: boolean;
  badges: string[];
}

type WindowRow = ModelRow | { kind: "rule" };

/**
 * Detect the compact model picker at the tail of `lines`. Returns a `prompt-select` model whose options
 * are the window's model rows omp printed in full (over-context rows aside) plus the footer's way out,
 * and the index of the window's first row; null when any piece of evidence is missing.
 */
export function detectSwitchPickerRegion(lines: StyledLine[]): SwitchPickerRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The tail: bottom border, footer, the two detail rows, a blank row.
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 0 || !BOTTOM.test(texts[end]!)) return null;
  const footerText = BOXED.exec(texts[end - 1] ?? "")?.[1];
  if (footerText !== FOOTER) return null;
  const footer = readOmpHintList(footerText);
  if (footer === null) return null;
  const detailFacts = texts[end - 3];
  const detailChips = texts[end - 2];
  if (detailFacts === undefined || detailChips === undefined) return null;
  if (!BLANK_ROW.test(texts[end - 4] ?? "")) return null;

  // 2. The title, nearest above the footer, then its three fixed rows.
  let titleAt = -1;
  for (let i = end - 5, seen = 0; i >= 0 && seen < TITLE_SCAN_WINDOW; i--, seen++) {
    if (TITLE.test(texts[i]!)) {
      titleAt = i;
      break;
    }
  }
  if (titleAt < 0) return null;
  if (!STATUS.test(texts[titleAt + 1] ?? "")) return null;
  const search = SEARCH.exec(texts[titleAt + 2] ?? "");
  if (search === null) return null;
  // omp's first Escape clears a typed search and closes the picker only when the search is empty. The
  // typed text is the row's text after the `>` prompt (the input's own cursor cell is padding).
  const searching = (search[1] ?? "").trim().length > 0;
  if (!BLANK_ROW.test(texts[titleAt + 3] ?? "")) return null;

  // 3. The window.
  const windowStart = titleAt + 4;
  const windowEnd = end - 5; // inclusive
  const windowRows = windowEnd - windowStart + 1;
  if (windowRows < MIN_WINDOW || windowRows > MAX_WINDOW) return null;
  const rows = readWindow(texts.slice(windowStart, windowEnd + 1));
  if (rows === null) return null;
  const models = rows.filter((r): r is ModelRow => r.kind === "model");
  if (models.filter((m) => m.pointed).length !== 1) return null;
  if (models.filter((m) => m.current).length > 1) return null;
  if (rows.filter((r) => r.kind === "rule").length > 1) return null;
  const pointedAt = models.findIndex((m) => m.pointed);
  const pointed = models[pointedAt]!;

  // 4. The detail rows describe the pointed model, and must agree with it.
  if (!/^│ {3}\S/.test(detailFacts)) return null;
  const chips = readChips(detailChips);
  if (chips === null) return null;
  // omp prints the over-context warning INSTEAD of the chips (model-browser.ts `#detailLines`), so a
  // warning says nothing about the current mark, and the chips say both. A shortened pointed row has
  // lost its marks, so there is nothing on it to agree with.
  if (pointed.id !== null) {
    if (chips.overContext !== pointed.overContext) return null;
    if (!chips.overContext && chips.current !== pointed.current) return null;
  }

  // 5. The options: every model row with its whole id on screen, over-context rows aside. The walk is
  //    counted over every model row in the window, offered or not, because Up and Down stop on each.
  const options: PromptOption[] = [];
  models.forEach((row, i) => {
    // Never offered, though each still counts in the walk: a row omp shortened, an over-context row
    // (Enter compacts first) and the CURRENT model (Enter re-applies it, resets omp's provider session
    // and so loses the prompt cache, for no change of model).
    if (row.id === null || row.overContext || row.current) return;
    const description = row.badges.join(" · ");
    const option: PromptOption = {
      label: row.id,
      keys: pointerWalk(pointedAt, i),
      // The footer names the arrows, not a row key, so the pointed row shows the pointer and every
      // other row shows no badge, as resume.ts and ask.ts do.
      keyLabel: i === pointedAt ? POINTER : "",
    };
    if (description.length > 0) option.description = description;
    options.push(option);
  });
  if (options.length === 0) return null;
  // The footer's own way out, in its own word (ADR 0058 point 5), except while a search is typed: then
  // the one Escape clears the search and the picker stays open, so the label says `Clear search`. Its
  // description is the footer's own `type to search` segment, so a card that shows a dozen rows of a
  // catalog of hundreds says how to reach the rest.
  options.push({
    label: searching ? CLEAR_SEARCH : capitalise(footer.escapeVerb),
    description: footer.segments.find((s) => s === "type to search") ?? "",
    keys: ["Escape"],
    keyLabel: "Esc",
  });

  // 6. The signature: the whole box verbatim, trailing padding off.
  const region = texts.slice(titleAt, end + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedRow = windowStart + rows.indexOf(pointed);
  // The core signature blanks everything the pointer's own move changes (ADR 0080 point 5): the pointer
  // glyph, and the two detail rows under the list, which describe the pointed model.
  const detailFactsAt = end - 3 - titleAt;
  const detailChipsAt = end - 2 - titleAt;
  const coreSignature = region
    .map((row, i) => {
      if (i === detailFactsAt) return DETAIL_FACTS_BLANK;
      if (i === detailChipsAt) return DETAIL_CHIPS_BLANK;
      return titleAt + i === pointedRow ? row.replace(POINTER, " ") : row;
    })
    .join("\n");

  const title = "Switch Model";
  const current = models.find((m) => m.current)?.id ?? undefined;
  const model: PromptModel = {
    // The accessible name carries what the raw rows above the card print: the title, the status
    // sentence and the search row as typed.
    question: [
      title,
      boxedText(texts[titleAt + 1]!),
      boxedText(texts[titleAt + 2]!),
      ...(current === undefined ? [] : [`${CURRENT_MARK} current: ${current}`]),
    ].join("\n"),
    caption: title,
    options,
    family: "select",
    signature,
    coreSignature,
  };
  return { model, startLine: windowStart };
}

/** The model alone (or null), the thin matcher tests assert on. */
export function detectSwitchPicker(lines: StyledLine[]): PromptModel | null {
  return detectSwitchPickerRegion(lines)?.model ?? null;
}

/**
 * The window's rows, or null. Model rows and at most one rule, then, only when no row carries a
 * scrollbar cell, blank rows to the window's end. A blank row between two model rows, a scrollbar on
 * some rows and not others, or a row of any other shape is not this layout.
 */
function readWindow(rows: string[]): WindowRow[] | null {
  const read: WindowRow[] = [];
  let scrollbar: boolean | null = null;
  let padding = false;
  for (const row of rows) {
    if (BLANK_ROW.test(row)) {
      padding = true;
      continue;
    }
    if (padding) return null;
    if (!row.startsWith("│ ") || !row.endsWith(" │")) return null;
    const inner = row.slice(2, -2);
    const cell = inner.slice(-1);
    const hasBar = SCROLL_CELLS.has(cell);
    if (!hasBar && cell !== " ") return null;
    if (scrollbar === null) scrollbar = hasBar;
    if (scrollbar !== hasBar) return null;
    const content = inner.slice(0, -1).replace(/\s+$/, "");
    if (RULE.test(content)) {
      read.push({ kind: "rule" });
      continue;
    }
    const model = readModelRow(content);
    if (model === null) return null;
    read.push(model);
  }
  // A scrollbar means the list overflows the window, which omp then fills: no padding rows.
  if (scrollbar === true && padding) return null;
  if (scrollbar === true && !rows.some((r) => r.slice(2, -2).endsWith("█"))) return null;
  return read;
}

/** One model row's content (the pointer column on), or null when it is not one. */
function readModelRow(content: string): ModelRow | null {
  const head = /^([❯ ]) (\S[\s\S]*)$/u.exec(content);
  if (head === null) return null;
  const pointed = head[1] === POINTER;
  const body = head[2]!;
  // omp shortened the row to fit the pane (`truncateToWidth`, which ends in `…`). The row is still a
  // model the arrows stop on, but its id may not all be on screen, so it is never offered.
  if (body.includes("…")) return { kind: "model", pointed, id: null, current: false, overContext: false, badges: [] };
  const m = MODEL_ROW.exec(body);
  if (m === null) return null;
  const badges = m[4] === undefined ? [] : m[4].trim().split(/\s{2,}/);
  if (!badges.every((cell) => BADGE_CELLS.some((re) => re.test(cell)))) return null;
  return { kind: "model", pointed, id: m[1]!, current: m[2] !== undefined, overContext: m[3] !== undefined, badges };
}

/** The second detail row read for what it says about the pointed model, or null when it is a row this
 *  grammar does not know. */
function readChips(row: string): { current: boolean; overContext: boolean } | null {
  if (BLANK_ROW.test(row)) return { current: false, overContext: false };
  const text = /^│ {3}(\S[\s\S]*?)\s*│$/u.exec(row)?.[1];
  if (text === undefined) return null;
  if (OVER_CONTEXT_WARNING.test(text)) return { current: false, overContext: true };
  const chips = text.split(" · ");
  if (!chips.every((chip) => CHIP.test(chip))) return null;
  return { current: chips[0] === `${CURRENT_MARK} current`, overContext: false };
}

function boxedText(row: string): string {
  return BOXED.exec(row)?.[1]?.trim() ?? "";
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
