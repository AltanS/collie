// Chrome stripping for Muse. Trims Muse's own TUI composer off the TAIL of a parsed buffer so
// Collie's composer/statusline supersede it, and re-surfaces the two things the strip would
// otherwise destroy (the statusline and a stranded draft).
//
// Muse vs the other harnesses (do not reuse their scanners):
//
//   Claude                         omp                              Muse
//   ──────────────────────────     ────────────────────────────     ──────────────────────────────
//   ┌ top rule                     ╭── <statusline> ──╮             ── Voice input … ──  (titled rule)
//   │ ❯ <draft>                    │  <earlier draft> │             ❯ <draft…>
//   └ bottom rule                  ╰─ <draft tail> ───╯               <continuations…>
//     <statusline below>           ❯ palette below                  ─────────────────  (bare rule)
//                                                                     <statusline below>
//
// No box: the composer is a bare `❯` run between two rules. The `❯` echoes of submitted prompts
// share the shape, so position (heading the run directly above the bottom rule) is what makes one
// the box — and a question dialog directly above it with the bare `❯` still below is the reason the
// READY gate consults the dialog detectors rather than trusting the geometry alone.
//
// Conservative: the whole shape has to match at the tail or the buffer is returned untouched (same
// reference). Pure; no pane access, no network.

import { isBlank, lineText, type StyledLine } from "../../blocks";
import { detectApprovalRegion } from "./approval";
import { detectCheckboxRegion } from "./checkbox";
import { detectQuestionRegion } from "./question";
import { detectTrustRegion } from "./trust";
import {
  INPUT_PLACEHOLDERS,
  isContinuationRow,
  isNoteRow,
  locateTail,
  promptRowText,
  rstrip,
} from "./markers";

// How far above the composer to scan for an open note row. The dialog sits directly above the box
// (~15 rows); 40 has margin for wider layouts. A `Note (optional):` row anywhere in that window is a
// LIVE notes input — answered dialogs replace the whole region (`Structured user input answered`),
// so scrollback never holds one.
const NOTE_SCAN_ROWS = 40;

/** True when a dialog's inline note input is open above the composer (it owns the keyboard). */
function hasOpenNote(lines: StyledLine[]): boolean {
  const tail = locateTail(lines);
  if (tail === null) return false;
  const top = tail.prompt ?? tail.rule;
  const texts = lines.map((l) => rstrip(lineText(l)));
  for (let i = top - 1; i >= 0 && top - 1 - i < NOTE_SCAN_ROWS; i--) {
    if (isNoteRow(texts[i]!)) return true;
  }
  return false;
}

/**
 * Return `lines` with any confidently-matched trailing chrome removed. When nothing matches the
 * input is returned as-is (same reference), so callers can treat an unchanged result as "no chrome".
 *
 * The strip covers the Voice rule (when present), the prompt run, the bottom rule and the
 * statusline. On a dialog screen buildBlocks returns before ever calling this, so an unknown modal
 * above a prompt-less tail (rule + status only) keeps its rows while still losing the chrome.
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = lines.length;

  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.length === 0 ? lines : lines.slice(0, 0);

  const tail = locateTail(lines);
  if (tail !== null) {
    end = tail.prompt ?? tail.rule;
    if (tail.voice !== null && tail.voice === end - 1) end = tail.voice;
    while (end > 0 && isBlank(texts[end - 1]!)) end--;
  }

  return end === lines.length ? lines : lines.slice(0, end);
}

/**
 * Muse's statusline — model, plan, cwd, permission mode — painted as the last non-blank row. opaque:
 * no field is ever parsed, so a renamed model or mode cannot break the strip. stripChrome peels it
 * off the mirror, so this re-surfaces it as app chrome, styling intact per the adapter contract.
 */
export function extractStatusLines(lines: StyledLine[]): StyledLine[] {
  const tail = locateTail(lines);
  if (tail === null) return [];
  return [lines[tail.status]!];
}

/**
 * The user's draft stranded in the composer: the `❯` row's text plus every row down to the bottom
 * rule, folded with the single space the reply guard's FOLD_SEAM expects (reply-action.ts). Empty
 * box, placeholder tip, open note, or any claimed dialog → null.
 *
 * Load-bearing: registering this adapter switches Muse panes from one-shot send to type-then-verify,
 * and THIS is the verify half. A wrong non-null answer stalls a send; a wrong answer that happens to
 * contain the sent text would fire the submit key — which is why dialogs and notes return null here
 * rather than whatever text the rows hold.
 */
