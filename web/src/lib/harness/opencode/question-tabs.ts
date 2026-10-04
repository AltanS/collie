// The opencode QUESTION dialogs with a TAB BAR — the Tier-2 lift for everything `question.ts` leaves
// raw (issue 329): a multi-select question, a call with several questions, and the Confirm tab that
// ends both. Measured on opencode 1.18.33 and 1.18.34, 2026-10-01; the ground truth is
// QUESTION_NOTES.md beside this file, pinned by `web/src/fixtures/panes/oc--question--*.txt`.
//
// All four shapes share one frame: a bare bar row, the TAB ROW, a bare row, the body, a bare row,
// the FOOTER, a bare row. The tab row holds one chip per question (its header) and a last chip
// `Confirm`, the chips two or more spaces apart. The footer's first hint is `⇆ tab`, and its
// verb says which dialog the active tab is:
//
//     ┃   Colour   Toppings   Size   Confirm        <- the active chip sits on its own background
//     ┃
//     ┃  Which toppings? (select all that apply)
//     ┃
//     ┃  1. [ ] Cheese                               <- `enter toggle`: a multi-select step
//     ┃     melty
//     ┃  5. [ ] Type your own answer
//     ┃
//     ┃  ⇆ tab  ↑↓ select  enter toggle  esc dismiss
//
//     enter toggle  + 2 tabs            a lone multi select          -> `multi-select`, checkbox
//     enter toggle  + 3 or more tabs    a multi-select step          -> `multi-select`, checkbox, steps
//     enter confirm + 3 or more tabs    a single-select step         -> `wizard`, question
//     enter submit  (no `↑↓ select`)    the Confirm tab, 2 tabs      -> `multi-select`, review
//                                       the Confirm tab, 3 or more   -> `wizard`, review
//
// The key plans are all measured (QUESTION_NOTES.md, "The recipe" and "Round two"), and each is the
// screen's own: a digit on a checkbox step TOGGLES that option and never advances, whatever the
// pointer is on; a digit on a single-select step SELECTS and advances; `Tab` goes to the next tab and
// the toggles survive; on the Confirm tab `Enter` submits and `Escape` dismisses the whole dialog,
// which ends the turn (so the cancel button says `Dismiss`, the footer's own word). A digit past the
// printed rows does nothing, and the free-text row's digit opens an input, so that row is never an
// option and no button ever sends it.
//
// WHICH CHIP IS ACTIVE, AND WHICH TAB HOLDS AN ANSWER, is read from STYLE, never from a colour name.
// The active chip is the one whose label sits on another background than the footer's own (the same
// reading the pointer chip gets). A chip that is not active is painted in the footer's bright ink
// when its question holds an answer and in the footer's grey ink when it does not (round two); an
// ink that is neither refuses the screen. The active chip's own colours are inverted, so its answer
// is read from the body: a ` ✓` row on a single-select step, a `[✓]` box on a checkbox step.
//
// WHAT REFUSES (null, so the raw mirror and the unread-dialog card with Escape cover it, ADR 0053):
//   * an unknown frame: a tab row whose last chip is not `Confirm`, two chips with one label, a
//     blank chip, no active chip or two, more than nine questions, a footer whose two inks are one.
//   * a free-text input that is OPEN. A digit is typed into it as text there, and nothing on the
//     card could say so. A checkbox step's COMMITTED free text (the input closed, the text grey
//     under the row) lifts, the row still not an option; a single-select step has no committed
//     state, so any row under its free-text row refuses.
//   * more than nine options, a numbering that does not run 1..n, no pointer chip or two, and a
//     Confirm body whose rows are not `Header: value` in tab order.
//
// The pointer is read as `question.ts` reads it and never sent: the toggles and the selects are
// digits. It is still demanded, because zero or two chips means the screen is not one this module
// understands.

import type { StyledLine } from "../../blocks";
import type { MultiPointer, MultiSelectModel, MultiSelectOption } from "../multi-select-model";
import type { WizardAnswer, WizardModel, WizardOption, WizardStepChip } from "../wizard-model";
import { backgroundOf } from "./dialog";
import { FREE_TEXT_LABEL, barDraftText, isBareBar, isBarRow, isOverlayRow, lineText, questionFooter, rstrip } from "./markers";
import {
  MAX_OPTIONS,
  footerBackground,
  footerInks,
  foregroundOf,
  locateFooter,
  pointedEntry,
  stripOverlayShared,
  stripOverlayTail,
  walkEntries,
  type Entry,
  type FooterInks,
} from "./question";

/** The detected dialog: the block kind to build, its model, and `startLine`, the first row the block
 *  REPLACES (the tab row). */
