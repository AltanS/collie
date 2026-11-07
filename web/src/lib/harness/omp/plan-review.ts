// The omp PLAN REVIEW grammar, the fifth omp screen this adapter lifts: the fullscreen overlay omp opens
// when a plan-mode turn finishes its plan (`Plan mode - next step`).
//
// Why it is lifted. Before this grammar the screen stayed raw and drew the unread-dialog card, and it is
// the card's likeliest source on omp 18.16: every plan-mode task ends on it, the agent opens it (not the
// person at the desk), and it waits there until someone answers, so each pane switch or reload on the
// phone mounted the card again (experiments/trouble-dialogs, field data of 2026-11-07).
//
// The screen, as omp 18.16.0 draws it (pi-tui `overlays/plan-review-overlay.ts`, unchanged in 18.18.0;
// `omp--v18-16-0-plan-review--w80.txt`), one box over the whole pane:
//
//     ╭─ Plan Review ───────────────────────────────────────────╮
//     │  Plan: add multiply to calc.py                           │   the plan body, windowed by
//     │  1. In calc.py, after add, insert def multiply(a, b) …   │   a scroll view and padded to
//     │                                                          │   the pane's height
//     ├──────────────────────────────────────────────────────────┤
//     │ Plan mode - next step                                    │   the prompt title
//     │ continue with  ◂  smol  ◀ default ▶  ▸                   │   the model-tier slider, only when
//     │   ↳ Claude Haiku 5.5                                     │   two role models resolve
//     │ ❯ Approve and execute                                    │   the five options, in this order
//     │   Approve and compact context                            │
//     │   Approve and keep context (~20k / 100k)                 │
//     │   Refine plan                                            │
//     │   Save and quit                                          │
//     ├──────────────────────────────────────────────────────────┤
//     │ ↑/↓ select · ⏎ confirm · c copy · ⇥ regions · Ctrl+G editor · ⎋ cancel │
//     ╰──────────────────────────────────────────────────────────╯
//
// A plan with two or more headings on a pane wide enough gets a Contents sidebar: the top border carries
// a `┬` and the divider under the body a `┴` (`omp--v18-16-0-plan-review-contents--w140.txt`). The rows
// from the prompt title down are the same in both layouts.
//
// WHAT ENTER DOES. Enter confirms the pointed option (interactive-mode.ts `#handlePlanReview` in 18.16.0):
// the three `Approve …` rows leave plan mode and run the plan with the tier the slider shows, `Refine
// plan` sends the plan back to the model with the review notes, and `Save and quit` saves the plan and
// leaves plan mode without running it (`#savePlanAndQuit`; omp keeps running). Escape (`⎋ cancel`) closes
// the overlay and stays in plan mode: the transcript prints `Plan ready for review.` and the composer
// returns (captured live 2026-11-07).
//
// WHAT A TAP SENDS. ADR 0055's walk, `pointerWalk(pointedAt, i)`: `Down` or `Up` from the pointed row to
// the tapped row, then `Enter`. The footer names both (`↑/↓ select`, `⏎ confirm`), so this is inside
// ADR 0009's rule. The action layer splits the plan (ADR 0080): the arrows go first, bound to the tapped
// screen, and `Enter` goes only bound to a fresh read that shows the pointer on the tapped row. The arrows
// stop at the list's edges and skip a DISABLED row (`#moveSelection`), so a disabled row would make the
// walk count wrong. omp disables exactly one row, `Approve and keep context`, and only when the session's
// context is above 95 percent of the window, which the row prints as `(~N / M)`. The grammar declines
// from 90 percent up, so the rounding of those two numbers can never hide a disabled row. The last button
// is the footer's way out in its own word, `Cancel`, sending `Escape`.
//
// WHAT THE CARD SHOWS. The five options under omp's own labels, then `Cancel`. The card starts at the
// prompt title: the plan body above it stays in the raw mirror, because the plan is what the person
// decides on. When the slider is up, its selected tier and that tier's model go into the question
// (`continue with: default · Claude Haiku 5.5`): the approve rows run with it, and the card has no way to
// move the slider (the footer's `←/→ model`), so it says which tier a tap uses.
//
// FAIL CLOSED. Every piece below is required, and any one missing returns null, which leaves the raw
// mirror and the unread-dialog card's Escape (omp/modal.ts):
//   * the bottom border is the last non-blank row, and the row above it is the options-focused footer of
//     the `unicode` symbol preset, segment for segment: `↑/↓ select`, `⏎ confirm`, `←/→ model` exactly
//     when the slider is up, an optional `c copy`, `⇥ regions`, an optional `<key> editor`, `⎋ cancel`.
//     So focus on the plan body or the sidebar (their footers name scroll keys and no `⏎ confirm`,
//     `omp--v18-16-0-plan-review-regions--w80.txt`), the annotation editor, the `submitting…` state, a
//     footer omp clipped with `…` (`omp--v18-16-0-plan-review-slider-clipped--w80.txt`), a rebound key and
//     the uncaptured `nerd` and `ascii` presets all decline;
//   * a plain divider above the footer, then exactly the five option rows in omp's order, each the pointer
//     column (`❯ ` or two spaces) and the label; exactly one pointer; a row with any other text (a hovered
//     row's band shifts its label by one space) declines;
//   * above the options, the slider's track row and its optional `↳` detail row when the footer says
//     `←/→ model`, nothing otherwise; then exactly `Plan mode - next step`;
//   * above the title, a divider (`├─┤`, or `├─┴─┤` under a sidebar), then only box rows up to the top
//     border `╭─ Plan Review ─…╮`, which carries a `┬` exactly when that divider carries a `┴`;
//   * the keep-context row below 90 percent, or with no numbers (omp then never disables it);
//   * a region short enough for the bridge to bind (32000 characters, as resume.ts).
//
// THE RACE GUARD. The signature is the whole box verbatim, top border through bottom border, rows
// trimmed of trailing space: the plan as shown, the slider, the pointer and the footer. A plan that
// changed, a scroll, a tier moved at the desk or a pointer moved there all refuse a tap (ADR 0055 point
// 6). The core signature blanks the pointer glyph only: a walk changes nothing else on this screen
// (captured: `omp--v18-16-0-plan-review-moved--w80.txt` and `-slider-moved--w140.txt`, the pointer moved
// and every other row byte for byte the same).
//
// Pure functions over `StyledLine[]`, tail-anchored like every other grammar.

