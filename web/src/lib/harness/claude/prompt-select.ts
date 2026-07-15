// Prompt-select detection — the grammar that recognises a Claude Code single-choice dialog sitting
// at the TAIL of a pane buffer (AskUserQuestion selects, permission prompts, the folder-trust
// prompt, and plan approval) and lifts it into a `PromptModel` the UI renders as native buttons.
//
// Everything here is a PURE function over `StyledLine[]`, driven entirely by the fixture corpus
// (web/src/fixtures/panes/*.txt). It never touches a pane or the network. The tail invariant is the
// backbone: the dialog's footer hint bar is the LAST non-blank line of the buffer, so a menu that
// has scrolled up (with real output below it) simply doesn't match — the false-positive guard.

import type { StyledLine } from "../../blocks";
import {
  classifyFooter,
  isBlank,
  isHorizontalRule,
  isMultiStepHeader,
  lineText,
  type PromptFamily,
} from "./markers";

export type { PromptFamily };

/** One selectable option, up-levelled into a tappable button. */
export interface PromptOption {
  /** The visible option label (rendered as a React text node — the XSS boundary is unchanged). */
  label: string;
  /** Secondary descriptive line(s) the dialog supplies, joined with spaces. Absent when none. */
  description?: string;
  /**
   * The keys to send (in order) to choose this option, per the dialog family's verified recipe:
   * `select` needs the digit THEN `Enter` ("Enter to select"); `permission`/`trust`/`plan` confirm
   * on the digit ALONE (a trailing Enter there would leak into whatever renders next).
   */
  keys: string[];
}

/** A recognised single-choice dialog: the question, its selectable options, and the family. */
export interface PromptModel {
  question: string;
  options: PromptOption[];
  family: PromptFamily;
  /**
   * A byte-signature of the dialog's on-screen region — a bounded run of lines from ABOVE the first
   * option (capturing the subject: the diff/command/context the dialog is about) through the footer.
   * The race guard compares this so a same-SHAPED successor dialog (identical question + labels but a
   * different subject — e.g. a second edit to the same file) can't pass as the one the user saw.
   * Herdr's `revision` is a stub, so this content signature is the load-bearing freshness check.
   */
  signature: string;
}

// Lines above the first option to fold into the signature — enough to capture a dialog's subject
// (the diff/command shown above the question), which is what distinguishes two same-shaped prompts.
// A blocked agent doesn't churn output above its own prompt, so a generous window stays stable; and
// a false "changed" (over-wide capture) is a harmless refresh, whereas a false match types a
// keystroke into a terminal — so we err wide.
const SIGNATURE_LOOKBACK = 40;

/** The dialog's region signature: lines [firstOption − LOOKBACK … footer], joined. Pure of `lines`
 *  offset, so the frozen model and a fresh re-derivation of the SAME dialog produce equal strings. */
function regionSignature(texts: string[], firstOpt: number, footer: number): string {
  return texts.slice(Math.max(0, firstOpt - SIGNATURE_LOOKBACK), footer + 1).join("\n");
}

// A numbered menu row: an optional "❯ " pointer (the currently-highlighted option), then "N." then
// the label. Matched on the TRIMMED line text (leading indentation varies per dialog). The literal
// dot after the number is what separates a real option ("1. Yes") from a diff line-number
// ("1 hello") or a rating colon-list ("1: Bad  2: Fine") — neither of which is a menu row.
const OPTION_ROW = /^(?:❯\s*)?(\d+)\.\s+(.+)$/;

interface OptionRow {
  /** Index of this row in the input `lines` array. */
  index: number;
  /** The option's own number (what the user would press). */
  n: number;
  label: string;
}

/** Parse a numbered menu row ("❯ 2. Label" / "2. Label") into its number + label, or null.
 *  Shared with the wizard grammar (wizard.ts) — the multi-question dialog uses the same row shape. */
export function parseOptionRow(text: string): { n: number; label: string } | null {
  const m = OPTION_ROW.exec(text.trim());
  if (!m) return null;
  return { n: Number(m[1]), label: m[2]!.trim() };
}

