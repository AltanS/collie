// Multi-select question dialog lift for the pi question extension.
//
// Lifts standalone multi-select and questionnaire multi-select pages into a MultiSelectBlock /
// MultiSelectModel (phase "checkbox").
//
// Choreography & Contract:
// - Standalone multi: steps = null
// - Questionnaire multi pages: steps = WizardStepChip[] from the tab bar
// - Toggle recipe: "walkSpace" (walk Up/Down directly, verify on fresh read, then Space)
// - Advance keys: ["Enter"] (pi confirms the current selection on Enter)
// - Advance label: "Confirm"
// - Advance needs checked: true (Confirm needs >= 1 checked option AND the pointer on an option)
// - Pointer position: "option" (pointerRow = option n) when pointing at an option, "other"
//   (pointerRow = rawOptions.length + 1) when pointing at "Type something." (allowing navigation back to options)
// - Free-answer row ("Type something.") is never an option
//
// Refusals (returns null):
// - Free-answer editor open (frame.editorOpen)
// - Questionnaires with Review tab active (handled by review grammar)
// - Single-select dialogs (no checkbox options / footer has "Enter to select")
// - Scrolled-up dialogs (must be tail-anchored)
// - More than 9 options (>9) or 0 options

import type { StyledLine } from "../../blocks";
import { lineText } from "../../blocks";
import type {
  MultiPointer,
  MultiSelectModel,
  MultiSelectOption,
} from "../multi-select-model";
import type { WizardStepChip } from "../wizard-model";
import { detectDialogFrame } from "./frame";
import { rstrip } from "./markers";

/** Lifted multi-select region in the terminal buffer. */
export interface MultiSelectRegion {
  model: MultiSelectModel;
  /** First row replaced by the block (the dialog's top accent rule). */
  startLine: number;
}

/**
 * Detect a multi-select dialog (standalone or questionnaire step) at the tail of `lines`.
 * Returns the MultiSelectRegion or null if declined.
 */
export function detectMultiSelectRegion(lines: StyledLine[]): MultiSelectRegion | null {
  const frame = detectDialogFrame(lines);
  if (!frame) return null;

  if (frame.editorOpen) return null;

  if (frame.tabBar) {
    if (frame.tabBar.isReviewActive) return null;
    if (frame.tabBar.activeChipIndex < 0) return null;
  }

  // Only the tick/toggle hint tells a multi-select page from a single-select one.
  if (!/Space(?:\s+to)?\s+(?:tick|toggle)/i.test(frame.footerText)) return null;

  let qStart = frame.tabBar ? frame.tabBar.row + 1 : frame.topRule + 1;
  while (qStart < frame.footerStart && lineText(lines[qStart]!).trim() === "") {
    qStart++;
  }
  let qEnd = qStart;
  while (qEnd < frame.footerStart && lineText(lines[qEnd]!).trim() !== "") {
    qEnd++;
  }
  if (qEnd === qStart) return null;

  const question = lines
    .slice(qStart, qEnd)
    .map((l) => rstrip(lineText(l)).trim())
    .join(" ");

  interface RawOption {
    n: number;
    checked: boolean;
    label: string;
    desc: string[];
    hasPointer: boolean;
  }

  const rawOptions: RawOption[] = [];
  let currentOpt: RawOption | null = null;
  let pointedOther = false;
  let pointerCount = 0;

  for (let i = qEnd + 1; i < frame.footerStart; i++) {
    const raw = lineText(lines[i]!);
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    const hasPointer = /^\s*>\s+/.test(raw);
    if (hasPointer) pointerCount++;

    const m = /^\s*(?:>\s*|\s{2})\[([ xX✔✓])\]\s*(\d+)\.\s+(.*)$/.exec(raw);
    if (m) {
      const glyph = m[1]!;
      const checked = glyph.toLowerCase() === "x" || glyph === "✔" || glyph === "✓";
      const n = Number(m[2]!);
      const rawLabel = m[3]!;
      const label = rawLabel.replace(/ ✓$/, "").trim();
      currentOpt = { n, checked, label, desc: [], hasPointer };
      rawOptions.push(currentOpt);
    } else if (/^\s*(?:>\s*|\s+)(?:\d+\.\s+)?Type something\./.test(raw)) {
      currentOpt = null;
      if (hasPointer) pointedOther = true;
    } else if (currentOpt && raw.startsWith("    ")) {
      // A description wraps under its option, indented by at least four spaces.
      currentOpt.desc.push(trimmed);
    } else {
      return null;
    }
  }

  // Two pointers is a torn frame, not a dialog.
  if (pointerCount > 1) return null;

  if (rawOptions.length === 0 || rawOptions.length > 9) return null;

  for (let k = 0; k < rawOptions.length; k++) {
    if (rawOptions[k]!.n !== k + 1) return null;
  }

  let pointer: MultiPointer = null;
  let pointerRow: number | null = null;

  const pointedOpt = rawOptions.find((o) => o.hasPointer);
  if (pointedOpt) {
    pointer = "option";
    pointerRow = pointedOpt.n;
  } else if (pointedOther) {
    pointer = "other";
    pointerRow = rawOptions.length + 1;
  }

  const options: MultiSelectOption[] = rawOptions.map((o) => {
    const opt: MultiSelectOption = {
      n: o.n,
      label: o.label,
      checked: o.checked,
    };
    if (o.desc.length > 0) {
      opt.description = o.desc.join(" ");
    }
    return opt;
  });

  const steps: WizardStepChip[] | null = frame.tabBar
    ? frame.tabBar.chips.map((c) => ({
        label: c.label,
        answered: c.answered,
        current: c.active,
      }))
    : null;

  const regionLines = lines.slice(frame.topRule, frame.bottomRule + 1);
  const regionSignature = regionLines.map(lineText).join("\n");

  // The identity signature blanks the pointer, the ticks and the answered chips, so a walk or a
  // toggle stays the same dialog.
  const signature = regionLines
    .map((l) =>
      lineText(l)
        .replace(/^(\s*)>(?=\s)/, "$1 ")
        .replace(/\[[ xX✔✓]\]/g, "[ ]")
        .replace(/▣/g, "▢"),
    )
    .join("\n");

  const model: MultiSelectModel = {
    phase: "checkbox",
    question,
    options,
    escape: null,
    pointer,
    pointerRow,
    steps,
    advanceLabel: "Confirm",
    advanceKeys: ["Enter"],
    advanceNeedsChecked: true,
    toggle: "walkSpace",
    signature,
    regionSignature,
  };

  return {
    model,
    startLine: frame.topRule,
  };
}

/**
 * Detect a multi-select dialog at the tail of `lines`, returning just the model.
 */
export function detectMultiSelect(lines: StyledLine[]): MultiSelectModel | null {
  return detectMultiSelectRegion(lines)?.model ?? null;
}