import type { StyledLine } from "../../blocks";
import { MAX_REGION_CHARS } from "../bound-region";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lineText, rstrip } from "./markers";
import { readOmpHintList } from "./modal";

export interface PlanReviewRegion {
  model: PromptModel;
  /** Index of the prompt title row. The plan body above it stays in the raw mirror. */
  startLine: number;
}

const PROMPT_TITLE = "Plan mode - next step";
const TOP = /^╭─ Plan Review ─+(┬─+)?╮$/;
const DIVIDER = /^├─+(┴─+)?┤$/;
const BOTTOM = /^╰─+╯$/;
const BOXED = /^│ ([\s\S]*?)\s*│$/;
const BOX_ROW = /^│[\s\S]*│$/;
const OPTION_ROW = /^│ (?:(❯) | {2})(\S[\s\S]*?)\s*│$/;
const SLIDER_TRACK = /^│ continue with {2}◂ {2}(\S[\s\S]*?) {2}▸\s*│$/;
const SLIDER_DETAIL = /^│ {3}↳ (\S[\s\S]*?)\s*│$/;
/** The tier the slider points at: omp wraps the active segment in `◀ … ▶`. */
const SLIDER_ACTIVE = /◀ (\S[\s\S]*?) ▶/;

/** The keep-context row: omp prints the session's context against the window when it knows it. */
const KEEP_CONTEXT = /^Approve and keep context(?: \(~(\d+(?:\.\d+)?[kmb]?) \/ (\d+(?:\.\d+)?[kmb]?)\))?$/;
/** omp's five options, in the order `#handlePlanReview` builds them (18.16.0, 18.18.0). */
const OPTION_LABELS: readonly RegExp[] = [
  /^Approve and execute$/,
  /^Approve and compact context$/,
  KEEP_CONTEXT,
  /^Refine plan$/,
  /^Save and quit$/,
];
const KEEP_CONTEXT_AT = 2;
/** omp disables the keep-context row above 95 percent; the grammar stops trusting the walk at 90. */
const KEEP_CONTEXT_DECLINE_RATIO = 0.9;

/** The longest plan box the scan walks up through: a 300-row pane is far past any real terminal. */
const MAX_BOX_ROWS = 300;

/** The card shows `❯` on the pointed row, as every other omp lift does. */
const POINTER = "❯";

/** The options-focused footer of the `unicode` preset, read segment by segment (see the header). */
function footerSlider(text: string): { slider: boolean } | null {
  if (readOmpHintList(text) === null) return null;
  const segments = text.split(" · ");
  let i = 0;
  if (segments[i++] !== "↑/↓ select") return null;
  if (segments[i++] !== "⏎ confirm") return null;
  const slider = segments[i] === "←/→ model";
  if (slider) i++;
  if (segments[i] === "c copy") i++;
  if (segments[i++] !== "⇥ regions") return null;
  if (/^\S+ editor$/.test(segments[i] ?? "")) i++;
  if (segments[i++] !== "⎋ cancel") return null;
  return i === segments.length ? { slider } : null;
}

