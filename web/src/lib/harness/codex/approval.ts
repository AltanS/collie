// Codex's exec-approval dialog — "Would you like to run the following command?" over pointer-
// numbered options with letter shortcuts, `Press enter to confirm or esc to cancel` as the tail
// row. The card is CLASSIFIED, not layout-pinned (APPROVAL_NOTES.md): the first row must be the
// one-shot Yes (`Yes, proceed (y)`), the last row the reject (`No, and tell Codex what to do
// differently (esc)`), and every row between must PROVE it is a persistent mode change by its
// label (`don't ask again …`) — those are never buttons. A row that fits no class refuses the
// whole card. Digits confirm directly: `1` ran the approved command and `3` rejected it with
// the command never running (both live-probed 2026-08-22, with the reject negative-controlled).
// Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel } from "../prompt-model";
import { isBlank, lastNonBlankIndex, lineText, regionSignature, rstrip, skipBlanksUp } from "./markers";

export interface ApprovalRegion {
  model: PromptModel;
  startLine: number;
}

const FOOTER = /^\s*Press enter to confirm or esc to cancel$/;
const HEADER = /^\s*Would you like to run the following command\?$/;
const OPTION = /^(?:› |\s{2})([1-9])\. (.+)$/;
// EXACT labels (after the shortcut parenthetical is stripped), not prefixes: a suffix-extended
// row ("Yes, proceed and remember forever") could carry persistent semantics behind a
// one-shot-looking button (review repro). Only the captured wording earns a keystroke.
const YES_ROW = /^Yes, proceed$/;
const NO_ROW = /^No, and tell Codex what to do differently$/;
const PERSISTENT = /don['’]t ask again/i;

/** The button face: the row label minus its trailing keyboard-shortcut parenthetical. */
function buttonLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Exec-approval card at the tail, or null. */
export function detectApprovalRegion(lines: StyledLine[]): ApprovalRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0 || !FOOTER.test(texts[fi]!)) return null;

  // One blank row separates the footer from the option run (every capture); the options
  // themselves are contiguous. Visual order, not a Map: duplicates and shuffles must fail the
  // digit sequence.
  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 0) return null;
  const ordered: { digit: string; label: string }[] = [];
  let i = bottom;
  for (; i >= 0; i--) {
    const opt = OPTION.exec(texts[i]!);
    if (opt === null) break;
    ordered.unshift({ digit: opt[1]!, label: opt[2]!.trim() });
  }
  const n = ordered.length;
  if (n < 3) return null;
  for (let k = 0; k < n; k++) {
    if (ordered[k]!.digit !== String(k + 1)) return null;
  }

  const yes = ordered[0]!;
  const no = ordered[n - 1]!;
  if (!YES_ROW.test(buttonLabel(yes.label)) || !NO_ROW.test(buttonLabel(no.label))) return null;
  for (let k = 1; k < n - 1; k++) {
    if (!PERSISTENT.test(ordered[k]!.label)) return null;
  }

  // Between the options and the header sit the `$ command`, Reason and Environment rows —
  // blank-separated content the mirror keeps. The header itself must be on screen within a
  // short reach.
  let headerRow = -1;
  for (let k = i; k >= 0 && i - k < 12; k--) {
    if (HEADER.test(texts[k]!)) {
      headerRow = k;
      break;
    }
    if (!isBlank(texts[k]!) && OPTION.test(texts[k]!)) return null;
  }
  if (headerRow < 0) return null;

  const signature = regionSignature(lines, headerRow, fi + 1);
  if (signature === "") return null;

  return {
    // Persistent rows sit between Yes and the reject. Replacing from the first option
    // swallowed them (they are never buttons). The block starts at the reject so they
    // stay in the raw mirror with the header, Reason, and `$ command`.
    startLine: bottom,
    model: {
      question: "Would you like to run the following command?",
      options: [
        { label: buttonLabel(yes.label), keys: ["1"] },
        { label: buttonLabel(no.label), keys: [String(n)] },
      ],
      family: "permission",
      coreSignature: texts[headerRow]!.trim(),
      signature,
    },
  };
}
