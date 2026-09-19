// Checkbox + review detection — the grammar that recognises Muse's multi-select `Request user
// input` dialog (checkbox phase) and its confirm screen (review phase) above the composer tail
// chrome, and lifts them into a `MultiSelectModel`.
//
// Checkbox:
//
//     ◇ Request user input Toppings — running (23s)
//
//       Which pizza toppings do you want?
//
//       › 1. [ ] Cheese (Recommended)
//         2. [ ] Pepperoni
//         3. [ ] Mushrooms
//         4. [ ] None of the above     Optionally, add details in notes (tab).
//         5. Submit answer (0 checked)
//
//       Enter to toggle · Submit row to continue · ↑/↓ to move · Tab for an optional note · Esc to
//       interrupt
//
// Review:
//
//       Review answers before submit · Enter to edit or submit · ↑/↓ to move · Esc to go back
//         Toppings: Pepperoni
//       > Submit answers
//         Interrupt turn
//
// Everything here is a PURE function over `StyledLine[]`, driven entirely by the fixture corpus
// (web/src/fixtures/panes/muse--*.txt). It never touches a pane or the network. The tail invariant
// is the backbone: the dialog must sit directly above the tail chrome, so one that has scrolled up
// (with transcript below it) simply doesn't match — the false-positive guard.
//
// Muse's choreography is pointer-driven, not digit-driven (probed live — see
// DIALOG_NOTES.md): digits MOVE the `›` pointer, Enter toggles (checkbox) or submits
// (review), and review swallows digits entirely. The model carries that explicitly (`toggle` /
// `submit`: `"pointer"`), and the core macros in lib/multi-select-action.ts branch on it. An open
// `Note (optional):` row declines the checkbox lift the same way it declines single-select: while
// open it owns the keyboard.

import { lineText, type StyledLine } from "../../blocks";
import type {
  MultiPointer,
  MultiSelectModel,
  MultiSelectOption,
} from "../multi-select-model";
import {
  chromeTop,
  footerAboveChrome,
  headerAndQuestion,
  isNoteRow,
  locateTail,
  menuRowsContiguous,
  parseNumberedOption,
  parseSubmitRow,
  regionSignature,
  rstrip,
  trailingMenuRows,
} from "./markers";

// The checkbox footer LEAD — matched as a prefix over the footer rows joined with a space, because
// the bar wraps mid-phrase at narrower widths (`Esc to` / `interrupt` on the capture host).
const CHECKBOX_FOOTER_LEAD = "Enter to toggle";

// The review lead row's fixed opening. Single-row match (no join): it abuts summary rows, so a
// wrapped lead is indistinguishable from lead-plus-summary — narrow-pane reviews decline instead.
const REVIEW_LEAD = "Review answers before submit";

// The review's two action rows, Muse's fixed strings. Unnumbered — the pointer is the whole state,
// which is why the review recipe walks it instead of sending digits (probed: digits are swallowed).
const REVIEW_SUBMIT_LABEL = "Submit answers";
const REVIEW_CANCEL_LABEL = "Interrupt turn";

// Options live within a couple dozen lines of the footer.
const OPTION_SCAN_WINDOW = 24;

// The notes hint Muse appends to the last checkbox row. Static chrome, stripped for the button
// label by EXACT match (a rewording degrades to showing the full row, never a mangled label).
const NOTES_HINT_SUFFIX = "  Optionally, add details in notes (tab).";

// A Muse checkbox prefix: `[ ]` / `[x]` exactly (measured — no other glyph was observed, and an
// unknown one declines the row rather than guessing its state).
const CHECKBOX_PREFIX = /^\[([ x])\]\s*/;

/** Split `[ ] Label` / `[x] Label` into its checked state + rest, or null. */
function checkboxState(label: string): { checked: boolean; rest: string } | null {
  const m = CHECKBOX_PREFIX.exec(label);
  if (!m) return null;
  return { checked: m[1] === "x", rest: label.slice(m[0].length) };
}

/**
 * The full detection result buildBlocks needs: the model PLUS `startLine` — the question row for
 * checkbox, the lead row for review. The menu region is [`startLine` … tail], which the renderer
 * replaces with the native block (it renders its own QuestionHeading, so the question must NOT stay
 * in the raw above). The live header stays raw either way: its timer would churn any signature.
 */
export interface CheckboxRegion {
  model: MultiSelectModel;
  startLine: number;
}

