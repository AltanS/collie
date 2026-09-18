// Single-select detection — the grammar that recognises Muse's `Request user input` radio
// dialog sitting above the composer tail chrome and lifts it into a `PromptModel`.
//
//     ◇ Request user input Color — running (22s)
//
//       Which color do you prefer?
//
//       › 1. Red (Recommended)
//         2. Green
//         3. Blue
//         4. None of the above  Optionally, add details in notes (tab).
//
//       Enter to select · ↑/↓ to move · Tab for an optional note · Esc to interrupt
//
//     ── Voice input … ──
//     ❯
//     ────…
//       <statusline>
//
// Everything here is a PURE function over `StyledLine[]`, driven entirely by the fixture corpus
// (web/src/fixtures/panes/muse--*.txt). It never touches a pane or the network. The tail invariant
// is the backbone: the footer must sit directly above the tail chrome, so a question that has
// scrolled up (with transcript below it) simply doesn't match — the false-positive guard.
//
// Two declines are load-bearing. A checkbox prefix on any option row belongs to the checkbox
// grammar (checkbox.ts) — this one bails. And an open `Note (optional):` row owns the keyboard
// (probed: every keystroke types into it, footer unchanged), so a region containing one stays raw
// with no buttons at all.

import { lineText, type StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import {
  chromeTop,
  footerAboveChrome,
  headerAndQuestion,
  isNoteRow,
  locateTail,
  menuRowsContiguous,
  parseNumberedOption,
  regionSignature,
  rstrip,
  trailingMenuRows,
} from "./markers";

// The footer LEAD — matched as a prefix over the footer rows joined with a space, because the bar
// wraps mid-phrase at narrower widths (`Esc to` / `interrupt` on the capture host). The lead is
// Muse's fixed string; anything else is some other dialog.
const FOOTER_LEAD = "Enter to select";

// The notes hint Muse appends to the last option row. Static chrome, not part of the answer —
// stripped for the button label by EXACT match, so a rewording degrades to showing the full row
// rather than mangling a label.
const NOTES_HINT_SUFFIX = "  Optionally, add details in notes (tab).";

// Options live within a couple dozen lines of the footer; scanning a bounded window keeps a stray
// "N." far up in scrollback history from ever being mistaken for a menu row.
const OPTION_SCAN_WINDOW = 24;

/**
 * The full detection result buildBlocks needs: the model PLUS `startLine`, the index of the first
 * option row — the menu region is [`startLine` … tail], which the renderer replaces with buttons.
 * Everything above `startLine` (header, question) stays raw, so no context is lost and the question
 * isn't shown twice (the prompt renderer captions by family, never repeats it).
 */
export interface QuestionRegion {
  model: PromptModel;
  startLine: number;
}

/**
 * Detect a single-select question above the tail chrome. Returns the model + its start line, or
 * null when the tail isn't one. Pure; the caller owns pane access.
 */
export function detectQuestionRegion(lines: StyledLine[]): QuestionRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. Tail chrome, then the footer directly above it. A question that has scrolled up has
  //    transcript here instead, so it bails (the false-positive gate).
  const tail = locateTail(lines);
  if (tail === null) return null;
  const top = chromeTop(tail);
  const footer = footerAboveChrome(texts, top);
  if (!footer || !footer.joined.startsWith(FOOTER_LEAD)) return null;
  const footerStart = footer.start;
  const fi = footer.end;

  // 2. Numbered option rows just above the footer. The menu is the trailing 1,2,…,m run of them.
  const from = Math.max(0, footerStart - OPTION_SCAN_WINDOW);
  const rows: { index: number; n: number; label: string }[] = [];
  for (let i = from; i < footerStart; i++) {
    const parsed = parseNumberedOption(texts[i]!);
    if (parsed) rows.push({ index: i, n: parsed.n, label: parsed.label });
  }
  const menu = trailingMenuRows(rows);
  if (menu.length < 2) return null; // ≥2 rows numbered 1,2,…,m — else not a question tail.
  // A menu numbered past 9 would need the two-key digit ("10"), which Herdr's send_keys rejects —
  // so up-levelling it would emit an unsendable keystroke plan. Bail to raw + the keys pad.
  if (menu.length > 9) return null;
  // Gapless rows only — a transcript numbered list must never fuse into the run (markers.ts).
  if (!menuRowsContiguous(menu)) return null;
  const firstOpt = menu[0]!.index;

  // A checkbox prefix anywhere in the run belongs to the checkbox grammar — bail, don't half-lift.
  if (menu.some((row) => /^\[[ x]\]/.test(row.label))) return null;
  // An open note row owns the keyboard (digits type into it) — no buttons while one is present.
  for (let i = firstOpt; i <= fi; i++) {
    if (isNoteRow(texts[i]!)) return null;
  }

  // 3. The live header above the options, and the structural question between them.
  const hq = headerAndQuestion(texts, firstOpt);
  if (!hq) return null;
  const question = hq.question;

  // 4. Build the options. The digit MOVES the pointer and Enter selects (family `select`: probed on
  //    the live dialog — a digit alone never submits). The notes hint is stripped off the last row's
  //    label by exact match; `(Recommended)` stays — it is per-option data.
  const options: PromptOption[] = menu.map((row) => {
    let label = row.label;
    if (label.endsWith(NOTES_HINT_SUFFIX)) label = label.slice(0, -NOTES_HINT_SUFFIX.length);
    return { label, keys: [String(row.n), "Enter"] };
  });

  // The signature runs question → footer: contiguous literal rows the bridge can bind a write to.
  // The header is excluded — its live timer would churn the signature every second and 409 every
  // tap. Same successive-identical tradeoff as the approval grammar (stated on the adapter).
  const signature = regionSignature(texts, hq.questionAt, fi);
  const coreSignature = texts
    .slice(hq.questionAt, fi + 1)
    .map((t) => t.replaceAll("›", " "))
    .join("\n");
  return { model: { question, options, family: "select", signature, coreSignature }, startLine: firstOpt };
}

/**
 * Detect a single-select question at the tail of `lines`, returning just the model (or null). The
 * thin public matcher — used by the race guard to re-derive from a fresh buffer and by tests.
 * buildBlocks uses {@link detectQuestionRegion} for the render boundary.
 */
export function detectQuestion(lines: StyledLine[]): PromptModel | null {
  return detectQuestionRegion(lines)?.model ?? null;
}
