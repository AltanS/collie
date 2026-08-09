// Shared lexing helpers over the parsed `StyledLine[]` — the primitives every Claude-Code grammar
// (chrome stripping, prompt-select extraction, and — in T3 — history segmentation) leans on. They
// operate on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (e.g. the `❯` pointer and the `1.` are
// separate styled segments). Pure functions, no I/O, no React.

import { isBlank, lineText } from "../../blocks";
import { displayWidth } from "../../text-width";
import type { PromptFamily } from "../prompt-model";

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar, so they live in the
// neutral core (lib/blocks.ts) where the renderer can reach them without importing a harness. They
// are re-exported here so the Claude grammars keep their single import site.
export { isBlank, lineText };

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

// A "bare" input-box border: the ONE glyph Claude actually draws its own input-box rules with — U+2500
// (─) — repeated, nothing else, with NO interior whitespace stripped first (a real bare border has
// none). Floor of 8 DISPLAY CELLS (terminal columns, via text-width.ts's `displayWidth`) —
// comfortably below the narrowest observed real capture (19 columns), comfortably above a short
// prose dash run. Cells, not UTF-16 `.length`: a session/job label spliced into a labelled border
// can be CJK (real in this deployment — observed live labels are sometimes Japanese), and CJK
// glyphs are 2 cells but 1 UTF-16 code unit each, so `.length` under-counts an 8-cell CJK-labelled
// border into a false rejection; a combining-mark label goes the other way (`.length` counts the
// base and its combining mark separately, `displayWidth` correctly counts the pair as the ONE cell
// they render as), so `.length` can also over-count a narrower-than-8-cell border into a false
// acceptance.
const BARE_BORDER_MIN = 8;
const BARE_BORDER = /^─+$/;

// A LABELLED border: a run of U+2500, a label, a run of U+2500 again — the shape Claude splices a
// session/job name into its input box's TOP border with, e.g.
// "───── japanese technical troubleshooting ──" (observed flanks 5/2). Flanks are U+2500 ONLY (not
// the wider rule-glyph family below) and each must be at least 2 glyphs. `isBoxBorder` additionally
// requires the captured label to contain at least one character that is NEITHER a rule-class glyph
// nor whitespace — a real word — so a middle of more rule glyphs and spaces ("── ─ ──") or bare
// whitespace ("──   ──") does not count as a label.
const LABELLED_BORDER = /^─{2,}\s+(.+)\s+─{2,}$/;

// The generic rule-glyph class (same one isHorizontalRule tests) plus whitespace — used ONLY to
// reject a LABELLED_BORDER match whose "label" turns out to be more rule glyphs/spaces, not prose.
const RULE_OR_SPACE_ONLY = /^[─-╿▁-▔‒-―\s]*$/;

// Both LABELLED_BORDER above and LOOSE_LABELLED_BORDER below are additionally required (in
// isBoxBorder / isInputBoxTopBorder) to have a total DISPLAY WIDTH >= BARE_BORDER_MIN — the SAME
// floor the bare border already enforces, not a separate, smaller one. The renderer draws a box's top
// and bottom border at the same width, and the bare bottom border already has to clear
// BARE_BORDER_MIN, so no real labelled TOP border can physically be narrower than that: a "labelled
// border" shorter than the narrowest legal bare border (e.g. `─ x ─`, 5 columns) is not a shape the
// renderer can produce, whatever its flank lengths look like in isolation — per-flank minimums alone
// don't rule it out, only a shared total-width floor does. (A stronger version — checking a top
// border's width against the ACTUAL bottom border captured at locateInputBox step (e) — was
// considered and rejected: labels can hold CJK, so exact equality would need display-width
// measurement here for only a marginal tightening over this shared floor — which is `displayWidth`
// anyway, so this floor already pays that cost; see the CJK/combining-mark note on BARE_BORDER_MIN.)

/**
 * True when the line is specifically a CLAUDE INPUT-BOX border: the one glyph (U+2500) Claude draws
 * its own box rules with, either bare (BARE_BORDER, any width ≥ BARE_BORDER_MIN) or carrying a single
 * embedded label (LABELLED_BORDER, each flank ≥ 2 glyphs, with a label that isn't itself just more
 * rule glyphs and whitespace).
 *
 * Deliberately DECOUPLED from `isHorizontalRule` above, which stays generic on purpose — menu.ts and
 * the select detectors need its wider box-drawing/block-eighth/dash family to recognise a dialog's own
 * rules. That generality is exactly what made an earlier version of THIS function unsafe: reusing
 * isHorizontalRule here meant a spaced-out prose separator like "— — —" (isHorizontalRule strips ALL
 * interior whitespace before testing, so it compacts to "———" and passes) or a `│ │ │` table divider
 * would both read as an input-box border — letting a stray prose or table line pair up with an
 * unrelated `❯` line elsewhere on screen to complete the FULL bottom-border → ❯ → top-border shape
 * `locateInputBox` looks for, defeating that structural guard from the inside instead of being caught
 * by it. Restricting to the single glyph Claude actually uses closes that hole. A dialog border with
 * corner glyphs (`╭────╮`) is deliberately NOT an input-box border either — Claude never draws its
 * input box that way, only its outer chrome/dialogs do, and conflating the two is the same class of
 * mistake.
 *
 * This is layer one of two: the real protection is still structural, not lexical. `locateInputBox`
 * (chrome.ts) only trusts a border when the full bottom-border → ❯ → top-border shape lines up around
 * it (plus the draft-walk cap, MAX_DRAFT_LINES in chrome.ts, bounding how far apart the pieces of that
 * shape may sit), so a lone matching line elsewhere on screen does nothing on its own.
 */
