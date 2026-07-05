// Shared lexing helpers over the parsed `StyledLine[]` — the primitives every Claude-Code grammar
// (chrome stripping, prompt-select extraction, and — in T3 — history segmentation) leans on. They
// operate on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (e.g. the `❯` pointer and the `1.` are
// separate styled segments). Pure functions, no I/O, no React.

import type { StyledLine } from "../blocks";

/** The visible text of a line: its segments' text concatenated (the "\n" separator lives between
 *  lines, so a single line's text never contains one). */
export function lineText(line: StyledLine): string {
  return line.segments.map((s) => s.text).join("");
}

/** True when a line is empty or only whitespace. */
export function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

// A whole line that is nothing but horizontal-rule glyphs: Unicode box-drawing (U+2500–U+257F, which
// includes the dashed forms ╌ ╍ ┄ ┅ …), the block eighths used as rules (U+2581–U+2594, e.g. ▁ ▔),
// and the figure/en/em/horizontal-bar dashes (U+2012–U+2015). ASCII `-`/`=` are deliberately
// excluded so markdown and code rules in real agent output aren't mistaken for TUI separators.
const RULE_ONLY = /^[─-╿▁-▔‒-―]+$/;

/** True when the whole line is a horizontal rule / separator (ignoring surrounding spaces). */
export function isHorizontalRule(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length >= 3 && RULE_ONLY.test(compact);
}

// A run of 20+ consecutive rule glyphs anywhere on the line — the signature of a TUI *box border*,
// which (unlike a pure rule) can carry an embedded label: Claude's input-box top border reads e.g.
// "──────────… collie upgrades ──". 20 unbroken box-drawing glyphs never occur in ordinary text, so
// this stays a confident border test even with a label spliced in.
const RULE_RUN = /[─-╿▁-▔‒-―]{20,}/;

/** True when the line contains a long unbroken run of rule glyphs (a box border, label or not). */
export function isBoxBorder(text: string): boolean {
  return RULE_RUN.test(text);
}

// A MULTI-question AskUserQuestion renders a step indicator above the current question — one
// checkbox glyph per sub-question plus a Submit, wrapped in ←/→ navigation, e.g.
//   "←  ☒ Focus area  ☐ Scope  ☐ Workflow  ✔ Submit  →"
// A single-question dialog never shows this. We can't answer a wizard with one digit+Enter (that
// submits with only the first question answered), and we don't render a multi-step UI yet — so
// detecting this line makes prompt-select bail to the raw mirror instead of mis-sending keystrokes.
const STEP_GLYPH = /[☐☒☑✔✅]/g;

/** True when a line is a multi-question stepper header (≥2 step/checkbox glyphs on one line). */
export function isMultiStepHeader(text: string): boolean {
  const m = text.match(STEP_GLYPH);
  return m !== null && m.length >= 2;
}

/** The single-choice dialog families Claude Code renders, discriminated by their footer hint bar. */
export type PromptFamily = "select" | "permission" | "trust" | "plan";

/**
 * Classify a candidate footer line — the hint bar at the very bottom of a Claude dialog — into a
 * dialog family, or null when it isn't a recognised menu footer. The footer is the single most
 * stable discriminator: Claude Code generates it (unlike the user-configured statusline), and the
 * confirm phrase pins the keystroke recipe:
 *
 *   - "Enter to select …"  → select     (AskUserQuestion: the digit THEN Enter)
 *   - "Enter to confirm …" → trust      (folder-trust prompt: the digit alone)
 *   - "… Tab to amend …"   → permission (edit/bash "Do you want to proceed?": the digit alone)
 *   - "ctrl+g to edit …" or a "~/.claude/plans/…" path → plan (ExitPlanMode: the digit alone)
 *
 * Case-insensitive and anchored only on the confirm phrase, so per-install extra hints
 * (ctrl+e to explain, ↑/↓ to navigate, …) don't disturb the classification.
 */
export function classifyFooter(text: string): PromptFamily | null {
  const t = text.toLowerCase();
  if (/\benter to select\b/.test(t)) return "select";
  if (/\benter to confirm\b/.test(t)) return "trust";
  if (/ctrl\+g to edit\b/.test(t) || /\.claude\/plans\//.test(t)) return "plan";
  if (/\btab to amend\b/.test(t)) return "permission";
  return null;
}
