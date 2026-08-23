// Grok `ask_user_question` card — the `┃` gutter questionnaire that replaces the composer.
// Digit N on a radio card was live-probed (ASK_NOTES.md): `2` submitted immediately. Checkbox
// (`[ ]`) cards are a different widget — a digit submits rather than toggles — so this detector
// returns null on them (composerReady is already false: no box). The complete layout is the
// captured one: consecutive 1..n radios, a `z` row, and an inner `Enter:select|submit|edit`
// hint. A card missing any of those, or painting an `a`–`f` option row, is a different widget
// — refuse rather than emit digits. Esc-park keeps the same card; its footer differs and must
// still match. `z` is modelled as `purpose: "free-text"` so a focused row can lock the option
// buttons; Collie does not type into it. Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptFeedback, PromptModel, PromptOption } from "../prompt-model";
import { GUTTER_OPTION, gutterCardRange, lastNonBlankIndex, lineText, regionSignature, rstrip } from "./markers";

export interface AskRegion {
  model: PromptModel;
  startLine: number;
}

const CHECKBOX = /^\s*┃\s+[1-9]\s+\[[ x✔✓]\]/i;
// Official keys include `a`–`f` as answers. Those digits/letters are unprobed, so a card that
// paints one is a different widget — refuse rather than emit 1..n and ignore the extras.
const LETTER_OPTION = /^\s*┃\s+[a-zA-Z]\s+\(([●○])\)/;
// Idle placeholder is the captured English string. Focused is `z (●) ❯` with optional typed text.
const Z_IDLE = /^\s*┃\s+z\s+\(○\)\s+Type your answer here\s*$/i;
const Z_FOCUSED = /^\s*┃\s+z\s+\(●\)\s+❯\s*(.*)$/;
// The card's inner hint row, anchored to its captured shape: an optional wizard step (`[1/2]`),
// the `↑/↓ navigate` legend, then the Enter verb ending the row. An unanchored substring let
// question prose containing "Enter:submit" satisfy the layout gate (review repro) — the hint
// must be the hint ROW, not words inside one. The `edit` verb is the ONE grid-visible tell that
// the keyboard sits on the `z` row: after Esc leaves a focused `z`, the row repaints as idle
// `z (○)` and the global footer says `Tab:next answer` — but a digit still types into the
// free-text field (live-probed 2026-08-22, twice via the guarded send path;
// grok--ask-z-parked.txt). `select`/`submit` mean the cursor is on an option row.
const HINT_ROW = /^\s*┃\s+(?:\[\d+\/\d+\]\s+)?↑\/↓ navigate\b.*Enter:(select|submit|edit)$/i;
// A row shaped like a control — a short key token followed by a mark — that no specific rule
// matched is an unprobed widget row: refuse the whole card rather than lift around it.
const FOREIGN_OPTION = /^\s*┃\s+\S{1,3}\s+[([]/;
const FOOTER_ACTIVE = /Tab:next answer/i;
const FOOTER_PARKED = /Tab\/Space:question/i;
const FOOTER_Z = /Esc:back/i;

function isAskFooter(text: string, hasZFocus: boolean): boolean {
  if (FOOTER_ACTIVE.test(text) || FOOTER_PARKED.test(text)) return true;
  return hasZFocus && FOOTER_Z.test(text);
}

/** ask_user_question radio card at the tail, or null. */
export function detectAskRegion(lines: StyledLine[]): AskRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;

  const card = gutterCardRange(texts, fi);
  if (card === null) return null;
  const start = card.start;

  let firstOption = -1;
  for (let i = card.start; i <= card.end; i++) {
    if (GUTTER_OPTION.test(texts[i]!)) {
      firstOption = i;
      break;
    }
  }
  if (firstOption < 0) return null;

  const options: PromptOption[] = [];
  let question = "";
  let feedback: PromptFeedback | undefined;
  let sawHint = false;
  let editHint = false;
  const seen = new Set<string>();

  for (let i = card.end; i >= card.start; i--) {
    const t = texts[i]!;
    if (CHECKBOX.test(t)) return null;
    if (Z_IDLE.test(t)) {
      feedback = { key: "z", focused: false, text: "", purpose: "free-text" };
      continue;
    }
    const z = Z_FOCUSED.exec(t);
    if (z) {
      feedback = { key: "z", focused: true, text: (z[1] ?? "").trimEnd(), purpose: "free-text" };
      continue;
    }
    if (LETTER_OPTION.test(t)) return null;
    const opt = GUTTER_OPTION.exec(t);
    if (opt) {
      const n = opt[1]!;
      if (seen.has(n)) return null;
      seen.add(n);
      // Grok's own scrollbar column paints a `█` cell at the right edge of long option rows —
      // it is chrome, not the description's last word.
      const raw = opt[3]!.trim().replace(/\s+█$/, "");
      const split = raw.split(/\s{2,}/);
      const label = (split[0] ?? raw).trim();
      const description = split.slice(1).join(" ").trim();
      const option: PromptOption = { label, keys: [n] };
      if (description !== "") option.description = description;
      options.unshift(option);
      continue;
    }
    const hint = HINT_ROW.exec(t);
    if (hint) {
      sawHint = true;
      if (hint[1]!.toLowerCase() === "edit") editHint = true;
      continue;
    }
    if (FOREIGN_OPTION.test(t)) return null;
    const body = t.replace(/^\s*┃\s*/, "").trim();
    if (body === "") continue;
    // Unclassified text is QUESTION only above the first option row — where the captured cards
    // put it. Below the options, an unrecognized non-blank row is an unprobed widget row: refuse.
    if (i > firstOption) return null;
    question = body;
  }

  if (!sawHint) return null;
  if (!feedback) return null;
  if (!isAskFooter(texts[fi]!, feedback.focused)) return null;
  if (question === "" || options.length < 2) return null;
  for (let i = 0; i < options.length; i++) {
    if (options[i]!.keys[0] !== String(i + 1)) return null;
  }
  // `Enter:edit` with an idle-looking z row: the keyboard is parked on the free-text field
  // (Esc from a focused z leaves it there), so a digit would TYPE, not answer. Model it as
  // focused — the renderer locks every option button behind the free-text banner, which is
  // exactly the situation. Live-probed 2026-08-22: digit typed "2" into the field twice via
  // the guarded send path; Up moved off the row and flipped the hint back to Enter:submit.
  if (editHint && !feedback.focused) {
    feedback = { ...feedback, focused: true };
  }

  // Esc-parked card (scrollback view, `Tab/Space:question` footer): a bare digit is silently
  // swallowed — live-probed 2026-08-22 (digit had zero effect; blocked state unchanged). The
  // footer's own named key recovers: Tab re-enters the card, then the digit answers (probed
  // twice — once by QA, once re-verified). The badge keeps showing the digit.
  if (FOOTER_PARKED.test(texts[fi]!)) {
    for (let i = 0; i < options.length; i++) {
      const o = options[i]!;
      options[i] = { ...o, keyLabel: o.keys[0], keys: ["Tab", ...o.keys] };
    }
  }

  const signature = regionSignature(lines, start, fi + 1);
  if (signature === "") return null;

  return {
    // The block replaces the OPTIONS down; the `┃` question rows above stay in the raw mirror.
    // Same contract as Claude's prompt-select: the renderer never repeats the question, so the
    // mirror is where the operator reads what they're answering.
    startLine: firstOption,
    model: {
      question,
      options,
      family: "select",
      feedback,
      coreSignature: question,
      signature,
    },
  };
}