// A Claude single-choice menu ALWAYS restarts its numbering at 1 directly above the footer, so the
// menu is the maximal SUFFIX of the collected rows reading 1,2,…,m; stray numbered lines from the
// dialog BODY (a plan's "1./2./3." steps, say) sit ABOVE it and are excluded. Walk up from the last
// row while each is exactly one less than the row below, then require the run to start at 1.
// Invariant: the menu's first number is 1 and the body row above it is ≥1, so `bodyLast === 0` is
// impossible — the descending walk always breaks exactly at the menu boundary. Empty when the tail
// isn't a real menu (first number ≠ 1). Generic over the two grammars' row shapes (both carry `n`).
// Shared with the wizard grammar (wizard.ts), which has the identical body-list hazard.
export function trailingMenuRows<T extends { n: number }>(rows: T[]): T[] {
  if (rows.length === 0) return [];
  let s = rows.length - 1;
  while (s > 0 && rows[s - 1]!.n === rows[s]!.n - 1) s--;
  return rows[s]!.n === 1 ? rows.slice(s) : [];
}

// Free-text escape rows are answered by TYPING, not a keystroke — the app's composer already covers
// that — so they are never up-levelled into a button (spec T2). The two known phrases:
// "Type something." (AskUserQuestion) and "Tell Claude what to change" (plan approval).
// Shared with the wizard grammar (wizard.ts), which drops the same rows.
export function isFreeTextLabel(label: string): boolean {
  return /^type something\b/i.test(label) || /^tell claude what to change\b/i.test(label);
}

// A multiSelect checkbox prefix on an option label: "[ ] Cheese" (unchecked) / "[✔] Mushrooms"
// (checked; ✔ ✓ x X all count as checked). Its PRESENCE is the discriminator that separates a
// multiSelect dialog from a single-choice one — the prompt-select/wizard grammars leave a checkbox
// step to the multi-select grammar (wizard.ts bails when an option row carries it). Returns the
// checked state plus the label with the prefix stripped, or null when there's no checkbox prefix.
// Shared with wizard.ts (the bail) and multi-select.ts (the parse).
const CHECKBOX_PREFIX = /^\[[ xX✔✓]\]\s*/;
export function checkboxState(label: string): { checked: boolean; rest: string } | null {
  const m = CHECKBOX_PREFIX.exec(label);
  if (!m) return null;
  return { checked: /[xX✔✓]/.test(m[0]), rest: label.slice(m[0].length) };
}

// Options live within a couple dozen lines of the footer; scanning a bounded window keeps a stray
// "N." far up in scrollback history from ever being mistaken for a menu row.
const OPTION_SCAN_WINDOW = 24;
// The footer must sit right below the last option — at most a hint sub-line + a blank between them.
const MAX_FOOTER_GAP = 3;
// The question is close above the first option; bound the upward search so it can't wander into
// unrelated history.
const QUESTION_SCAN_LIMIT = 12;

/**
 * The full detection result buildBlocks needs: the model PLUS `startLine`, the index of the first
 * option row — the menu region is [`startLine` … tail], which the renderer replaces with buttons.
 * Everything above `startLine` (including the question and any dialog preamble) stays raw, so no
 * context is lost and the question isn't shown twice.
 */
export interface PromptRegion {
  model: PromptModel;
  startLine: number;
}

/**
 * Detect a single-choice dialog at the tail of `lines`. Returns the model + its start line, or null
 * when the tail isn't a recognised menu. Pure; the caller owns pane access.
 */