/**
 * Detect a checkbox or review dialog above the tail chrome. Returns the model + its start line, or
 * null when the tail is neither. Pure; the caller owns pane access.
 */
export function detectCheckboxRegion(lines: StyledLine[]): CheckboxRegion | null {
  return detectCheckboxPhase(lines) ?? detectReviewPhase(lines);
}

function detectCheckboxPhase(lines: StyledLine[]): CheckboxRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. Tail chrome, then the toggle footer directly above it.
  const tail = locateTail(lines);
  if (tail === null) return null;
  const top = chromeTop(tail);
  const footer = footerAboveChrome(texts, top);
  if (!footer || !footer.joined.startsWith(CHECKBOX_FOOTER_LEAD)) return null;

  // 2. The Submit row with checkbox options above it: options numbered 1..k contiguous, Submit at
  //    k+1. The Submit digit floats with the option count (5 on toppings, 4 on drinks) — read, never
  //    assumed. Option digits must stay single-key (≤9); the Submit digit is never sent (the macro
  //    walks), so it may be 10.
  const from = Math.max(0, footer.start - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i < footer.start; i++) {
    const parsed = parseNumberedOption(texts[i]!);
    if (parsed) rows.push({ index: i, n: parsed.n, label: parsed.label });
  }
  if (rows.length < 2) return null;
  const last = rows[rows.length - 1]!;
  const submit = parseSubmitRow(texts[last.index]!);
  if (!submit) return null;
  const menu = trailingMenuRows(rows.slice(0, -1));
  if (menu.length < 1 || submit.n !== menu.length + 1) return null;
  if (menu.length > 9) return null;
  // Gapless rows only — options contiguous, Submit directly below the last one (markers.ts).
  if (!menuRowsContiguous(menu)) return null;
  if (last.index !== menu[menu.length - 1]!.index + 1) return null;
  const firstOpt = menu[0]!.index;
  // Every option row must carry a checkbox — a plain row in the run is a shape we don't know.
  const options: MultiSelectOption[] = [];
  for (const row of menu) {
    const box = checkboxState(row.label);
    if (!box) return null;
    let label = box.rest;
    if (label.endsWith(NOTES_HINT_SUFFIX)) label = label.slice(0, -NOTES_HINT_SUFFIX.length);
    options.push({ n: row.n, label, checked: box.checked });
  }

  // 3. An open note row owns the keyboard — no buttons while one is present.
  for (let i = firstOpt; i <= footer.end; i++) {
    if (isNoteRow(texts[i]!)) return null;
  }

  // 4. Live header + structural question.
  const hq = headerAndQuestion(texts, firstOpt);
  if (!hq) return null;

  // 5. Pointer: exactly one `›` expected; anything else is torn output and reports unknown (the
  //    macros verify before every Enter, so unknown only costs retries, never a blind key).
  let pointer: MultiPointer = null;
  let pointerRow: number | null = null;
  const pointed = menu.filter((row) => texts[row.index]!.includes("›"));
  const submitPointed = texts[last.index]!.includes("›");
  if (pointed.length + (submitPointed ? 1 : 0) === 1) {
    if (submitPointed) {
      pointer = "advance";
    } else {
      pointer = "option";
      pointerRow = pointed[0]!.n;
    }
  } else if (pointed.length > 0 || submitPointed) {
    pointer = "other";
  }

  // Signature: question → footer end. The footer is STATIC here — no pointer, no count (unlike
  // Claude's, which gains/loses its nano hint as the pointer walks) — so it is safe inside both the
  // identity signature and the bound region, and REQUIRED in the region: the bridge only binds a
  // match ending within 6 non-blank rows of the tail, and ending at the Submit row strands 6 rows
  // below the match (2 footer + Voice + ❯ + rule + statusline), so every first write 409s. Caught
  // live 2026-09-18: two toggle taps, both `not_in_tail`, on a screen that never moved. Pointer +
  // checkbox state + count are normalised out of the identity half (the macros move the pointer by
  // design; flips compare via options[]). The live header stays excluded — timer.
  const signature = texts
    .slice(hq.questionAt, footer.end + 1)
    .map((t) =>
      t
        .replaceAll("›", " ")
        .replaceAll("[x]", "[ ]")
        .replace(/Submit answer \(\d+ checked\)/, "Submit answer (checked)"),
    )
    .join("\n");
  const regionSignatureText = regionSignature(texts, hq.questionAt, footer.end);
  return {
    model: {
      phase: "checkbox",
      question: hq.question,
      options,
      escape: null, // "None of the above" is a plain checkbox here (probed: toggles + counts)
      pointer,
      pointerRow,
      steps: null, // Muse asks standalone questions — never a wizard step
      // The count churns on every flip while comparators compare this label, so the button carries
      // the stable stem. Deliberate deviation from "says what the terminal says", stated here.
      advanceLabel: "Submit answer",
      toggle: "pointer",
      signature,
      regionSignature: regionSignatureText,
    },
    startLine: hq.questionAt,
  };
}