export type QuestionTabsRegion =
  | { kind: "multi-select"; model: MultiSelectModel; startLine: number }
  | { kind: "wizard"; model: WizardModel; startLine: number };

// How far above the footer the tab row may sit. Nine options with descriptions put the question 22
// rows up (QUESTION_NOTES.md, "Height"), and the tab row with its bare row adds two more.
const MAX_REGION_ROWS = 26;

// A tenth question has a tab and no digit-free way to say so, and nothing was measured past three.
const MAX_QUESTION_TABS = 9;

// The last chip of every tab row, and the heading and the empty value of the Confirm body.
const CONFIRM_LABEL = "Confirm";
const REVIEW_HEADING = "Review";
const NOT_ANSWERED = "(not answered)";

// A checkbox row's label: `[ ] Red`, `[✓] Red`.
const BOX = /^\[([ ✓x])\] (.+)$/;
// A single-select step's answered row: `Red ✓`, the mark OUTSIDE the label.
const CHOSEN_SUFFIX = / ✓$/;

// The key plans, one write each. See the header for the measurements behind them.
const ADVANCE_KEYS = ["Tab"];
const SUBMIT_KEYS = ["Enter"];
const CANCEL_KEYS = ["Escape"];
const BACK_KEYS = ["Left"];
// The footer's own word for `esc dismiss`, capitalised for a button.
const CANCEL_LABEL = "Dismiss";

/** What every reader below needs of the screen. */
interface Screen {
  lines: StyledLine[];
  texts: string[];
  footer: number;
  /** The background the footer is painted on, the base every row but a chip sits on. */
  base: string;
  inks: FooterInks;
}

/** One chip of the tab row. `answered` is meaningful only on a chip that is not active. */
interface Tab {
  label: string;
  active: boolean;
  answered: boolean;
}

/** The head of the dialog: its question, the row the tab row sits on, and whether any
 *  overlay evidence fired while reading it (gates the missing-padding allowance below). */
interface Head {
  question: string;
  tabRow: number;
  sawOverlay: boolean;
}

/**
 * Detect a tab-bar question dialog at the tail of `lines`, or null. Pure. Every step can only REJECT.
 */
export function detectQuestionTabs(lines: StyledLine[]): QuestionTabsRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  const footer = locateFooter(texts);
  if (footer < 0) return null;
  const kind = questionFooter(texts[footer]!)!;
  // No `⇆ tab` is the single lift's dialog, and this module never claims it.
  if (!kind.tabs) return null;

  const base = footerBackground(lines[footer]!, texts[footer]!);
  const inks = footerInks(lines[footer]!, texts[footer]!);
  if (base === null || inks === null) return null;
  const screen: Screen = { lines, texts, footer, base, inks };

  // The Confirm tab prints no list. Every other tab does, and its verb says which step it is.
  if (kind.verb === "submit") return kind.list ? null : detectReview(screen);
  if (!kind.list) return null;
  return detectStep(screen, kind.verb === "toggle");
}

// ---------------------------------------------------------------------------------------------
// A question step: the list of one question
// ---------------------------------------------------------------------------------------------

/** One numbered row read as the step's own kind: a checkbox row or a single-select row. */
interface ParsedRow {
  entry: Entry;
  /** The label with the box or the trailing ` ✓` taken off. */
  label: string;
  /** The checkbox glyph says checked, or the single-select row carries ` ✓`. */
  marked: boolean;
}

