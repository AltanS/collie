// Codex's folder-trust prompt — the first screen in an untrusted directory. The captured layout
// (TRUST_NOTES.md) is exactly two options with fixed labels under a "Do you trust the contents
// of this directory?" paragraph, with `Press enter to continue` as the tail row. Digits confirm
// directly: `2` quit Codex on the spot (live-probed 2026-08-22), and Enter confirms the
// highlighted row. Anything off the captured layout refuses (fail-closed null). 0.156.1 rewrote
// the prompt (`Trust this folder?`, `1. Trust and continue` / `2. Quit`, `enter continue · esc
// quit`); that copy is read by its own arm at the bottom of this file, with its own keys, and the
// old copy still reads as before. Pure; no pane access.

import type { StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
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

/** Trust prompt at the tail, either copy, or null. */
export function detectTrustRegion(lines: StyledLine[]): TrustRegion | null {
  return detectLegacyTrust(lines) ?? detectFolderAccessTrust(lines);
}

/** The 0.149.0 copy: `1. Yes, continue` / `2. No, quit`, `Press enter to continue`. */
function detectLegacyTrust(lines: StyledLine[]): TrustRegion | null {
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

// The 0.156.1 copy (codex--v0156-trust.txt): a `Folder access` heading and the folder, then
//
//   Trust this folder? Codex can read, edit, and run files here, subject to your permission …
// › 1. Trust and continue
//   2. Quit
//   enter continue · esc quit
//
// Same stakes, new widget: the footer is new, and no key has been probed on it. The rows are
// numbered, but the 0.149.0 probe that licensed digits was on the old widget, so this arm sends
// only what the screen names: Enter (the footer's `enter continue`) after the arrow walk the `›`
// pointer implies, the recipe ADR 0055 set for Claude's pointed trust list. No digit is sent.
// The pointer is in the signature, so a pointer moved at the desk refuses a stale tap.
const NEW_FOOTER = /^\s*enter continue · esc quit$/;
const NEW_YES = /^Trust and continue$/;
const NEW_NO = /^Quit$/;
const NEW_QUESTION = /^\s*Trust this folder\?/;
// The paragraph under the question wraps with the pane; at 50 columns it runs to seven rows.
const NEW_QUESTION_REACH = 16;


function detectFolderAccessTrust(lines: StyledLine[]): TrustRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 2 || !NEW_FOOTER.test(texts[fi]!)) return null;

  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 1) return null;
  const two = OPTION.exec(texts[bottom]!);
  const one = OPTION.exec(texts[bottom - 1]!);
  if (one === null || two === null) return null;
  if (one[1] !== "1" || two[1] !== "2") return null;
  if (!NEW_YES.test(one[2]!.trim()) || !NEW_NO.test(two[2]!.trim())) return null;
  // Exactly one row carries the pointer; it is where a bare Enter lands.
  const pointedOne = texts[bottom - 1]!.startsWith("› ");
  const pointedTwo = texts[bottom]!.startsWith("› ");
  if (pointedOne === pointedTwo) return null;
  const pointed = pointedOne ? 0 : 1;

  // The question opens the paragraph above the options, across one blank row.
  let questionRow = -1;
  const top = skipBlanksUp(texts, bottom - 2);
  for (let i = top; i >= 0 && top - i < NEW_QUESTION_REACH; i--) {
    if (NEW_QUESTION.test(texts[i]!)) {
      questionRow = i;
      break;
    }
    if (texts[i]!.trim() === "") break;
  }
  if (questionRow < 0) return null;

  const signature = regionSignature(lines, questionRow, fi + 1);
  if (signature === "") return null;

  const options: PromptOption[] = [
    { label: "Trust and continue", keys: pointerWalk(pointed, 0) },
    { label: "Quit", keys: pointerWalk(pointed, 1) },
  ];
  options[pointed] = { ...options[pointed]!, keyLabel: "›" };

  return {
    startLine: bottom - 1,
    model: {
      question: "Trust this folder?",
      options,
      family: "trust",
      coreSignature: texts[questionRow]!.trim(),
      signature,
    },
  };
}
