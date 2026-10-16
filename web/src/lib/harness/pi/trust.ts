// pi's folder trust prompt, the whole screen pi 1.2.0 paints before its editor in a folder that holds
// project resources it would load (live 2026-10-15):
//
//   ──────────────────────────────────────     top rule
//    Trust project folder?
//    /the/folder/that/wraps/at/the/pane's/
//    width                                     a long path is hard-wrapped, mid-word
//    This allows pi to load .pi settings …     one row, cut at the width
//    → Trust
//      Trust parent folder
//    (/the/parent/that/also/wraps/at/the/      the parent, wrapped under its option at column 1
//    width)
//      Trust (this session only)
//      Do not trust
//      Do not trust (this session only)
//    ↑↓ navigate  enter select  escape/ctrl+c cancel
//   ──────────────────────────────────────     bottom rule, the last row
//
// The options are not numbered, so the question reader (ask.ts) declines it. The plan is ask.ts's plan
// (a), taken from the footer the same way (.adr/0098): Up/Down named as moving and Enter as select make
// a walked pointer list (ADR 0080), and the footer's Escape verb is the last button. Measured on that
// build: Down moved `→` one row, Escape went on with the folder untrusted for the session and wrote
// nothing, and Enter on an option applied it. Every label must be one this prompt is known to print a
// form of, so a changed prompt stays raw. Pure; no pane access.
import { lineText, type StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { parsePiFooter } from "./footer";

export interface PiTrustRegion {
  model: PromptModel;
  startLine: number;
}

const RULE = /^─{8,}$/;
const TITLE = /^ (Trust project folder\?)$/;
// The pointer stands at column 1 and every label at column 3; a row wrapped from the one above starts
// at column 1 with no pointer.
const OPTION = /^ (→| ) (\S.*)$/;
const CONTINUATION = /^ [^\s→]/;
const LABEL = /^(?:Trust|Do not trust)(?: parent folder| \(this session only\))?$/;
// The title, the folder (wrapped), a blank, the explanation and a blank.
const MAX_HEADER_ROWS = 12;
// Blank rows between the options, the footer and the bottom rule: one each in the capture.
const MAX_GAP = 2;

interface Row {
  row: number;
  label: string;
  pointed: boolean;
  description: string;
}

/** The trust prompt at the tail, or null. */
export function detectPiTrust(lines: StyledLine[]): PiTrustRegion | null {
  const texts = lines.map((l) => lineText(l).trimEnd());
  let last = texts.length - 1;
  while (last >= 0 && texts[last] === "") last--;
  if (last < 0 || !RULE.test(texts[last]!)) return null;

  const footerRow = aboveGap(texts, last - 1);
  if (footerRow < 0) return null;
  const footer = parsePiFooter(texts[footerRow]!);
  if (footer === null || !footer.arrowsMove || footer.enter !== "select" || footer.escapeVerb === null) return null;

  const bottom = aboveGap(texts, footerRow - 1);
  if (bottom < 0) return null;
  let first = bottom;
  while (first > 0 && texts[first - 1] !== "") first--;

  const rows: Row[] = [];
  for (let i = first; i <= bottom; i++) {
    const option = OPTION.exec(texts[i]!);
    if (option !== null) {
      rows.push({ row: i, label: option[2]!, pointed: option[1] === "→", description: "" });
      continue;
    }
    const previous = rows.at(-1);
    if (previous === undefined || !CONTINUATION.test(texts[i]!)) return null;
    // pi hard-wraps at the pane's width, mid-word, so the pieces join with nothing between them.
    previous.description += texts[i]!.slice(1);
  }
  if (rows.length < 2 || !rows.every((r) => LABEL.test(r.label))) return null;
  const pointed = rows.findIndex((r) => r.pointed);
  if (pointed < 0 || rows.filter((r) => r.pointed).length !== 1) return null;

  let title = -1;
  for (let i = first - 1; i >= 0 && first - i <= MAX_HEADER_ROWS; i--) {
    if (TITLE.test(texts[i]!)) {
      title = i;
      break;
    }
  }
  if (title < 0) return null;
  const top = aboveGap(texts, title - 1);
  if (top < 0 || !RULE.test(texts[top]!)) return null;

  const options: PromptOption[] = rows.map((r, i) => {
    const option: PromptOption = { label: r.label, keys: pointerWalk(pointed, i), keyLabel: i === pointed ? "→" : "" };
    if (r.description !== "") option.description = r.description;
    return option;
  });
  const verb = footer.escapeVerb;
  options.push({ label: verb.charAt(0).toUpperCase() + verb.slice(1), keys: ["Escape"], keyLabel: "Esc" });

  const region = texts.slice(top, last + 1);
  return {
    // The card prints the question alone, so it starts at the first option: the folder and the
    // explanation stay in the mirror above it rather than vanish from both.
    startLine: first,
    model: {
      question: TITLE.exec(texts[title]!)![1]!,
      options,
      family: "trust",
      signature: region.join("\n"),
      // The pointer is the only thing a walk changes; the rest is the prompt's identity.
      coreSignature: region.map((t) => t.replace(/^ → /, "   ")).join("\n"),
    },
  };
}

/** The nearest non-blank row at or above `from`, across at most MAX_GAP blank rows, or -1. */
function aboveGap(texts: string[], from: number): number {
  let i = from;
  let gap = 0;
  while (i >= 0 && texts[i] === "") {
    i--;
    if (++gap > MAX_GAP) return -1;
  }
  return i;
}
