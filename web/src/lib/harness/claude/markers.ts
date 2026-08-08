// Shared lexing helpers over the parsed `StyledLine[]` — the primitives every Claude-Code grammar
// (chrome stripping, prompt-select extraction, and — in T3 — history segmentation) leans on. They
// operate on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (e.g. the `❯` pointer and the `1.` are
// separate styled segments). Pure functions, no I/O, no React.

import { isBlank, lineText } from "../../blocks";
import { CLAUDE_RULE_GLYPH_CLASS } from "../../rule-glyphs";
import type { PromptFamily } from "../prompt-model";

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar, so they live in the
// neutral core (lib/blocks.ts) where the renderer can reach them without importing a harness. They
// are re-exported here so the Claude grammars keep their single import site.
export { isBlank, lineText };

// A whole line that is nothing but horizontal-rule glyphs: Unicode box-drawing (U+2500–U+257F, which
// includes the dashed forms ╌ ╍ ┄ ┅ …), the block eighths used as rules (U+2581–U+2594, e.g. ▁ ▔),
// and the figure/en/em/horizontal-bar dashes (U+2012–U+2015). ASCII `-`/`=` are deliberately
// excluded so markdown and code rules in real agent output aren't mistaken for TUI separators.
const RULE_ONLY = new RegExp(`^[${CLAUDE_RULE_GLYPH_CLASS}]+$`);

/** True when the whole line is a horizontal rule / separator (ignoring surrounding spaces). */
export function isHorizontalRule(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  return compact.length >= 3 && RULE_ONLY.test(compact);
}

// A run of 20+ consecutive rule glyphs anywhere on the line — the signature of a TUI *box border*,
// which (unlike a pure rule) can carry an embedded label: Claude's input-box top border reads e.g.
// "──────────… collie upgrades ──". 20 unbroken box-drawing glyphs never occur in ordinary text, so
// this stays a confident border test even with a label spliced in.
const RULE_RUN = new RegExp(`[${CLAUDE_RULE_GLYPH_CLASS}]{20,}`);

/** True when the line contains a long unbroken run of rule glyphs (a box border, label or not). */
export function isBoxBorder(text: string): boolean {
  return RULE_RUN.test(text);
}

// A MULTI-question AskUserQuestion renders a step indicator above the current question — one
// checkbox glyph per sub-question plus a Submit, wrapped in ←/→ navigation, e.g.
//   "←  ☒ Focus area  ☐ Scope  ☐ Workflow  ✔ Submit  →"
// A single-question dialog never shows this. We can't answer a wizard with one digit+Enter (that
// submits with only the first question answered), so detecting this line makes prompt-select bail.
// The wizard grammar (wizard.ts) claims the dialog first in buildBlocks; this bail remains as the
// safety net for a wizard that grammar misses (then the raw mirror + keys pad drive it).
const STEP_GLYPH = /[☐☒☑✔✅]/g;

/** True when a line is a multi-question stepper header (≥2 step/checkbox glyphs on one line). */
export function isMultiStepHeader(text: string): boolean {
  const m = text.match(STEP_GLYPH);
  return m !== null && m.length >= 2;
}

// The dialog families are part of the NEUTRAL prompt-select contract (harness/prompt-model.ts) —
// each family pins a keystroke recipe the renderer and the guard rely on. Re-exported here because
// `classifyFooter`, the Claude-specific act of reading a footer, is what produces one.
export type { PromptFamily };

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