export function isBoxBorder(text: string): boolean {
  const trimmed = text.trim();
  // Shared width floor, in DISPLAY CELLS (see the comment above) — not `.length`, which a CJK label
  // undercounts and a combining-mark label overcounts. For a pure-U+2500 bare border cells == `.length`
  // (the glyph is 1 cell, 1 UTF-16 unit), so `displayWidth` here changes nothing for that branch; it's
  // used uniformly with the labelled branch below rather than kept as two different measurements.
  if (displayWidth(trimmed) < BARE_BORDER_MIN) return false;
  if (BARE_BORDER.test(trimmed)) return true;
  const m = LABELLED_BORDER.exec(trimmed);
  if (m === null) return false;
  return !RULE_OR_SPACE_ONLY.test(m[1]!); // label must hold a real (non-rule, non-blank) character
}

// The LOOSER labelled-border shape a Claude input-box TOP border can actually take, per the bundled
// renderer's own label-placement math (traced from the shipped binary): it picks a left offset `a`
// clamped `Math.max(1, Math.min(a, borderWidth - labelWidth - 1))` and draws `a` rule glyphs, the
// label, then the remainder. That clamp's floor of 1 — not 2 — is what a real capture can render:
// align:"center", or align:"end" with a zero offset, can leave EITHER flank at exactly one glyph
// (`──── fast mode ─`). Everything else about the shape is unchanged from LABELLED_BORDER: flanks are
// U+2500 only, the label must hold a real (non-rule, non-blank) character, and — same as
// LABELLED_BORDER — the total DISPLAY WIDTH must still clear BARE_BORDER_MIN (see the comment on that
// shared floor above): 1-glyph flanks alone are not enough, since `─ x ─` is 5 columns, narrower than
// any bare border the renderer can actually draw.
const LOOSE_LABELLED_BORDER = /^─{1,}\s+(.+)\s+─{1,}$/;

/**
 * True when the line is a Claude input-box TOP border: everything `isBoxBorder` accepts, plus a
 * labelled border whose flanks are as short as 1 glyph (LOOSE_LABELLED_BORDER, still subject to the
 * shared BARE_BORDER_MIN total-width floor) — the shape the renderer's own clamp can produce that
 * `isBoxBorder`'s 2-glyph floor rejects.
 *
 * Used ONLY at `locateInputBox`'s step (e) — the LAST anchor it checks, after the bottom border, the
 * "❯" prompt line, and the draft-walk cap (MAX_DRAFT_LINES, chrome.ts) have already pinned the rest of
 * the shape down. That established structure is what pays for the looser floor here: a bare 1-glyph
 * flank would be far too permissive on its own (a bullet-adjacent "─ text" is ordinary prose), but by
 * the time step (e) runs, the only open question is whether THIS line, sitting immediately above an
 * already-confirmed bottom-border→❯ pair (within the same cap), closes the box. `isBoxBorder` keeps
 * its 2-glyph floor at every OTHER call site (chrome.ts steps a/b/c/d, and menu.ts) — none of them has
 * that same backstop, so none of them gets the looser test. (Step (d)'s continuation walk in
 * particular stops as soon as it reaches the "❯" line, before it would ever reach the top border at
 * all, so it never needs this either.)
 *
 * One renderer shape is deliberately left unhandled: when the label is wide enough to overflow the
 * border width, the renderer's own overflow branch drops the LEFT flank to zero width entirely and
 * the "border" becomes bare label text with only a trailing rule run — there is no flank left on one
 * side to test, so it is lexically indistinguishable from ordinary prose ending in a rule-ish run. That
 * capture simply doesn't match here; `stripChrome` falls back to the raw mirror, which is safe (the
 * reply guard's pre-flight blocks a send into what still looks like an unrecognised screen, with a
 * `force` override the user can reach), just not a chrome strip.
 */
export function isInputBoxTopBorder(text: string): boolean {
  if (isBoxBorder(text)) return true;
  const trimmed = text.trim();
  // Same shared width floor as isBoxBorder, in display cells — see that comment and BARE_BORDER_MIN.
  if (displayWidth(trimmed) < BARE_BORDER_MIN) return false;
  const m = LOOSE_LABELLED_BORDER.exec(trimmed);
  if (m === null) return false;
  return !RULE_OR_SPACE_ONLY.test(m[1]!);
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