/** `20k`, `1.1m`, `950` as a number. */
function tokenCount(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([kmb]?)$/.exec(text)!;
  const scale = m[2] === "k" ? 1e3 : m[2] === "m" ? 1e6 : m[2] === "b" ? 1e9 : 1;
  return Number(m[1]) * scale;
}

/**
 * Detect omp's plan review at the tail of `lines`. Returns a `prompt-select` model of the five options
 * plus the footer's way out, and the index of the prompt title row; null when any piece of evidence is
 * missing.
 */
export function detectPlanReviewRegion(lines: StyledLine[]): PlanReviewRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The tail: bottom border, the options-focused footer, a plain divider.
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 0 || !BOTTOM.test(texts[end]!)) return null;
  const footerText = BOXED.exec(texts[end - 1] ?? "")?.[1];
  if (footerText === undefined) return null;
  const footer = footerSlider(footerText);
  if (footer === null) return null;
  if (!/^├─+┤$/.test(texts[end - 2] ?? "")) return null;

  // 2. The five options, bottom up.
  const firstOption = end - 2 - OPTION_LABELS.length;
  if (firstOption < 0) return null;
  let pointedAt = -1;
  const labels: string[] = [];
  for (let i = 0; i < OPTION_LABELS.length; i++) {
    const row = OPTION_ROW.exec(texts[firstOption + i]!);
    if (row === null) return null;
    const label = row[2]!;
    if (!OPTION_LABELS[i]!.test(label)) return null;
    if (row[1] !== undefined) {
      if (pointedAt >= 0) return null;
      pointedAt = i;
    }
    labels.push(label);
  }
  if (pointedAt < 0) return null;
  const keep = KEEP_CONTEXT.exec(labels[KEEP_CONTEXT_AT]!);
  if (keep === null) return null;
  if (keep[1] !== undefined) {
    const window = tokenCount(keep[2]!);
    if (window <= 0 || tokenCount(keep[1]) / window >= KEEP_CONTEXT_DECLINE_RATIO) return null;
  }

  // 3. The slider rows, exactly when the footer names `←/→ model`, then the prompt title.
  let at = firstOption - 1;
  let tier: string | null = null;
  if (footer.slider) {
    let detail: string | null = null;
    const detailRow = SLIDER_DETAIL.exec(texts[at] ?? "");
    if (detailRow !== null) {
      detail = detailRow[1]!;
      at--;
    }
    const track = SLIDER_TRACK.exec(texts[at] ?? "");
    if (track === null) return null;
    const active = SLIDER_ACTIVE.exec(track[1]!);
    if (active === null) return null;
    tier = detail === null ? active[1]! : `${active[1]!} · ${detail}`;
    at--;
  }
  const titleAt = at;
  if (BOXED.exec(texts[titleAt] ?? "")?.[1] !== PROMPT_TITLE) return null;

  // 4. The divider over the title, the plan body's box rows, and the top border.
  const divider = DIVIDER.exec(texts[titleAt - 1] ?? "");
  if (divider === null) return null;
  let topAt = -1;
  for (let i = titleAt - 2, seen = 0; i >= 0 && seen < MAX_BOX_ROWS; i--, seen++) {
    const text = texts[i]!;
    const top = TOP.exec(text);
    if (top !== null) {
      // The sidebar splits the top border and the divider under the body alike.
      if ((top[1] !== undefined) !== (divider[1] !== undefined)) return null;
      topAt = i;
      break;
    }
    if (!BOX_ROW.test(text)) return null;
  }
  if (topAt < 0) return null;

  // 5. The options: the walk to each row, then the footer's way out.
  const options: PromptOption[] = labels.map((label, i) => ({
    label,
    keys: pointerWalk(pointedAt, i),
    // The footer names the arrows, not a row key, so the pointed row shows the pointer and every
    // other row shows no badge, as resume.ts, ask.ts and switch.ts do.
    keyLabel: i === pointedAt ? POINTER : "",
  }));
  options.push({ label: "Cancel", keys: ["Escape"], keyLabel: "Esc" });

  // 6. The signature: the whole box verbatim. The core blanks the pointer glyph, the one thing a walk
  //    changes here.
  const region = texts.slice(topAt, end + 1);
  const signature = region.join("\n");
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedRow = firstOption + pointedAt - topAt;
  const coreSignature = region.map((row, i) => (i === pointedRow ? row.replace(POINTER, " ") : row)).join("\n");

  const model: PromptModel = {
    question: tier === null ? PROMPT_TITLE : `${PROMPT_TITLE}\ncontinue with: ${tier}`,
    options,
    family: "plan",
    signature,
    coreSignature,
  };
  return { model, startLine: titleAt };
}

/** The model alone (or null), the thin matcher tests assert on. */
export function detectPlanReview(lines: StyledLine[]): PromptModel | null {
  return detectPlanReviewRegion(lines)?.model ?? null;
}
