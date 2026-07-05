// Prompt-select detection — the grammar that recognises a Claude Code single-choice dialog sitting
// at the TAIL of a pane buffer (AskUserQuestion selects, permission prompts, the folder-trust
// prompt, and plan approval) and lifts it into a `PromptModel` the UI renders as native buttons.
//
// Everything here is a PURE function over `StyledLine[]`, driven entirely by the fixture corpus
// (web/src/fixtures/panes/*.txt). It never touches a pane or the network. The tail invariant is the
// backbone: the dialog's footer hint bar is the LAST non-blank line of the buffer, so a menu that
// has scrolled up (with real output below it) simply doesn't match — the false-positive guard.

import type { StyledLine } from "../blocks";
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

function parseOptionRow(text: string): { n: number; label: string } | null {
  const m = OPTION_ROW.exec(text.trim());
  if (!m) return null;
  return { n: Number(m[1]), label: m[2]!.trim() };
}

// Free-text escape rows are answered by TYPING, not a keystroke — the app's composer already covers
// that — so they are never up-levelled into a button (spec T2). The two known phrases:
// "Type something." (AskUserQuestion) and "Tell Claude what to change" (plan approval).
function isFreeTextLabel(label: string): boolean {
  return /^type something\b/i.test(label) || /^tell claude what to change\b/i.test(label);
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

  // 2. Numbered option rows just above the footer. Require ≥2 rows numbered exactly 1,2,…,k in
  //    order (a single-choice menu), so scattered "N." lines can't masquerade as a menu.
  const from = Math.max(0, fi - OPTION_SCAN_WINDOW);
  const rows: OptionRow[] = [];
  for (let i = from; i < fi; i++) {
    const parsed = parseOptionRow(texts[i]!);
    if (parsed) rows.push({ index: i, n: parsed.n, label: parsed.label });
  }
  if (rows.length < 2) return null;
  for (let k = 0; k < rows.length; k++) {
    if (rows[k]!.n !== k + 1) return null;
  }
  const firstOpt = rows[0]!.index;
  const lastOpt = rows[rows.length - 1]!.index;
  // The options must sit against the footer (only a hint sub-line / blank may separate them).
  if (fi - lastOpt > MAX_FOOTER_GAP) return null;

  // Bail on a MULTI-question AskUserQuestion (only the `select` family is ever multi-step). Its
  // stepper header ("☒ Focus area  ☐ Scope  ✔ Submit") means there are further questions we can't
  // see and can't answer with one digit+Enter — up-levelling only the first question would submit a
  // half-filled form. Falling through to raw lets the user drive the wizard with the keys pad. The
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
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (isFreeTextLabel(row.label)) continue;
    const nextIdx = r + 1 < rows.length ? rows[r + 1]!.index : fi;
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

  return { model: { question, options, family }, startLine: firstOpt };
}

/**
 * Detect a single-choice dialog at the tail of `lines`, returning just the model (or null). The
 * thin public matcher — used by the race guard to re-derive `{question, options}` from a fresh
 * buffer and by tests. buildBlocks uses {@link detectPromptSelectRegion} for the render boundary.
 */
export function detectPromptSelect(lines: StyledLine[]): PromptModel | null {
  return detectPromptSelectRegion(lines)?.model ?? null;
}
