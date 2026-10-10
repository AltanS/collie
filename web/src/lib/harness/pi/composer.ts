// Frame-anchored composer scanner for pi.
//
// Locates pi's composer editor at the buffer tail, strips the composer, slash palette, and footer
// off the mirror, and re-surfaces the stranded draft, statuslines, and prompt binding.
//
// pi TUI layout at the tail:
//
//   ────────────────────────────────────────  ← top border rule (isRuleRow)
//   <draft row(s)>                            ← user input (indented or plain, multiline supported)
//   ────────────────────────────────────────  ← bottom border rule (isRuleRow)
//   [→ <slash palette rows>]                  ← optional slash command palette (tolerated)
//   <footer row(s)>                           ← bounded footer: default 2 rows (cwd + stats)
//                                               or an extension's own footer (e.g. a 1-row powerbar)
//
// The frame is pi's own, so this module never borrows omp's grammar. Pure over StyledLine[];
// fail-closed.

import { isBlank, lineText, type StyledLine } from "../../blocks";
import { rstrip } from "./markers";

/** Maximum non-blank lines the bridge prompt-binding verifier accepts below expected_prompt. */
export const BRIDGE_PROMPT_TAIL_LINES = 6;

/** Maximum draft rows allowed inside a pi composer. */
export const MAX_DRAFT_ROWS = 100;

/** Maximum footer rows admitted at the tail. */
export const MAX_FOOTER_ROWS = 4;

/** Maximum slash palette rows tolerated below the composer bottom rule. */
export const MAX_PALETTE_ROWS = 32;

/** The composer frame located at the tail. All indices refer to the input StyledLine[] array. */
export interface PiComposer {
  /** Index of the top border rule. */
  top: number;
  /** Index of the first draft row (`top + 1`). */
  firstDraftRow: number;
  /** Index of the bottom border rule. */
  bottom: number;
  /** Exclusive end of draft rows (`bottom`). */
  draftEnd: number;
  /** First row of the statusline footer. */
  footerStart: number;
  /** Exclusive end of the statusline footer (before trailing blanks). */
  footerEnd: number;
  /** Whether a slash command palette was active between bottom rule and footer. */
  palette: boolean;
  /** Start index of the slash palette run, if present. */
  paletteStart?: number;
  /** Exclusive end of the slash palette run, if present. */
  paletteEnd?: number;
}

/**
 * True when the line is a horizontal border rule drawn by pi:
 * a run of at least 8 `─` (U+2500) characters, or a scrolled border with scroll indicator.
 */
export function isRuleRow(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 8) return false;
  if (/^─+$/.test(trimmed)) return true;
  // A scrolled editor writes its overflow into the border: `───── ↑ 2 more ─────`.
  return /^─+\s+[↑↓]\s+\d+\s+more\s+─+$/.test(trimmed);
}

/**
 * True when the line opens, closes, or frames a TUI box at its outer border.
 * A composer footer or slash palette must never be a box row.
 */
export function isBoxRow(text: string): boolean {
  const trimmed = text.trim();
  return /^[┌┐└┘╭╮╰╯├┤┬┴┼│]/.test(trimmed);
}

/** True when the line opens with a menu or palette pointer (`→ ` or `❯ `). */
export function isMenuPointerRow(text: string): boolean {
  return /^(?:→|❯)\s/.test(text.trim());
}