function detectStep(screen: Screen, checkbox: boolean): QuestionTabsRegion | null {
  const { lines, texts, footer, base } = screen;

  const walked = walkEntries(texts, footer, Math.max(0, footer - MAX_REGION_ROWS));
  if (walked === null) return null;
  const entries = walked.entries;

  // Every row is read as the step's own kind. A checkbox step whose row has no box, or a
  // single-select step whose row has one, is a shape this module does not know.
  const rows: ParsedRow[] = [];
  for (const entry of entries) {
    const row = parseRow(entry, checkbox);
    if (row === null) return null;
    rows.push(row);
  }

  // The free-text row: the last numbered row, when it carries opencode's own label. It is not an
  // option. Without it (a call that turns the custom answer off, not measured) every row is one,
  // as in the single lift. No other row may carry the label: the digit could not tell them apart.
  const last = rows[rows.length - 1]!;
  const free = last.label === FREE_TEXT_LABEL ? last : null;
  const choices = free === null ? rows : rows.slice(0, -1);
  if (choices.length === 0 || choices.length > MAX_OPTIONS) return null;
  if (choices.some((r) => r.label === FREE_TEXT_LABEL)) return null;
  // A single-select step marks an answered option, never the free-text row (nothing measured does).
  if (free !== null && !checkbox && free.marked) return null;
  if (free !== null && !freeTextClosed(screen, free.entry, checkbox)) return null;

  // The pointer: exactly one numbered row on another background than the footer's.
  const pointed = pointedEntry(lines, texts, entries, base);
  if (pointed < 0) return null;

  const head = locateHead(screen, entries[0]!.row);
  if (head === null) return null;
  const tabs = readTabs(screen, head.tabRow);
  if (tabs === null) return null;

  // On a step the active chip is a question's, never Confirm's. `Confirm` alone beside one question
  // is a lone multi select; a single-select step needs a second question to have a tab bar at all.
  const active = tabs.findIndex((t) => t.active);
  if (active === tabs.length - 1) return null;
  const lone = tabs.length === 2;
  if (!checkbox && lone) return null;

  // The active chip is inverted, so whether its question holds an answer comes from the body.
  const holdsAnswer = rows.some((r) => r.marked);
  const steps: WizardStepChip[] = tabs.slice(0, -1).map((t) => ({
    label: t.label,
    answered: t.active ? holdsAnswer : t.answered,
    current: t.active,
  }));

  const startLine = head.tabRow;
  const literal = texts.slice(startLine, footer + 1).join("\n");

  if (!checkbox) {
    const options: WizardOption[] = choices.map((r) => {
      const option: WizardOption = { label: r.label, keys: [String(r.entry.n)], chosen: r.marked, escape: false };
      if (r.entry.sub.length > 0)
        option.description = r.entry.sub.map((s) => stripOverlayShared(s).text.trim()).join(" ");
      return option;
    });
    const model: WizardModel = { phase: "question", steps, question: head.question, options, signature: literal };
    return { kind: "wizard", model, startLine };
  }

  const options: MultiSelectOption[] = choices.map((r) => {
    const option: MultiSelectOption = { n: r.entry.n, label: r.label, checked: r.marked };
    if (r.entry.sub.length > 0)
      option.description = r.entry.sub.map((s) => stripOverlayShared(s).text.trim()).join(" ");
    return option;
  });
  const onFree = free !== null && free.entry.n === pointed;
  const pointer: MultiPointer = onFree ? "other" : "option";
  const model: MultiSelectModel = {
    phase: "checkbox",
    question: head.question,
    options,
    escape: null,
    pointer,
    pointerRow: onFree ? null : pointed,
    steps: lone ? null : steps,
    // The next tab's own word: the next question's header, or `Confirm` after the last question.
    advanceLabel: tabs[active + 1]!.label,
    advanceKeys: ADVANCE_KEYS,
    toggle: "digit",
    // The comparators compare `checked` separately and the pointer is a style, so neither enters.
    signature: texts
      .slice(startLine, footer + 1)
      .map((t) => t.replace(/\[[✓x]\]/g, "[ ]"))
      .join("\n"),
    // The footer is static on opencode, so the literal region runs through it and still ends inside
    // the bridge's tail window (one or two bare bar rows sit under it).
    regionSignature: literal,
  };
  return { kind: "multi-select", model, startLine };
}

/** Read one numbered row as a checkbox row or a single-select row, or null when it is neither. */
function parseRow(entry: Entry, checkbox: boolean): ParsedRow | null {
  const box = BOX.exec(entry.label);
  if (checkbox) {
    if (box === null) return null;
    return { entry, label: box[2]!.trim(), marked: box[1] !== " " };
  }
  // A box on a single-select step is a checkbox under the wrong footer.
  if (box !== null || entry.label.startsWith("[")) return null;
  const marked = CHOSEN_SUFFIX.test(entry.label);
  return { entry, label: entry.label.replace(CHOSEN_SUFFIX, "").trim(), marked };
}

/**
 * Whether the free-text row is CLOSED. Opened, a row under it holds the placeholder or the typed
 * text and every digit becomes a character, so the screen is not claimed. A checkbox step keeps
 * COMMITTED text under the row after the input closes (round two): grey, the footer's own verb ink.
 * Typed text that is not yet committed is bright, and the placeholder is the label itself. A
 * single-select step has no committed state, so any row under its free-text row means open.
 *
 * Shared-exposure note: this shares walkEntries with the single-select lift, so a far-right
 * panel-overlay row under the free-text row lifts with it (the walk skips it before this
 * check ever sees it). Only near-gutter rows no geometry can tell apart still refuse here
 * (fail-safe: raw + unread card, never a mis-lift) — tracked as a follow-up (#347).
 */