export function extractInputDraft(lines: StyledLine[]): string | null {
  if (detectApprovalRegion(lines) !== null) return null;
  if (detectQuestionRegion(lines) !== null) return null;
  if (detectCheckboxRegion(lines) !== null) return null;
  if (detectTrustRegion(lines) !== null) return null;
  if (hasOpenNote(lines)) return null;
  const tail = locateTail(lines);
  if (tail === null || tail.prompt === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));

  const prompt = promptRowText(texts[tail.prompt]!);
  if (prompt === null) return null;
  const parts = [prompt.trim()];
  for (let i = tail.prompt + 1; i < tail.rule; i++) {
    const row = texts[i]!;
    // Continuations carry the 2-space composer indent; anything else between prompt and rule is a
    // torn frame, kept verbatim so the verify fails safe rather than on a mangled guess.
    parts.push(isContinuationRow(row) ? row.slice(2).trim() : row.trim());
  }

  const draft = parts.filter((p) => p.length > 0).join(" ");
  if (draft.length === 0 || INPUT_PLACEHOLDERS.has(draft)) return null;
  return draft;
}

/** Whether Muse's free-text composer is on screen at the tail (the weaker, purely geometric claim). */
export function hasComposer(lines: StyledLine[]): boolean {
  const tail = locateTail(lines);
  return tail !== null && tail.prompt !== null;
}

/**
 * Whether a phone reply would reach Muse's composer rather than a dialog sitting on top of it.
 *
 * hasComposer is the weaker claim (the box is at the tail). This is the reply-path pre-flight: a
 * definite `true` authorises the destructive pre-clear sweep, so every screen where the box is
 * visible but does not own the keyboard has to fail closed. Question and review dialogs leave the
 * bare `❯` under them (claimed by their detectors); an open note row owns the keyboard with no lift
 * at all (declined to raw, but never typeable); approval replaces the box and trust is pre-session,
 * so both fail on the geometry alone — and are still consulted, so a future chrome change cannot
 * silently re-open them.
 *
 * Known limitation, documented rather than guessed at: the command palette, `/resume` picker,
 * `/tasks` drawer and `/workflows` room are unmeasured (outside DIALOG_NOTES.md's scope). If one of them leaves a live
 * `❯` below it, this answers true and the pre-flight types into it — and type-then-verify still
 * withholds the submit key, because the typed text never lands in the box it reads. A stall, not a
 * misfire: the backstop holds where the pre-flight cannot see.
 */
export function composerReady(lines: StyledLine[]): boolean {
  if (detectApprovalRegion(lines) !== null) return false;
  if (detectQuestionRegion(lines) !== null) return false;
  if (detectCheckboxRegion(lines) !== null) return false;
  if (detectTrustRegion(lines) !== null) return false;
  if (hasOpenNote(lines)) return false;
  return hasComposer(lines);
}

// Mirror of the bridge's tail window (bridge/prompt-binding.ts DEFAULT_PROMPT_TAIL_LINES): the
// binding only verifies when its match ends within this many non-blank rows of the fresh read.
const BRIDGE_PROMPT_TAIL_LINES = 6;

/**
 * The composer's prompt row, verbatim (trailing pad dropped), bound as `expected_prompt` for the
 * pre-clear sweep. Null when there is no composer, when a dialog owns the keyboard (same screens
 * composerReady refuses — a binding there would arm a destructive write at a modal), or when a long
 * wrapped draft pushes the prompt row out of the bridge's tail window (an unbindable region would
 * 409 every sweep, so the adapter takes the unbound write instead, per the conformance contract).
 */
export function composerPrompt(lines: StyledLine[]): string | null {
  if (!composerReady(lines)) return null;
  const tail = locateTail(lines);
  if (tail === null || tail.prompt === null) return null;

  const texts = lines.map((l) => rstrip(lineText(l)));
  let nonBlankBelow = 0;
  for (let row = tail.prompt + 1; row <= tail.status; row++) {
    if (!isBlank(texts[row]!)) nonBlankBelow++;
  }
  if (nonBlankBelow > BRIDGE_PROMPT_TAIL_LINES - 1) return null;

  const row = rstrip(lineText(lines[tail.prompt]!));
  return row.length === 0 ? null : row;
}
