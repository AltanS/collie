// Codex's folder-trust prompt — the first screen in an untrusted directory. The captured layout
// (TRUST_NOTES.md) is exactly two options with fixed labels under a "Do you trust the contents
// of this directory?" paragraph, with `Press enter to continue` as the tail row. Digits confirm
// directly: `2` quit Codex on the spot (live-probed 2026-08-22), and Enter confirms the
// highlighted row. Anything off the captured layout refuses (fail-closed null). Pure; no pane
// access.

import type { StyledLine } from "../../blocks";
import type { PromptModel } from "../prompt-model";
import { lastNonBlankIndex, lineText, regionSignature, rstrip, skipBlanksUp } from "./markers";

export interface TrustRegion {
  model: PromptModel;
  startLine: number;
}

const FOOTER = /^\s*Press enter to continue$/;
// Selected rows lead with `› `, unselected with two spaces; both carry `N. label`.
const OPTION = /^(?:› |\s{2})([12])\. (.+)$/;
const YES_LABEL = /^Yes, continue$/;
const NO_LABEL = /^No, quit$/;
const QUESTION = /Do you trust the contents of this directory\?/;

/** Trust prompt at the tail, or null. */
export function detectTrustRegion(lines: StyledLine[]): TrustRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 2 || !FOOTER.test(texts[fi]!)) return null;

  // One blank row separates the footer from the option pair; the options are contiguous.
  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 1) return null;
  const two = OPTION.exec(texts[bottom]!);
  const one = OPTION.exec(texts[bottom - 1]!);
  if (one === null || two === null) return null;
  if (one[1] !== "1" || two[1] !== "2") return null;
  if (!YES_LABEL.test(one[2]!.trim()) || !NO_LABEL.test(two[2]!.trim())) return null;

  // The question paragraph sits in the rows above the options (across one blank row); require
  // it on screen so an out-of-context pair of rows can't claim the recipe.
  let questionRow = -1;
  for (let i = bottom - 2; i >= 0 && bottom - 2 - i < 6; i--) {
    if (QUESTION.test(texts[i]!)) {
      questionRow = i;
      break;
    }
  }
  if (questionRow < 0) return null;

  const start = bottom - 1;
  // The signature runs from the question paragraph through the footer — the subject above the
  // options participates, so the race guard sees a screen whose context changed under the user.
  const signature = regionSignature(lines, questionRow, fi + 1);
  if (signature === "") return null;

  return {
    startLine: start,
    model: {
      question: "Do you trust the contents of this directory?",
      options: [
        { label: "Yes, continue", keys: ["1"] },
        { label: "No, quit", keys: ["2"] },
      ],
      family: "trust",
      coreSignature: "Do you trust the contents of this directory?",
      signature,
    },
  };
}