export function detectPromptSelectRegion(lines: StyledLine[]): PromptRegion | null {
  const texts = lines.map(lineText);

  // 1. Footer = the last non-blank line; it MUST classify as a menu footer. This is the tail anchor
  //    — a menu that has scrolled up has non-menu output below it, so its footer isn't last and we
  //    bail here (the false-positive gate).
  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;
  const family = classifyFooter(texts[fi]!);
  if (!family) return null;

  // 2. Numbered option rows just above the footer. The menu is the trailing 1,2,…,m run of them
  //    (see trailingMenuRows); scattered "N." lines from the dialog body sit above it and drop out.
  const from = Math.max(0, fi - OPTION_SCAN_WINDOW);
  const rows: OptionRow[] = [];
  for (let i = from; i < fi; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed) rows.push({ index: i, n: parsed.n, label: parsed.label });
  }
  if (rows.length < 2) return null;
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null; // ≥2 rows numbered 1,2,…,m — else not a single-choice menu tail.
  // A menu numbered past 9 would need a two-key digit ("10"), which Herdr's send_keys rejects — so
  // up-levelling it into buttons would emit an unsendable keystroke plan. Real Claude menus are ≤6
  // options; bail to the raw mirror + keys pad rather than render a broken button. (menu is
  // 1..m consecutive by construction, so length > 9 == a row numbered ≥10.)
  if (menu.length > 9) return null;
  const firstOpt = menu[0]!.index;
  const lastOpt = menu[menu.length - 1]!.index;
  // The options must sit against the footer (only a hint sub-line / blank may separate them).
  if (fi - lastOpt > MAX_FOOTER_GAP) return null;

  // Bail on a MULTI-question AskUserQuestion (only the `select` family is ever multi-step). Its
  // stepper header ("☒ Focus area  ☐ Scope  ✔ Submit") means there are further questions we can't
  // see and can't answer with one digit+Enter — up-levelling only the first question would submit a
  // half-filled form. The wizard grammar (wizard.ts) runs FIRST in buildBlocks and claims this
  // dialog; the bail stays as its safety net (a missed wizard falls to raw + the keys pad). The
  // header sits just above the current question, within the option-scan window.
  if (family === "select") {
    const top = Math.max(0, firstOpt - QUESTION_SCAN_LIMIT);
    for (let i = top; i < fi; i++) {
      if (isMultiStepHeader(texts[i]!)) return null;
    }
  }

  // 3. Question = the nearest line above the first option that contains "?", stopping at a rule so
  //    the search can't cross out of the dialog. Every dialog's prompt carries a "?".
  let question = "";
  for (let i = firstOpt - 1, seen = 0; i >= 0 && seen < QUESTION_SCAN_LIMIT; i--, seen++) {
    const t = texts[i]!;
    if (isHorizontalRule(t)) break;
    if (t.includes("?")) {
      question = t.trim();
      break;
    }
  }
  if (!question) return null;

  // 4. Build the options, attaching any description continuation lines and dropping free-text rows.
  //    `keys` carries the option's ORIGINAL number, so pressing it still selects the right row even
  //    though free-text rows are omitted from the rendered buttons.
  const options: PromptOption[] = [];
  for (let r = 0; r < menu.length; r++) {
    const row = menu[r]!;
    if (isFreeTextLabel(row.label)) continue;
    const nextIdx = r + 1 < menu.length ? menu[r + 1]!.index : fi;
    const desc: string[] = [];
    for (let i = row.index + 1; i < nextIdx; i++) {
      const t = texts[i]!;
      if (isBlank(t) || isHorizontalRule(t) || parseOptionRow(t)) continue;
      desc.push(t.trim());
    }
    options.push({
      label: row.label,
      description: desc.length ? desc.join(" ") : undefined,
      keys: family === "select" ? [String(row.n), "Enter"] : [String(row.n)],
    });
  }
  if (options.length === 0) return null;

  const signature = regionSignature(texts, firstOpt, fi);
  return { model: { question, options, family, signature }, startLine: firstOpt };
}

/**
 * Detect a single-choice dialog at the tail of `lines`, returning just the model (or null). The
 * thin public matcher — used by the race guard to re-derive `{question, options}` from a fresh
 * buffer and by tests. buildBlocks uses {@link detectPromptSelectRegion} for the render boundary.
 */
export function detectPromptSelect(lines: StyledLine[]): PromptModel | null {
  return detectPromptSelectRegion(lines)?.model ?? null;
}
