// Grok Build's folder-trust prompt, the first screen in an untrusted directory (1.0.52, live
// 2026-10-15). It paints under the logo in place of the composer:
//
//              Do you trust the contents of this directory?
//   <the directory>
//         Grok Build may run or modify contents in this directory,
//                        posing security risks.
//
//                  Yes, proceed                 y
//                  No, quit                     n
//   …blank rows…                                        Grok Build  1.0.52 [stable]
//
// Each option prints its own key at its right, and the key alone answers: `y` went on to the
// composer and wrote the folder into `trusted_folders.toml` under GROK_HOME, `n` quit Grok to the
// shell (both measured). No Enter follows, which is the trust family's key-alone recipe. Anything off
// this layout refuses (fail-closed null). Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel } from "../prompt-model";
import { lastNonBlankIndex, lineText, regionSignature, rstrip } from "./markers";

export interface TrustRegion {
  model: PromptModel;
  startLine: number;
}

const QUESTION_TEXT = "Do you trust the contents of this directory?";
const QUESTION = /^\s*Do you trust the contents of this directory\?$/;
const YES = /^\s*Yes, proceed\s{2,}y$/;
const NO = /^\s*No, quit\s{2,}n$/;
// Rows between the question and the options: the directory (a long one wraps), the two-row warning
// and the blanks around it.
const QUESTION_SCAN_ROWS = 8;
// Non-blank rows under the options: the version chip at the bottom right.
const STATUS_ROWS = 1;

/** The trust prompt at the tail, or null. */
export function detectTrustRegion(lines: StyledLine[]): TrustRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const last = lastNonBlankIndex(texts);
  let noRow = -1;
  let seen = 0;
  for (let i = last; i >= 0; i--) {
    if (texts[i]!.trim() === "") continue;
    if (NO.test(texts[i]!)) {
      noRow = i;
      break;
    }
    if (++seen > STATUS_ROWS) return null;
  }
  if (noRow < 1 || !YES.test(texts[noRow - 1]!)) return null;
  const yesRow = noRow - 1;

  let question = -1;
  for (let i = yesRow - 1; i >= 0 && yesRow - 1 - i < QUESTION_SCAN_ROWS; i--) {
    if (QUESTION.test(texts[i]!)) {
      question = i;
      break;
    }
  }
  if (question < 0) return null;

  // From the question through the tail: a different directory, or anything new under the options,
  // makes a tap read on the old screen stale.
  const signature = regionSignature(lines, question, last + 1);
  if (signature === "") return null;
  return {
    // The card prints the question alone, so it starts at the first option: the directory and the
    // warning stay in the mirror above it rather than vanish from both.
    startLine: yesRow,
    model: {
      question: QUESTION_TEXT,
      options: [
        { label: "Yes, proceed", keys: ["y"] },
        { label: "No, quit", keys: ["n"] },
      ],
      family: "trust",
      coreSignature: regionSignature(lines, question, noRow + 1),
      signature,
    },
  };
}