/** Patterns that identify pi question dialogs or pi core modals. */
const DIALOG_OR_MODAL_PATTERNS = [
  /(?:Esc(?:ape)?(?:\/Ctrl\+C)? to (?:cancel|go back)|Esc(?:ape)? cancel|Ctrl\+S to set)/i,
  /(?:↑↓ navigate|←→ tabs|Enter to select|Enter select|Enter to confirm|Space to tick)/,
  /^(?:> |\s+)(?:\[[ x]\]|\d+\.\s+)/,
  /←\s+.*(?:▣|▢|Review).*\s+→/,
  /Your answer \(/,
  /Review your answers/,
];

/** True when the line carries distinctive dialog or modal chrome. */
export function isDialogOrModalRow(text: string): boolean {
  return DIALOG_OR_MODAL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Locate pi's composer frame at the tail of `lines`.
 *
 * Scans bottom-up:
 * 1. Drops trailing blank lines.
 * 2. Identifies a bounded footer (1..4 non-blank rows; no rules, no box rows, no dialog hints).
 * 3. Finds the bottom rule (directly above the footer, or above a slash palette).
 * 4. Walks up to find the matching top rule enclosing draft rows (no rules, no dialog content).
 *
 * Returns null if the frame does not fully match or if a modal/dialog owns the tail.
 */
export function locate(lines: StyledLine[]): PiComposer | null {
  if (!lines || lines.length === 0) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = texts.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return null;

  for (let footerRows = 1; footerRows <= MAX_FOOTER_ROWS; footerRows++) {
    const footerStart = end - footerRows;
    if (footerStart < 2) break; // larger footers only lower footerStart further

    const footerSlice = texts.slice(footerStart, end);
    if (footerSlice.some((r) => isBlank(r) || isRuleRow(r) || isBoxRow(r) || isDialogOrModalRow(r) || isMenuPointerRow(r))) {
      continue;
    }

    // The bottom rule sits directly above the footer, or above an open slash palette.
    const candBottom = footerStart - 1;
    if (isRuleRow(texts[candBottom]!)) {
      const box = resolveComposerBox(texts, candBottom, false, -1, -1, footerStart, end);
      if (box !== null) return box;
    }

    for (let paletteRows = 1; paletteRows <= MAX_PALETTE_ROWS; paletteRows++) {
      const paletteStart = footerStart - paletteRows;
      const paletteEnd = footerStart;
      const paletteBottom = paletteStart - 1;
      if (paletteBottom < 1) break;
      if (!isRuleRow(texts[paletteBottom]!)) continue;

      const paletteSlice = texts.slice(paletteStart, paletteEnd);
      if (paletteSlice.some((r) => isBlank(r) || isRuleRow(r) || isBoxRow(r) || isDialogOrModalRow(r))) {
        continue;
      }
      if (!/^(?:→ | {2,})\S/.test(paletteSlice[0]!)) continue;

      const box = resolveComposerBox(texts, paletteBottom, true, paletteStart, paletteEnd, footerStart, end);
      if (box !== null) return box;
    }
  }

  return null;
}

/** Given a confirmed bottom rule, locate the top rule and validate draft rows. */
function resolveComposerBox(
  texts: string[],
  bottom: number,
  palette: boolean,
  paletteStart: number,
  paletteEnd: number,
  footerStart: number,
  footerEnd: number,
): PiComposer | null {
  const bottomText = texts[bottom]!;

  for (let top = bottom - 1; top >= Math.max(0, bottom - MAX_DRAFT_ROWS); top--) {
    if (isRuleRow(texts[top]!)) {
      // A rule of another length is one pasted into the draft, not the enclosing top border.
      if (texts[top]!.length !== bottomText.length) continue;

      if (bottom - top < 2) return null;

      // A full-length rule inside the draft would be an inner frame.
      const draftRows = texts.slice(top + 1, bottom);
      if (draftRows.some((r) => (isRuleRow(r) && r.length === bottomText.length) || isBoxRow(r) || isDialogOrModalRow(r))) {
        return null;
      }

      // The palette only opens over a slash command.
      if (palette) {
        const draftText = draftRows.map((r) => r.trim()).join(" ");
        if (!draftText.startsWith("/")) return null;
      }

      return {
        top,
        firstDraftRow: top + 1,
        bottom,
        draftEnd: bottom,
        footerStart,
        footerEnd,
        palette,
        paletteStart: palette ? paletteStart : undefined,
        paletteEnd: palette ? paletteEnd : undefined,
      };
    }
  }

  return null;
}

/**
 * Re-surface the user draft stranded in pi's composer editor.
 * Multi-line drafts are space-joined. Returns null when empty, whitespace-only, or no composer.
 */
export function draft(lines: StyledLine[]): string | null {
  const box = locate(lines);
  if (box === null) return null;
  const texts = lines.map((l) => rstrip(lineText(l)));
  const parts: string[] = [];
  for (let i = box.firstDraftRow; i < box.bottom; i++) {
    const t = texts[i]!.trim();
    if (t.length > 0) parts.push(t);
  }
  const result = parts.join(" ");
  return result.length === 0 ? null : result;
}

/**
 * Re-surface pi's statusline rows from the footer under the composer.
 * Returns the verbatim styled lines, or [] when no composer is located.
 */
export function statusLines(lines: StyledLine[]): StyledLine[] {
  const box = locate(lines);
  if (box === null) return [];
  return lines.slice(box.footerStart, box.footerEnd);
}

/**
 * The literal on-screen rule row bound as `expected_prompt` for destructive pre-clear sweeps.
 *
 * Returns the bottom rule line text if it ends within `BRIDGE_PROMPT_TAIL_LINES` (6) non-blank
 * rows of the tail. Returns null if no composer is located or if a slash palette pushes the rule
 * out of the bridge's tail window.
 */
export function composerPrompt(lines: StyledLine[]): string | null {
  const box = locate(lines);
  if (box === null) return null;

  const texts = lines.map((l) => rstrip(lineText(l)));
  let nonBlankBelow = 0;
  for (let i = box.bottom + 1; i < lines.length; i++) {
    if (!isBlank(texts[i]!)) nonBlankBelow++;
  }
  if (nonBlankBelow > BRIDGE_PROMPT_TAIL_LINES - 1) return null;

  const row = rstrip(lineText(lines[box.bottom]!));
  return row.length === 0 ? null : row;
}

/**
 * Return `lines` with the composer editor, slash palette, footer, and exposed blank lines removed.
 * Returns the original array reference unchanged when no composer is found.
 */
export function stripChrome(lines: StyledLine[]): StyledLine[] {
  const texts = lines.map((l) => rstrip(lineText(l)));
  let end = lines.length;
  while (end > 0 && isBlank(texts[end - 1]!)) end--;
  if (end === 0) return lines.length === 0 ? lines : lines.slice(0, 0);

  const box = locate(lines);
  if (box === null) {
    return end === lines.length ? lines : lines.slice(0, end);
  }

  let above = box.top;
  while (above > 0 && isBlank(texts[above - 1]!)) above--;
  return lines.slice(0, above);
}

export {
  locate as locateComposer,
  draft as extractInputDraft,
  statusLines as extractStatusLines,
};
