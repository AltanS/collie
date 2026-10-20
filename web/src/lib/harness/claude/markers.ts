// Shared lexing helpers over the parsed `StyledLine[]` — the primitives every Claude-Code grammar
// (chrome stripping, prompt-select extraction, and — in T3 — history segmentation) leans on. They
// operate on the *parsed* line text (segment text joined), never the raw ANSI bytes: SGR codes sit
// *between* glyphs, so a regex over the raw buffer would miss (e.g. the `❯` pointer and the `1.` are
// separate styled segments). Pure functions, no I/O, no React.

import { hasQuestionMark, isBlank, lineText } from "../../blocks";
import { CLAUDE_RULE_GLYPH_CLASS } from "../../rule-glyphs";
import { displayWidth } from "../../text-width";
import { readKeyHintFooter } from "../menu-hints";
import type { PromptFamily } from "../prompt-model";
import { frameAt, frameEdge, plainRows, type IdleProfile } from "../../surface/frame";
import { requireProfile } from "../../surface/profile";

/** The Claude profile's input-frame anchors (lib/surface/profiles/claude.json, M56 spec 03). The frame
 *  module finds the box from them; the box locator (chrome.ts) and insideInputFrame both read them. */
export const CLAUDE_IDLE: IdleProfile = requireProfile("claude").idle;

// `lineText` / `isBlank` are properties of a StyledLine, not of any grammar, so they live in the
// neutral core (lib/blocks.ts) where the renderer can reach them without importing a harness. They
// are re-exported here so the Claude grammars keep their single import site.
export { hasQuestionMark, isBlank, lineText };

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

// What a wrapped rule leaves on the row under it when it overflowed by one or two columns: one or two
// U+2500 glyphs, alone. A stub of three or more glyphs is a horizontal rule on its own (`ruleTop`).
const RULE_STUB = /^─{1,2}$/;

/**
 * True when row `i` of `texts` is a horizontal rule, or the stub a wrapped rule leaves under itself.
 * This is hardening against a user theme, not vanilla Claude Code behaviour: a plugin or theme that
 * draws a gutter beside a dialog narrows the dialog, while Claude Code still draws the dialog's rule
 * at the full pane width, so the rule overflows by the gutter's width and its last glyphs land alone
 * on the next row. The observed case is a theme plugin's question bar, a two-column gutter (a
 * background-coloured cell, then a blank one), which leaves a `──` stub. The rows are never
 * rewritten, only read as one rule, so the bridge's binding match (`matchInTail` in
 * bridge/prompt-binding.ts, over contiguous normalised rows) still finds the phone's region.
 */
export function isRuleRow(texts: readonly string[], i: number): boolean {
  const text = texts[i];
  if (text === undefined) return false;
  if (isHorizontalRule(text)) return true;
  return i > 0 && RULE_STUB.test(text.trim()) && isHorizontalRule(texts[i - 1]!);
}

/**
 * The first row of the rule that row `i` (an `isRuleRow` row) belongs to. A rule that wrapped beside a
 * theme's gutter is its full row plus a stub under it, and a gutter three or more columns wide leaves
 * a stub that reads as a horizontal rule itself, so the rule's first row is the top of the run of rule
 * rows that ends at `i`. The walk never goes above row `floor`.
 */
