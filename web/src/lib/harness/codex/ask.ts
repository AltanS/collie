// Codex's `request_user_input` question card — a `Question X/Y (N unanswered)` header, the
// question line, pointer-numbered options with two-space-split descriptions (including the
// tool's own auto-added "None of the above" row), and a `tab to add notes | enter to submit …`
// footer. Digits confirm directly: a digit answers the CURRENT question, advancing a
// multi-question set and submitting on the last one (live-probed 2026-08-22 on 1-question and
// 2-question calls; ASK_NOTES.md). The notes flow stays in the terminal: when the notes box is
// focused the footer flips to `tab or esc to clear notes …` and this detector refuses — a digit
// would type into the box. Esc interrupts the WHOLE conversation and is never emitted. Pure;
// no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { lastNonBlankIndex, lineText, regionSignature, rstrip, skipBlanksUp } from "./markers";

export interface AskRegion {
  model: PromptModel;
  startLine: number;
}

// Both captured footer variants start with the notes hint and carry an enter-submit verb
// (`enter to submit answer` mid-set, `enter to submit all` on the final question).
const FOOTER = /^\s*tab to add notes \| enter to submit\b/;
// The notes-focused footer — the state in which a digit types instead of answering.
const NOTES_FOOTER = /^\s*tab or esc to clear notes\b/;
const NOTES_BOX = /^\s*› Add notes\b/;
const HEADER = /^\s*Question (\d+)\/(\d+) \(\d+ unanswered\)$/;
// Selected rows lead with `  › `, unselected with four spaces.
const OPTION = /^(?:\s{2}› |\s{4})([1-9])\. (.+)$/;

/** request_user_input card at the tail, or null. */
export function detectAskRegion(lines: StyledLine[]): AskRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;
  // The notes-focused state is explicitly refused rather than merely unrecognized, so the
  // refusal survives layout drift in the rows above.
  if (NOTES_FOOTER.test(texts[fi]!)) return null;
  if (!FOOTER.test(texts[fi]!)) return null;

  // One blank row separates the footer from the option run; the options are contiguous.
  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 0) return null;
  if (NOTES_BOX.test(texts[bottom]!)) return null;

  const options: PromptOption[] = [];
  let i = bottom;
  for (; i >= 0; i--) {
    const t = texts[i]!;
    if (NOTES_BOX.test(t)) return null;
    const opt = OPTION.exec(t);
    if (opt === null) break;
    const raw = opt[2]!.trim();
    const split = raw.split(/\s{2,}/);
    const label = (split[0] ?? raw).trim();
    const description = split.slice(1).join(" ").trim();
    const option: PromptOption = { label, keys: [opt[1]!] };
    if (description !== "") option.description = description;
    options.unshift(option);
  }
  if (options.length < 2) return null;
  for (let k = 0; k < options.length; k++) {
    if (options[k]!.keys[0] !== String(k + 1)) return null;
  }

  // Above the options (across one blank row): the question line, with the Question X/Y header
  // directly above it. Both are required — they are what separates this card from any other
  // pointer-numbered list.
  const questionRow = skipBlanksUp(texts, i);
  if (questionRow < 1) return null;
  const question = texts[questionRow]!.trim();
  if (question === "" || !HEADER.test(texts[questionRow - 1]!)) return null;

  const start = bottom - options.length + 1;
  const signature = regionSignature(lines, questionRow - 1, fi + 1);
  if (signature === "") return null;

  return {
    // The block replaces the OPTIONS down; the header and question stay in the raw mirror.
    startLine: start,
    model: {
      question,
      options,
      // `select` pins the renderer's caption; the KEYS carry this harness's probed recipe. The
      // family doc describes Claude's digit-then-Enter — Codex's card submits on the digit alone
      // (probed, ASK_NOTES.md), and the explicit per-option `keys` are what the send path uses.
      family: "select",
      coreSignature: question,
      signature,
    },
  };
}
