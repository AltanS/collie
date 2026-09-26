// Codex's approval dialogs — "Would you like to run the following command?" (exec) and, since
// 0.156.1 was captured, "Would you like to make the following edits?" (patch) — over pointer-
// numbered options with letter shortcuts, `Press enter to confirm or esc to cancel` as the tail
// row. The card is CLASSIFIED, not layout-pinned (APPROVAL_NOTES.md): the first row must be the
// one-shot Yes (`Yes, proceed (y)`), the last row the reject (`No, and tell Codex what to do
// differently (esc)`), and every row between must PROVE it is a persistent mode change by its
// label (`don't ask again …`) — those are never buttons. There may be none between: 0.156.1 paints
// a two-row exec card. A row that fits no class refuses the whole card. A label too long for the
// pane wraps, and its rows are rejoined before it is classified. Exec digits confirm directly:
// `1` ran the approved command and `3` rejected it with the command never running (both
// live-probed 2026-08-22, with the reject negative-controlled). The patch card sends the
// shortcuts it prints instead (`HEADERS` below). Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lastNonBlankIndex, lineText, regionSignature, rstrip, skipBlanksUp } from "./markers";

export interface ApprovalRegion {
  model: PromptModel;
  startLine: number;
}

const FOOTER = /^\s*Press enter to confirm or esc to cancel$/;
const OPTION = /^(?:› |\s{2})([1-9])\. (.+)$/;
// A label too long for the pane wraps onto rows indented to the LABEL's column: `  N. ` and `› N. `
// are both five cells wide (codex--v0156-approval-exec-wrapped-50.txt). Exactly five, so a row
// indented anywhere else (a `$ command` row, a heredoc line) is never read as part of a label.
const LABEL_CONTINUATION = /^ {5}\S/;
// EXACT labels (after the shortcut parenthetical is stripped), not prefixes: a suffix-extended
// row ("Yes, proceed and remember forever") could carry persistent semantics behind a
// one-shot-looking button (review repro). Only the captured wording earns a keystroke.
const YES_ROW = /^Yes, proceed$/;
const NO_ROW = /^No, and tell Codex what to do differently$/;
const PERSISTENT = /don['’]t ask again/i;
const SHORTCUT = /\s*\(([^()]*)\)\s*$/;
// How far above the options the header may sit. The `$ command` preview prints a heredoc in full
// (codex--v0156-approval-exec-2opt.txt), so the reach is sized for a multi-line command, not for
// the one-line case.
const HEADER_REACH = 40;

/**
 * The two approval kinds, told apart by their header, and the keys each one's buttons send.
 *
 *   - exec: DIGITS, live-probed on the exec card (APPROVAL_NOTES.md): `1` ran the command, `3`
 *     rejected it. The reject is the LAST row's digit, so the 0.156.1 two-row card (no persistent
 *     row) sends `2`, the same widget's same rule.
 *   - patch: the SHORTCUTS the rows print, `(y)` and `(esc)`. Nothing has probed a key on the
 *     patch card, so it gets the keys the screen names rather than a digit carried over from the
 *     exec card. `y` is the key probed on the exec card's Yes row, and Escape is what the footer
 *     and the reject row both print, and what the adapter's unread-dialog card sent here anyway.
 */
type ApprovalKind = "exec" | "patch";

const HEADERS: { kind: ApprovalKind; header: RegExp; question: string }[] = [
  {
    kind: "exec",
    header: /^\s*Would you like to run the following command\?$/,
    question: "Would you like to run the following command?",
  },
  {
    kind: "patch",
    header: /^\s*Would you like to make the following edits\?$/,
    question: "Would you like to make the following edits?",
  },
];

interface OptionRow {
  digit: string;
  /** The label, wrapped rows rejoined, shortcut still on. */
  label: string;
  /** The row the option starts on. */
  row: number;
}

/** The button face: the row label minus its trailing keyboard-shortcut parenthetical. */
function buttonLabel(label: string): string {
  return label.replace(SHORTCUT, "").trim();
}

/** The trailing keyboard-shortcut parenthetical, `y` for `… (y)`, or null. */
function shortcutOf(label: string): string | null {
  return SHORTCUT.exec(label)?.[1] ?? null;
}

/** The contiguous option run ending at `bottom`, wrapped labels rejoined, in visual order; and the
 *  row above it. Null when a wrapped row has no option to belong to. */
function readOptions(texts: string[], bottom: number): { options: OptionRow[]; above: number } | null {
  const options: OptionRow[] = [];
  let wrapped: string[] = [];
  let i = bottom;
  for (; i >= 0; i--) {
    const t = texts[i]!;
    const opt = OPTION.exec(t);
    if (opt !== null) {
      const label = [opt[2]!.trim(), ...wrapped.map((w) => w.trim())].join(" ");
      options.unshift({ digit: opt[1]!, label, row: i });
      wrapped = [];
      continue;
    }
    if (LABEL_CONTINUATION.test(t)) {
      wrapped.unshift(t);
      continue;
    }
    break;
  }
  if (wrapped.length > 0) return null;
  return { options, above: i };
}

/** Approval card (exec or patch) at the tail, or null. */
export function detectApprovalRegion(lines: StyledLine[]): ApprovalRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0 || !FOOTER.test(texts[fi]!)) return null;

  // One blank row separates the footer from the option run (every capture); the options
  // themselves are contiguous. Visual order, not a Map: duplicates and shuffles must fail the
  // digit sequence.
  const bottom = skipBlanksUp(texts, fi - 1);
  if (bottom < 0) return null;
  const read = readOptions(texts, bottom);
  if (read === null) return null;
  const { options: ordered, above: i } = read;
  const n = ordered.length;
  if (n < 2) return null;
  for (let k = 0; k < n; k++) {
    if (ordered[k]!.digit !== String(k + 1)) return null;
  }

  const yes = ordered[0]!;
  const no = ordered[n - 1]!;
  if (!YES_ROW.test(buttonLabel(yes.label)) || !NO_ROW.test(buttonLabel(no.label))) return null;
  for (let k = 1; k < n - 1; k++) {
    if (!PERSISTENT.test(ordered[k]!.label)) return null;
  }

  // Between the options and the header sit the `$ command`, Reason and Environment rows (or the
  // patch card's Description and Destination) — blank-separated content the mirror keeps. The
  // header itself must be on screen within the reach.
  let headerRow = -1;
  let kind: (typeof HEADERS)[number] | undefined;
  for (let k = i; k >= 0 && i - k < HEADER_REACH; k--) {
    kind = HEADERS.find((h) => h.header.test(texts[k]!));
    if (kind !== undefined) {
      headerRow = k;
      break;
    }
    if (!isBlank(texts[k]!) && OPTION.test(texts[k]!)) return null;
  }
  if (headerRow < 0 || kind === undefined) return null;

  let options: PromptOption[];
  if (kind.kind === "exec") {
    options = [
      { label: buttonLabel(yes.label), keys: ["1"] },
      { label: buttonLabel(no.label), keys: [String(n)] },
    ];
  } else {
    // The keys ARE the printed shortcuts, so a row that prints another one is another widget.
    if (shortcutOf(yes.label) !== "y" || shortcutOf(no.label) !== "esc") return null;
    options = [
      { label: buttonLabel(yes.label), keys: ["y"] },
      { label: buttonLabel(no.label), keys: ["Escape"], keyLabel: "Esc" },
    ];
  }

  const signature = regionSignature(lines, headerRow, fi + 1);
  if (signature === "") return null;

  return {
    // Persistent rows sit between Yes and the reject. Replacing from the first option
    // swallowed them (they are never buttons). The block starts at the reject so they
    // stay in the raw mirror with the header, Reason, and `$ command`.
    startLine: no.row,
    model: {
      question: kind.question,
      options,
      family: "permission",
      coreSignature: texts[headerRow]!.trim(),
      signature,
    },
  };
}