function detectReviewPhase(lines: StyledLine[]): CheckboxRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. Tail chrome; the Interrupt row directly above it (blanks tolerated), the Submit row above
  //    that. Both unnumbered, pointer or spaces — the pointer position is the whole state.
  const tail = locateTail(lines);
  if (tail === null) return null;
  const top = chromeTop(tail);
  let ci = top - 1;
  while (ci >= 0 && texts[ci]!.trim() === "") ci--;
  if (ci < 0) return null;
  const cancel = parseReviewRow(texts[ci]!);
  if (!cancel || cancel.which !== "cancel") return null;
  let si = ci - 1;
  while (si >= 0 && texts[si]!.trim() === "") si--;
  if (si < 0) return null;
  const submit = parseReviewRow(texts[si]!);
  if (!submit || submit.which !== "submit") return null;

  // 2. The lead row above the summary rows. Summaries (`Q: answers`) sit between lead and Submit;
  //    each must contain ": " — a wrapped summary (continuation without one) declines rather than
  //    guessing the fold (no capture exists for it). The scan stops AT the lead: it carries no ": "
  //    and must never be read as a summary.
  let li = si - 1;
  while (li >= 0 && texts[li]!.trim() === "") li--;
  const summaries: number[] = [];
  while (li >= 0 && texts[li]!.trim() !== "" && !texts[li]!.trim().startsWith(REVIEW_LEAD)) {
    if (!texts[li]!.includes(": ")) return null;
    summaries.unshift(li);
    li--;
  }
  while (li >= 0 && texts[li]!.trim() === "") li--;
  if (li < 0 || !texts[li]!.trim().startsWith(REVIEW_LEAD)) return null;

  // 3. Pointer: exactly one `>` expected across the two action rows.
  let pointer: "submit" | "cancel" | "other" | null = null;
  const onSubmit = texts[si]!.includes(">");
  const onCancel = texts[ci]!.includes(">");
  if (onSubmit && !onCancel) pointer = "submit";
  else if (onCancel && !onSubmit) pointer = "cancel";
  else if (onSubmit || onCancel) pointer = "other";

  const signature = texts
    .slice(li, ci + 1)
    .map((t) => t.replaceAll(">", " "))
    .join("\n");
  return {
    model: {
      phase: "review",
      incomplete: false, // Muse shows no incompleteness state — false is the honest reading
      pointer,
      submit: "pointer",
      cancelLabel: REVIEW_CANCEL_LABEL,
      signature,
      regionSignature: regionSignature(texts, li, ci),
    },
    startLine: li,
  };
}

/** Parse a review action row (`> Submit answers` / `  Interrupt turn`), or null. */
function parseReviewRow(text: string): { which: "submit" | "cancel" } | null {
  const t = rstrip(text).trim();
  const body = t.startsWith(">") ? t.slice(1).trim() : t;
  // A bare (pointer-less) row must still be indented — a column-0 twin would be transcript, and the
  // pointer check above already consumed the `>` form.
  if (!t.startsWith(">") && !/^\s/.test(rstrip(text))) return null;
  if (body === REVIEW_SUBMIT_LABEL) return { which: "submit" };
  if (body === REVIEW_CANCEL_LABEL) return { which: "cancel" };
  return null;
}

/**
 * Detect a checkbox or review dialog at the tail of `lines`, returning just the model (or null).
 * The thin public matcher — used by the race guard to re-derive from a fresh buffer and by tests.
 * buildBlocks uses {@link detectCheckboxRegion} for the render boundary.
 */
export function detectCheckbox(lines: StyledLine[]): MultiSelectModel | null {
  return detectCheckboxRegion(lines)?.model ?? null;
}