export function ruleTop(texts: readonly string[], i: number, floor: number): number {
  let top = i;
  while (top - 1 >= floor && isHorizontalRule(texts[top - 1]!)) top--;
  return top;
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
const RULE_OR_SPACE_ONLY = new RegExp(`^[${CLAUDE_RULE_GLYPH_CLASS}\\s]*$`);

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
 * it (plus the draft-walk cap, the profile's `idle.frame.maxDraftRows`, bounding how far apart the
 * pieces of that shape may sit), so a lone matching line elsewhere on screen does nothing on its own.
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

/**
 * True when the line is a BARE input-box border: U+2500 only, no label, at least BARE_BORDER_MIN
 * display cells. Claude splices a session label into the TOP border only, so this is the test for
 * the BOTTOM border — the anchor `locateInputBox` (chrome.ts) looks for first.
 */
export function isBareBoxBorder(text: string): boolean {
  const trimmed = text.trim();
  return displayWidth(trimmed) >= BARE_BORDER_MIN && BARE_BORDER.test(trimmed);
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
 * Since M56 spec 03 the frame's own top edge is the Claude profile's `idle.frame.top` anchor
 * (lib/surface/profiles/claude.json), which spells this same shape as data; the frame module checks it
 * LAST. This predicate stays for the box locator's marks under the box (chrome.ts isFrameMark), where
 * a top-border-shaped rule in the tail refuses or is stepped over. The reasoning below is why the
 * anchor may be this loose: the LAST anchor checked, after the bottom border, the
 * "❯" prompt line, and the draft-walk cap (`idle.frame.maxDraftRows`) have already pinned the rest of
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

// The prompt row ("❯", or "!" followed by whitespace in shell mode, so an ordinary "!important"
// line inside the frame is not a prompt) is the profile's `idle.frame.prompt` anchor since M56 spec 03.
// chrome.ts's marks under the box (isFrameMark) deliberately do NOT learn the bang: shell mode's bang
// only ever appears INSIDE the frame, and a "!"-led transcript row below the box stays ordinary text.

/**
 * Whether row `row` sits inside a Claude input box: the first frame edge under it (a column-0 border
 * or prompt row, `frameEdge`) is a bottom edge, and the frame module's walk up from that edge
 * (`frameAt`) closes on a top border ABOVE `row`. So the row is the box's "❯" prompt row or one of its
 * indented continuation rows: the operator's own draft. A dialog replaces the composer, so a dialog's
 * own words never sit in one, and the dialog evidence tests (namesPlanDialog) skip such rows: draft
 * text is never a dialog. A pure frame test, not the box locator (locateInputBox asks those tests
 * first, so it cannot be asked back); a box the locator would refuse for its tail still holds a
 * draft here.
 */
export function insideInputFrame(texts: string[], row: number): boolean {
  const rows = plainRows(texts);
  for (let i = row + 1; i < texts.length && i - row <= CLAUDE_IDLE.frame.maxDraftRows + 1; i++) {
    if (frameEdge(texts[i]!, CLAUDE_IDLE) === null) continue;
    const frame = frameAt(rows, i, CLAUDE_IDLE);
    return frame !== null && frame.top < row;
  }
  return false;
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

// The folder-trust dialog's own words, read off `fixtures/panes/claude--trust-prompt.txt`: the
// safety question it asks, and the option row it offers. Either one identifies THAT dialog; the
// footer phrase "Enter to confirm" identifies nothing, because any screen may print it.
const TRUST_QUESTION = /is this a project you created or one you trust/i;
const TRUST_OPTION = /yes,\s*i trust this folder/i;

/**
 * True when the folder-trust dialog's own title or option row is somewhere on screen. This is the
 * evidence `classifyFooter` requires before it may claim the `trust` family — a family claim is a
 * statement about a whole dialog, so it must be answerable from that dialog.
 */
export function namesTrustDialog(texts: string[]): boolean {
  return texts.some((t) => TRUST_QUESTION.test(t) || TRUST_OPTION.test(t));
}

// A tool-permission dialog's own words, read off Claude Code 2.1.283 (`claude--v2283-permission-*`):
// a "Do you want to …?" question over a numbered menu that opens on "Yes" and closes on "No". The
// footer is NOT that evidence. "Tab to amend" is there only while the pointer sits on the Yes or the
// No row, so an arrow press drops the footer to a bare "Esc to cancel", and the WebFetch dialog
// prints no footer at all. Both used to fall to the unread-dialog card.
const PERMISSION_QUESTION_START = /^\s*Do you want to\b/;
const PERMISSION_FIRST_ROW = /^\s*(?:❯\s*)?1\.\s+Yes\b/;
const PERMISSION_LAST_ROW = /^\s*(?:❯\s*)?[2-9]\.\s+No\b/;
// The question, the menu and a wrapped row or two all sit in the last rows of the screen.
const PERMISSION_SCAN_ROWS = 18;
// A question wrapped at a narrow width reaches its "?" within a couple of rows.
const PERMISSION_QUESTION_ROWS = 3;

/**
 * True when the screen's last rows are a permission dialog by its own words: a question that opens
 * "Do you want to" and ends in "?" (it may wrap), then a `1. Yes…` row, then a `N. No…` row. The
 * evidence `classifyFooter` and the footerless prompt-select path need before either may claim the
 * `permission` family without the "Tab to amend" hint (ADR 0053: a family claim is answered from the
 * dialog, never from one phrase any screen may print).
 */
export function namesPermissionDialog(texts: string[]): boolean {
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  const from = Math.max(0, end - PERMISSION_SCAN_ROWS);
  let question = -1;
  for (let i = from; i <= end; i++) {
    if (!PERMISSION_QUESTION_START.test(texts[i]!)) continue;
    for (let j = i; j <= Math.min(end, i + PERMISSION_QUESTION_ROWS - 1); j++) {
      if (isBlank(texts[j]!)) break;
      if (texts[j]!.trimEnd().endsWith("?")) question = j;
    }
  }
  if (question < 0) return false;
  let yes = -1;
  for (let i = question + 1; i <= end; i++) {
    if (yes < 0 && PERMISSION_FIRST_ROW.test(texts[i]!)) yes = i;
    else if (yes >= 0 && PERMISSION_LAST_ROW.test(texts[i]!)) return true;
  }
  return false;
}

// The plan-approval dialog's own words, read off `claude--plan-approval*.txt` and
// `claude-lab--plan-approval*.txt` (Claude Code 2.1.27x to 2.1.291):
// "Claude has written up a plan and is ready to execute. Would you like to proceed?", which wraps
// onto three rows at 40 columns, then a numbered menu that opens on `1.` and goes on to `2.`. The
// footer is NOT that evidence: 2.1.291 prints "ctrl+g to edit in nano" on the statusline row under
// any multi-line draft (`claude-lab--draft-adversarial--w*.txt`).
const PLAN_QUESTION = /\bready\s+to\s+execute\.\s+would\s+you\s+like\s+to\s+proceed\?$/i;
const PLAN_FIRST_ROW = /^\s*(?:❯\s*)?1\.\s+\S/;
const PLAN_SECOND_ROW = /^\s*(?:❯\s*)?2\.\s+\S/;
// The question, a menu of up to five options, a feedback value wrapped onto a few rows, the hint and
// the footer with its wrapped path all sit in the last rows of the screen.
const PLAN_SCAN_ROWS = 30;
// The question reaches its "?" within three rows at 40 columns.
const PLAN_QUESTION_ROWS = 4;

/**
 * True when the screen's last rows are the plan-approval dialog by its own words: the question
 * ending "ready to execute. Would you like to proceed?" (it may wrap), then a `1.` row, then a `2.`
 * row. The evidence `classifyFooter` needs before it may claim the `plan` family from the "ctrl+g to
 * edit" hint or the plan file's path (ADR 0053: a family claim is answered from the dialog, never
 * from one phrase any screen may print).
 *
 * Rows inside the input box are never that evidence (insideInputFrame). Claude Code 2.1.291 prints
 * the "ctrl+g to edit in nano" hint under any multi-line draft, so a draft that quotes the question
 * and two numbered rows used to name the dialog: the box was refused and a send stalled, the unread
 * card covered a live composer, or a `❯`-pointed copy was lifted as two plan buttons that type digits
 * into the draft. The real dialog replaces the composer, so its words never sit in a box.
 */
export function namesPlanDialog(texts: string[]): boolean {
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  const from = Math.max(0, end - PLAN_SCAN_ROWS);
  for (let i = from; i <= end; i++) {
    let joined = "";
    for (let j = i; j <= Math.min(end, i + PLAN_QUESTION_ROWS - 1); j++) {
      if (isBlank(texts[j]!)) break;
      joined = joined === "" ? texts[j]!.trim() : `${joined} ${texts[j]!.trim()}`;
      if (!PLAN_QUESTION.test(joined)) continue;
      // The row that ends the question: in the box, the whole question is the draft's.
      if (insideInputFrame(texts, j)) break;
      return hasPlanMenu(texts, j + 1, end);
    }
  }
  return false;
}

/** A `1.` row and then a `2.` row between `from` and `end`, inclusive, neither inside the input box. */
function hasPlanMenu(texts: string[], from: number, end: number): boolean {
  let first = -1;
  for (let i = from; i <= end; i++) {
    if (first < 0 && PLAN_FIRST_ROW.test(texts[i]!) && !insideInputFrame(texts, i)) first = i;
    else if (first >= 0 && PLAN_SECOND_ROW.test(texts[i]!) && !insideInputFrame(texts, i)) return true;
  }
  return false;
}

// The plan footer's "ctrl+g to edit in <editor> ·" row, when the plan file's path did not fit beside
// it and moved to the rows below.
const PLAN_FOOTER_LEAD = /ctrl\+g to edit\b.*·\s*$/i;
// The whole path, once its rows are joined back: `<config dir>/plans/<slug>.md`.
const PLAN_FILE_PATH = /^\S*\/plans\/[\w.-]+\.md$/;
// A long path under a custom CLAUDE_CONFIG_DIR breaks onto a second row at 40 columns.
const PLAN_PATH_ROWS = 3;

/**
 * The rows the plan file's path fills under the footer's "ctrl+g to edit … ·" row, when the path
 * sits there on its own: one row at 82 columns, two at 40, where it breaks mid-word with no space.
 * Empty when the screen does not end that way. The rows must join, with nothing between them, into
 * a `…/plans/<slug>.md` path, so a stray `.md` row or a path to some other file claims nothing.
 */
function planPathRows(texts: string[]): number[] {
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  const rows: number[] = [];
  for (let i = end; i >= 0 && rows.length < PLAN_PATH_ROWS; i--) {
    const t = texts[i]!.trim();
    if (t === "" || /\s/.test(t)) break;
    rows.unshift(i);
  }
  const first = rows[0];
  if (first === undefined || first === 0) return [];
  if (!PLAN_FOOTER_LEAD.test(texts[first - 1]!)) return [];
  return PLAN_FILE_PATH.test(rows.map((i) => texts[i]!.trim()).join("")) ? rows : [];
}

/**
 * The row of the plan footer's "ctrl+g to edit … ·" lead when the plan file's path sits below it on
 * rows of its own, else -1. The prompt-select grammar measures the gap to the options from this row,
 * because the path rows under it are the same footer, wrapped.
 */
export function planFooterLeadRow(texts: string[]): number {
  const rows = planPathRows(texts);
  return rows.length === 0 ? -1 : rows[0]! - 1;
}

// The gutter Claude Code paints down the left of a question: on the question step of a question that
// spans more than one row (2.1.283: "│ Which fruit do you want?" / "│ Pick the one you like best."),
// and on the wizard's review step beside an echoed question (2.1.302: "│ ● …" / "│   …"). It is
// chrome, not question text.
const QUESTION_GUTTER = /^\s*│\s?/;

/** A question row with its `│` gutter and outer whitespace removed. */
export function questionRowText(text: string): string {
  return text.replace(QUESTION_GUTTER, "").trim();
}

const RULE_RUN = new RegExp(`[${CLAUDE_RULE_GLYPH_CLASS}]{3,}`);

/**
 * The AskUserQuestion `select` footer when a narrow pane wrapped it onto more than one row, as the
 * rows it fills at the tail of `texts`: `Enter to select · ↑/↓ to navigate · Esc` over `to cancel`
 * at 40 columns on Claude Code 2.1.296. Null for a footer on one row (`classifyFooter` reads that
 * one by itself), and for anything `readKeyHintFooter` does not accept as ONE key-hint block: rows at
 * one indent, every `·` segment a hint, no blank row inside. FAIL CLOSED on top of that: the joined
 * text must carry the `Enter to select` phrase, so a wrapped `Esc to cancel` or a wrapped `/effort`
 * footer never claims the family.
 */
export function wrappedSelectFooter(texts: string[]): { startLine: number; lastRow: string } | null {
  const footer = readKeyHintFooter(texts);
  if (footer === null || footer.startLine === footer.endLine) return null;
  if (!/\benter to select\b/i.test(footer.text)) return null;
  // `readKeyHintFooter` takes "Esc to cancel ──── capture lab ─" for a hint, so a rule folded into the
  // group would pass as footer text. No footer row holds a run of rule glyphs.
  for (let i = footer.startLine; i <= footer.endLine; i++) if (RULE_RUN.test(texts[i]!)) return null;
  return { startLine: footer.startLine, lastRow: texts[footer.endLine]! };
}

/**
 * The row a `select` footer starts on when its last non-blank row is `fi`: `fi` itself for a footer
 * on one row, the first row of the group for a wrapped one. The grammars measure the option rows
 * against this row, not against `fi`, so the footer's own rows are never read as a description or
 * counted into the gap above them. Their signatures still end at `fi`, so the phone and the bridge
 * bind the same rows.
 */
export function selectFooterStart(texts: string[], fi: number): number {
  if (/\benter to select\b/i.test(texts[fi]!)) return fi;
  return wrappedSelectFooter(texts)?.startLine ?? fi;
}

/**
 * Classify a candidate footer line — the hint bar at the very bottom of a Claude dialog — into a
 * dialog family, or null when it isn't a recognised menu footer. The footer is the single most
 * stable discriminator for three of the four families: Claude Code generates it (unlike the
 * user-configured statusline), and the confirm phrase pins the keystroke recipe:
 *
 *   - "Enter to select …"  → select     (AskUserQuestion: the digit THEN Enter)
 *   - "… Tab to amend …"   → permission (edit/bash "Do you want to proceed?": the digit alone)
 *   - a bare "Esc to cancel" → permission, but only when `namesPermissionDialog` finds the dialog's
 *     own question and Yes/No rows (the hint bar a permission dialog shows off its Yes/No rows)
 *   - "ctrl+g to edit …" or the plan file's path → plan (ExitPlanMode: the digit alone), but only
 *     when `namesPlanDialog` finds the dialog's own question and numbered menu
 *
 * The fourth, `trust` (folder-trust prompt: the digit alone), needs MORE than its footer. Its phrase
 * "Enter to confirm" is ordinary Claude wording that other screens print — the /effort slider prints
 * it — and `menu.ts` reads any family claim as "a specific grammar owns this screen", so a wrong
 * `trust` takes every button off a screen nobody owns (ADR 0053). So the trust arm fires only when
 * `namesTrustDialog(texts)` finds that dialog's own words. Without them the phrase classifies as
 * nothing at all.
 *
 * `texts` is the pane's line texts, and it is REQUIRED: a caller that cannot see the screen cannot
 * be told the trust family, and making it required turns that into a compile error rather than a
 * family that quietly stops being reported.
 *
 * Case-insensitive and anchored only on the confirm phrase, so per-install extra hints
 * (ctrl+e to explain, ↑/↓ to navigate, …) don't disturb the classification.
 */
export function classifyFooter(text: string, texts: string[]): PromptFamily | null {
  const t = text.toLowerCase();
  if (/\benter to select\b/.test(t)) return "select";
  // The same footer broken over two or three rows by a narrow pane (Claude Code 2.1.296 at 40
  // columns: `Enter to select · ↑/↓ to navigate · Esc` over `to cancel`). The caller hands over the
  // LAST row, which then names nothing on its own.
  if (wrappedSelectFooter(texts)?.lastRow === text) return "select";
  if (/\benter to confirm\b/.test(t)) {
    return namesTrustDialog(texts) ? "trust" : null;
  }
  // The plan arms need the plan dialog's own words. Claude Code 2.1.291 prints "ctrl+g to edit in
  // nano" on the statusline row under any multi-line draft, and reading that as `plan` took the
  // input box away from every send (ADR 0053).
  const planFooter = /ctrl\+g to edit\b/.test(t) || /\.claude\/plans\//.test(t);
  // The plan file lives under CLAUDE_CONFIG_DIR, which need not be `.claude`, and a long path moves
  // below the footer's own "ctrl+g to edit …·" row, alone on one row or broken across two.
  const planPath = !planFooter && planPathRows(texts).some((i) => texts[i] === text);
  if ((planFooter || planPath) && namesPlanDialog(texts)) return "plan";
  if (/\btab to amend\b/.test(t)) return "permission";
  // The same dialog with its pointer off the Yes and No rows, or with an amend note open: the hint
  // bar shrinks to "Esc to cancel". The phrase alone proves nothing, so the dialog's words must.
  if (/^esc to cancel$/.test(t.trim()) && namesPermissionDialog(texts)) return "permission";
  return null;
}