function freeTextClosed(screen: Screen, free: Entry, checkbox: boolean): boolean {
  if (free.sub.length === 0) return true;
  if (!checkbox) return false;
  if (free.sub.join(" ") === FREE_TEXT_LABEL) return false;
  for (let k = 0; k < free.sub.length; k++) {
    const row = free.row + 1 + k;
    const span = contentSpan(screen.texts[row]!);
    if (span === null) return false;
    // Anything but the grey ink is open (bright, typed) or unknown: refuse either way.
    if (foregroundOf(screen.lines[row]!, span.start, span.end) !== screen.inks.grey) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// The Confirm tab
// ---------------------------------------------------------------------------------------------

function detectReview(screen: Screen): QuestionTabsRegion | null {
  const { texts, footer } = screen;

  // Walk up from the footer: bare rows separate the body's rows, and the tab row is the first row
  // whose text starts one space further in (the chip's own padding).
  const top = Math.max(0, footer - MAX_REGION_ROWS);
  const body: string[] = [];
  let tabRow = -1;
  let sawOverlay = false;
  for (let i = footer - 1; i >= top; i--) {
    if (isBareBar(texts[i]!)) continue;
    // Overlay rows are panel chrome, never review content — but body rows may hold user
    // answers, so their text is never stripped; a shared-row tail refuses via the checks
    // below instead.
    if (isOverlayRow(texts[i]!)) {
      sawOverlay = true;
      continue;
    }
    const inner = barDraftText(texts[i]!);
    if (inner === null) return null;
    if (inner.startsWith(" ")) {
      tabRow = i;
      break;
    }
    body.unshift(inner.trim());
  }
  if (tabRow < 0 || !barePaddingAbove(texts, tabRow, sawOverlay)) return null;

  const tabs = readTabs(screen, tabRow);
  if (tabs === null) return null;
  // The Confirm chip is the active one, so every question chip is judged by its ink.
  if (!tabs[tabs.length - 1]!.active) return null;
  const questions = tabs.slice(0, -1);

  // `Review`, then one `Header: value` row per question, in tab order. A value that wraps leaves a
  // row that is not one, and the count fails: refuse rather than read half an answer.
  if (body[0] !== REVIEW_HEADING || body.length !== questions.length + 1) return null;
  const answers: WizardAnswer[] = [];
  for (const [i, tab] of questions.entries()) {
    const prefix = `${tab.label}: `;
    const row = body[i + 1]!;
    if (!row.startsWith(prefix)) return null;
    const answer = row.slice(prefix.length).trim();
    if (answer.length === 0) return null;
    answers.push({ question: tab.label, answer });
  }
  const incomplete = answers.some((a) => a.answer === NOT_ANSWERED);
  const literal = texts.slice(tabRow, footer + 1).join("\n");

  // Two tabs is one multi-select question: the dialog's own Left goes back to its list. Three or
  // more is a many-question call, and the stepper's Left is already wired for it.
  if (tabs.length === 2) {
    const model: MultiSelectModel = {
      phase: "review",
      incomplete,
      pointer: null,
      submit: "keys",
      submitKeys: SUBMIT_KEYS,
      cancelKeys: CANCEL_KEYS,
      cancelLabel: CANCEL_LABEL,
      backKeys: BACK_KEYS,
      answers,
      signature: literal,
      regionSignature: literal,
    };
    return { kind: "multi-select", model, startLine: tabRow };
  }
  const steps: WizardStepChip[] = questions.map((t) => ({ label: t.label, answered: t.answered, current: false }));
  const model: WizardModel = {
    phase: "review",
    steps,
    answers,
    incomplete,
    submitKeys: SUBMIT_KEYS,
    cancelKeys: CANCEL_KEYS,
    cancelLabel: CANCEL_LABEL,
    signature: literal,
  };
  return { kind: "wizard", model, startLine: tabRow };
}

// ---------------------------------------------------------------------------------------------
// The frame: the question above a list, and the tab row above that
// ---------------------------------------------------------------------------------------------

/**
 * The question paragraph over the first option, and the tab row over it. The paragraph is the run
 * of gutter-aligned text rows (a narrow pane wraps it, so the rows join with one space) under a
 * bare row; the tab row sits above that bare row. Null when the frame is anything else.
 */
function locateHead(screen: Screen, firstOption: number): Head | null {
  const { texts, footer } = screen;
  let q = firstOption - 1;
  let sawOverlay = false;
  while (q >= 0 && (isBareBar(texts[q]!) || isOverlayRow(texts[q]!))) {
    if (isOverlayRow(texts[q]!)) sawOverlay = true;
    q--;
  }
  const parts: string[] = [];
  while (q >= 0 && footer - q <= MAX_REGION_ROWS) {
    // Overlay chrome is not dialog content: skip it without breaking the run.
    if (isOverlayRow(texts[q]!)) {
      sawOverlay = true;
      q--;
      continue;
    }
    const inner = isBarRow(texts[q]!) ? barDraftText(texts[q]!) : null;
    if (inner === null) break;
    const shared = stripOverlayShared(inner);
    if (shared.cut) sawOverlay = true;
    const clean = shared.text;
    if (clean.trim().length === 0 || clean.startsWith(" ")) break;
    parts.unshift(clean.trim());
    q--;
  }
  if (parts.length === 0) return null;

  // One or more bare rows between the tab row and the question.
  let seenGap = false;
  while (q >= 0 && (isBareBar(texts[q]!) || isOverlayRow(texts[q]!))) {
    seenGap = true;
    if (isOverlayRow(texts[q]!)) sawOverlay = true;
    q--;
  }
  if (!seenGap && !sawOverlay) return null;
  if (q < 0 || footer - q > MAX_REGION_ROWS) return null;
  const inner = isBarRow(texts[q]!) ? barDraftText(texts[q]!) : null;
  if (inner === null || !inner.startsWith(" ") || inner.trim().length === 0) return null;
  if (!barePaddingAbove(texts, q, sawOverlay)) return null;
  return { question: parts.join(" "), tabRow: q, sawOverlay };
}

/** The dialog's top padding: bare bar rows, with overlay rows counting as padding too — they
 *  are panel chrome, neither transcript nor another dialog (a sidebar can paint over the very
 *  row that separates the tab row from the transcript). Above the run must be nothing but the
 *  transcript: a TEXT bar row there is another dialog's body, or the user's own message. */
function barePaddingAbove(texts: string[], tabRow: number, sawOverlay: boolean): boolean {
  let pad = tabRow - 1;
  let seen = false;
  while (pad >= 0 && (isBareBar(texts[pad]!) || isOverlayRow(texts[pad]!))) {
    seen = true;
    pad--;
  }
  if (!seen && !sawOverlay) return false;
  let above = pad;
  while (above >= 0 && isOverlayRow(texts[above]!)) above--;
  return !(above >= 0 && isBarRow(texts[above]!) && !isBareBar(texts[above]!));
}

/**
 * The chips of the tab row, or null when the row is not one: fewer than two chips, more than nine
 * questions, a last chip that is not `Confirm`, a repeated label, no active chip or two, or a chip
 * that is neither bright nor grey. A chip is a run of words one space apart; two or more spaces end
 * it. The active chip is the one whose label is on another background than the footer's.
 */
function readTabs(screen: Screen, tabRow: number): Tab[] | null {
  const { lines, texts, base, inks } = screen;
  const text = stripOverlayTail(texts[tabRow]!);
  const line = lines[tabRow]!;
  const bar = text.indexOf("┃");

  const found: { label: string; start: number; end: number }[] = [];
  const chip = /\S+(?: \S+)*/g;
  for (let m = chip.exec(text); m !== null; m = chip.exec(text)) {
    if (m.index === bar) continue;
    found.push({ label: m[0], start: m.index, end: m.index + m[0].length });
  }
  if (found.length < 2 || found.length > MAX_QUESTION_TABS + 1) return null;
  if (found[found.length - 1]!.label !== CONFIRM_LABEL) return null;
  if (new Set(found.map((c) => c.label)).size !== found.length) return null;

  const tabs: Tab[] = [];
  for (const [i, c] of found.entries()) {
    const active = (backgroundOf(line, c.start, c.end) ?? "") !== base;
    // `Confirm` holds no answer, so its ink says nothing; every question chip's does.
    if (active || i === found.length - 1) {
      tabs.push({ label: c.label, active, answered: false });
      continue;
    }
    const ink = foregroundOf(line, c.start, c.end);
    if (ink !== inks.bright && ink !== inks.grey) return null;
    tabs.push({ label: c.label, active, answered: ink === inks.bright });
  }
  if (tabs.filter((t) => t.active).length !== 1) return null;
  return tabs;
}

/** The first and last column of the text on a bar row (past the bar and its gutter), or null when
 *  the row carries none. */
function contentSpan(text: string): { start: number; end: number } | null {
  const bar = text.indexOf("┃");
  if (bar < 0) return null;
  const after = text.slice(bar + 1);
  const first = after.search(/\S/);
  if (first < 0) return null;
  return { start: bar + 1 + first, end: text.length };
}
