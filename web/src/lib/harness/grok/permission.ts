// Grok Build permission card — the `┃` gutter dialog that replaces the composer when a tool
// needs approval. The card's option count varies by tool class (rm asked with three rows, file
// edits with four — both live-probed, PERMISSION_NOTES.md), so the gate is classification, not
// a pinned layout: the footer must name this card family and count its rows, the last row must
// be the reject, the row above it the one-shot Yes, and every earlier row must PROVE it is a
// persistent mode change by its label — those are never buttons. A row that fits no class
// refuses the whole card (fail-closed null). Digit N confirms row N immediately; probed on
// both layouts. Pure; no pane access.

import type { StyledLine } from "../../blocks";
import type { PromptModel } from "../prompt-model";
import { GUTTER_OPTION, gutterCardRange, lastNonBlankIndex, lineText, regionSignature, rstrip } from "./markers";

export interface PermissionRegion {
  model: PromptModel;
  startLine: number;
}

const FOOTER_COUNT = /(?:^|\s)1\/([1-9]):select/;
const FOOTER_TAB = /Tab:next option/i;
const FOOTER_ALWAYS = /Ctrl\+o:always-approve/i;
const FOOTER_CANCEL = /Ctrl\+c:cancel/i;

// A row above the Yes/No pair may only be a persistent mode change, recognised by its label.
// Two probed shapes: global always-approve ("…don't ask again for anything (always-approve
// mode)") and the session-scoped variant ("Yes, allow all edits during this session"). An
// upper row matching neither has semantics we haven't probed — refuse the card.
const PERSISTENT = /always-approve|don['’]t ask again|this session/i;
const YES_ROW = /^yes\b/i;
const NO_ROW = /^no, reject\b/i;
const FOREIGN_OPTION = /^\s*┃\s+\S{1,3}\s+[([]/;

/** Trailing parenthetical stripped for the button face — "No, reject (type to add feedback)"
 *  renders as "No, reject"; a label without one is unchanged. */
function buttonLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Permission card at the tail, or null. */
export function detectPermissionRegion(lines: StyledLine[]): PermissionRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));
  const fi = lastNonBlankIndex(texts);
  if (fi < 0) return null;
  const footer = texts[fi]!;
  const count = FOOTER_COUNT.exec(footer);
  if (count === null) return null;
  if (!FOOTER_TAB.test(footer) || !FOOTER_ALWAYS.test(footer) || !FOOTER_CANCEL.test(footer)) {
    return null;
  }

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

  // Visual order, not a Map: a duplicate digit would otherwise last-write-win and a
  // shuffled card would still look like a probed 1..n layout.
  const ordered: { digit: string; label: string }[] = [];
  let question = "";
  for (let i = card.end; i >= card.start; i--) {
    const t = texts[i]!;
    const opt = GUTTER_OPTION.exec(t);
    if (opt) {
      ordered.unshift({ digit: opt[1]!, label: opt[3]!.trim() });
      continue;
    }
    // A row shaped like a control — a short key token followed by a mark — that GUTTER_OPTION
    // did not match is an unprobed widget row (letter key, checkbox, multi-digit): refuse the
    // whole card rather than lift around it.
    if (FOREIGN_OPTION.test(t)) return null;
    const body = t.replace(/^\s*┃\s*/, "").trim();
    if (body === "") continue;
    // Unclassified text is QUESTION only above the first option row — where the captured cards
    // put the title and command. Below the options it is an unprobed row: refuse.
    if (i > firstOption) return null;
    question = body;
  }

  // The footer's own row count is the cross-check: a torn frame that lost an option row (or
  // gained a stray one) disagrees with `1/N:select` and refuses. Minimum three rows: the footer
  // advertises Ctrl+o:always-approve, so a card without a persistent row above the Yes/No pair
  // contradicts its own footer — every capture has at least one.
  const n = ordered.length;
  if (question === "" || n < 3 || n !== Number(count[1]!)) return null;
  for (let i = 0; i < n; i++) {
    if (ordered[i]!.digit !== String(i + 1)) return null;
  }

  const yes = ordered[n - 2]!;
  const no = ordered[n - 1]!;
  if (!NO_ROW.test(no.label)) return null;
  if (!YES_ROW.test(yes.label) || PERSISTENT.test(yes.label)) return null;
  for (let i = 0; i < n - 2; i++) {
    if (!PERSISTENT.test(ordered[i]!.label)) return null;
  }

  const signature = regionSignature(lines, start, fi + 1);
  if (signature === "") return null;

  return {
    // The block replaces the OPTIONS down; the `┃` question rows above stay in the raw mirror.
    // Same contract as Claude's prompt-select: the renderer never repeats the question, so the
    // mirror is where the operator reads what they're approving.
    startLine: firstOption,
    model: {
      question,
      options: [
        { label: buttonLabel(yes.label), keys: [yes.digit] },
        { label: buttonLabel(no.label), keys: [no.digit] },
      ],
      family: "permission",
      coreSignature: question,
      signature,
    },
  };
}
