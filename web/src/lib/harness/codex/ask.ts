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
  const end = lastNonBlankIndex(texts);
  let fi = end;
  if (/^\s*esc to interrupt$/.test(texts[fi] ?? "")) fi--;
  if (fi < 0) return null;
  // The notes-focused state is explicitly refused rather than merely unrecognized, so the
  // refusal survives layout drift in the rows above.
  if (NOTES_FOOTER.test(texts[fi]!)) return null;
  if (!FOOTER.test(texts[fi]!)) return null;

  // One blank row separates the footer from the option run. Descriptions may wrap.
  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 0) return null;
  if (NOTES_BOX.test(texts[bottom]!)) return null;

  const options: PromptOption[] = [];
  let continuation: string[] = [];
  let i = bottom;
  for (; i >= 0; i--) {
    const t = texts[i]!;
    if (NOTES_BOX.test(t)) return null;
    const opt = OPTION.exec(t);
    if (opt === null) {
      if (/^ {6,}\S/.test(t) && !/^\s*\d+\./.test(t)) {
        continuation.unshift(t);
        continue;
      }
      break;
    }
    const raw = opt[2]!.trim();
    const split = raw.split(/\s{2,}/);
    const label = (split[0] ?? raw).trim();
    const description = split.slice(1).join(" ").trim();
    const option: PromptOption = { label, keys: [opt[1]!] };
    if (continuation.length > 0) {
      // Only description rows may continue. A label-only option stays raw when it wraps.
      const separator = /\s{2,}/.exec(raw);
      if (separator === null) return null;
      const descriptionColumn = t.indexOf(raw) + separator.index + separator[0].length;
      if (description === "" || continuation.some((row) => row.search(/\S/) < descriptionColumn)) {
        return null;
      }
      option.description = [description, ...continuation.map((row) => row.trim())].join(" ");
      continuation = [];
    } else if (description !== "") option.description = description;
    options.unshift(option);
  }
  if (continuation.length > 0 || options.length < 2) return null;
  for (let k = 0; k < options.length; k++) {
    if (options[k]!.keys[0] !== String(k + 1)) return null;
  }

  const start = i + 1;
  const questionEnd = skipBlanksUp(texts, i);
  let header = questionEnd;
  while (header >= 0 && /^ {2}\S/.test(texts[header]!) && !HEADER.test(texts[header]!)) {
    if (NOTES_BOX.test(texts[header]!)) return null;
    header--;
  }
  if (header < 0 || !HEADER.test(texts[header]!) || header === questionEnd) return null;
  const question = texts.slice(header + 1, questionEnd + 1).map((row) => row.trim()).join(" ");
  const signature = regionSignature(lines, header, end + 1);
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
