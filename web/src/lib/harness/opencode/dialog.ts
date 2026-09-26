// The opencode permission dialog — the Tier-2 lift. opencode asks for tool permission with one
// dialog, painted INSIDE the composer's bar run:
//
//     ┃  △ Permission required
//     ┃
//     ┃  $ echo fixture-corpus-probe              <- the subject: `$ <command>` / `→ Edit <file>`
//     ┃                                           <- (an edit dialog paints its diff rows here)
//     ┃   Allow once   Always allow   Reject  ctrl+f fullscreen  ⇆ select  enter confirm
//     <cwd>                                       <- the status row, below
//
// The options are not numbered rows. They are CHIPS on the footer row, the pointer is a
// BACKGROUND-COLOUR chip on exactly one of them (theme values — parsed by RELATIVE style, never by
// colour name), and the footer names its own recipe: `⇆ select  enter confirm`. Measured live
// against opencode 2.0.8 (sandbox pane, 2026-09-20): Left/Right move the pointer, Tab does NOT
// (probed — it was observed to leave the chip where it was; the ⇆ hint means the arrow pair), Enter
// confirms, and Right at the last option wraps to the first (probed on the bash dialog).
//
// The lifted model carries `keys` computed from the pointer the screen currently shows: the option
// at the pointer is `["Enter"]`, one at offset d is `["Right" × d, "Enter"]` — d ≤ options-1, so
// every key is a single herdr-sendable step and no digit is ever synthesised (.adr/0009). A
// derivation that cannot see exactly one pointer chip answers null and the dialog stays on the raw
// mirror — the fail-closed contract.

import type { StyledLine } from "../../blocks";
import type { PromptModel, PromptOption } from "../prompt-model";
import {
  barDraftText,
  hasFooterHints,
  isBlank,
  isPermissionTitle,
  lineText,
  rstrip,
} from "./markers";
// How far above the option row the title may sit. The dialog paints blanks between its subject and
// the options (nine in the edit capture — the box interior is padded tall), so the bound is generous
// but bounded; a title further than this is not this dialog's title.
const MAX_TITLE_GAP = 16;

/** The detected dialog: the model plus `startLine`, the first row the block REPLACES (the option
 *  footer; the title and subject above stay on the mirror). */
export interface DialogRegion {
  model: PromptModel;
  startLine: number;
}

/** Whether a footer token names an affordance hint rather than a selectable option. The hints are
 *  `<key> <verb>` pairs the dialog painted (a chord, ⇆, enter, esc); the options' labels never open
 *  with one of those key tokens. Content-shaped ON PURPOSE — it is how the footer separates its own
 *  buttons from its own instructions — and it only ever SHRINKS the option list. */
function isHintToken(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith("ctrl+") || t.startsWith("⇆") || t.startsWith("enter ") || t.startsWith("esc") ||
    t.startsWith("shift+")
  );
}

/** The draft text an interior row carries (bar + gutter stripped), trimmed. A bare-bar row (the
 *  box's interior padding) carries NO text — the bar itself is chrome, never content. */
function interiorText(text: string): string {
  const inner = barDraftText(text);
  if (inner !== null) return inner.trim();
  const bare = /^\s*┃([\s\S]*)$/.exec(text);
  return (bare === null ? text : bare[1]!).trim();
}

/**
 * Detect a permission dialog at the tail of `lines`, or null. Pure.
 */
export function detectPermissionDialog(lines: StyledLine[]): DialogRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The footer anchor: the last row carrying the dialog's own select+confirm hints. It is not
  //    necessarily the buffer's last non-blank row — a bare-bar padding row and the status row sit
  //    below it (measured on both widths) — so the anchor scans up from the tail, bounded, and the
  //    dialog's own tail may carry at most TWO non-blank rows beneath the footer. Ordinary output
  //    appended below (a dialog that scrolled up) pushes the footer out of that window and the
  //    lift refuses — the tail anchor, in non-blank-row terms.
  let footer = -1;
  let nonBlankBelow = 0;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (isBlank(texts[i]!)) continue;
    if (hasFooterHints(texts[i]!)) {
      footer = i;
      break;
    }
    nonBlankBelow++;
    if (nonBlankBelow > 2) return null;
  }
  if (footer < 0) return null;

  // 2. The option row: at wide widths the hints share the chip row (the footer row itself); at
  //    narrow widths the chips sit on the bar row above the hint row, one blank between. Try the
  //    footer first, then the bounded rows above it.
  let optionRow = -1;
  let options: PromptOption[] | null = null;
  for (let i = footer; i >= 0 && footer - i <= 3; i--) {
    const parsed = parseOptionChips(lines[i]!);
    if (parsed !== null) {
      options = parsed;
      optionRow = i;
      break;
    }
  }
  if (options === null || optionRow < 0) return null;

  // 4. The title row — the nearest `△ Permission required` above the options, within the gap bound.
  //    The lift refuses without it: it is the row that says this is opencode's permission dialog.
  let titleRow = -1;
  for (let i = optionRow - 1; i >= 0 && optionRow - i <= MAX_TITLE_GAP; i--) {
    if (isPermissionTitle(texts[i]!)) {
      titleRow = i;
      break;
    }
  }
  if (titleRow < 0) return null;

  // 4. The subject: the first interior row UNDER the title that carries text — `$ echo …` or
  //    `→ Edit …`. The box pads its interior with bare-bar rows, which are chrome, not content:
  //    a row whose interior is empty does not stop the search.
  let subject = "";
  for (let i = titleRow + 1; i < optionRow; i++) {
    if (isBlank(texts[i]!)) continue;
    subject = interiorText(texts[i]!);
    if (subject.length > 0) break;
  }
  if (subject.length === 0) return null;

  // The dialog's own rows are static while it is up: the spinner and the running-command rows sit
  // ABOVE the title (measured), so the region text neither churns with the spinner frame nor moves
  // with the pointer (the chip changes the pointer option's STYLE, never the row's text). One
  // byte-faithful signature serves both the guard and the bridge binding; it ends at the footer,
  // the buffer's last non-blank row, inside the bridge's tail window.
  const signature = texts.slice(titleRow, footer + 1).join("\n");
  const model: PromptModel = {
    question: subject,
    options,
    family: "permission",
    signature,
    coreSignature: signature,
  };
  return { model, startLine: optionRow };
}

/**
 * Parse the option chips off a styled footer row, computing each option's keystroke plan from the
 * pointer the screen currently shows. Returns null unless exactly one pointer chip is found among
 * at least one non-hint option token — the fail-closed contract.
 */
function parseOptionChips(line: StyledLine): PromptOption[] | null {
  // 1. Tokenize the row's flat text by 2+ spaces, remembering each token's [start, end) span.
  const full = rstrip(lineText(line));
  const tokens: { text: string; start: number; end: number }[] = [];
  const gap = / {2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = gap.exec(full)) !== null) {
    if (m.index > last) tokens.push({ text: full.slice(last, m.index), start: last, end: m.index });
    last = m.index + m[0].length;
  }
  if (last < full.length) tokens.push({ text: full.slice(last), start: last, end: full.length });

  // 2. The hints sit at the row's END when they share the option row (wide); at narrow widths the
  //    hint row carries no chips and the bar row above arrives here instead — chips only. The
  //    options are the leading tokens before the first hint-shaped token.
  //
  //    The row's leading bar is the composer's own left edge, not an option — it rides the row as
  //    its own token (the pad runs after it), and its style is unlike any chip's. Drop it FIRST so
  //    the hint index below indexes the same array the options slice reads.
  while (tokens[0] !== undefined && tokens[0].text.trim() === "┃") tokens.shift();
  let hintStart = tokens.length;
  for (let i = 0; i < tokens.length; i++) {
    if (isHintToken(tokens[i]!.text)) {
      hintStart = i;
      break;
    }
  }
  const optionTokens = tokens.slice(0, hintStart).filter((t) => t.text.length > 0);
  if (optionTokens.length === 0) return null;

  // 3. The pointer: the one option token whose background differs from the PLURALITY of the chips.
  //    The chips are painted uniformly otherwise, so a pointer on any option — the first included —
  //    is the single token off the base. Two differing tokens mean we cannot tell the pointer —
  //    refuse the dialog rather than guess which row a tap would confirm.
  type SegmentStyle = { fg: string | undefined; bg: string | undefined };
  const styleAt = (start: number, end: number): SegmentStyle => {
    let at = 0;
    let fg: string | undefined;
    let bg: string | undefined;
    for (const seg of line.segments) {
      const from = Math.max(at, start);
      const to = Math.min(at + seg.text.length, end);
      if (to > from && seg.text.trim().length > 0) {
        fg ??= seg.fg;
        bg ??= seg.bg;
      }
      at += seg.text.length;
      if (at >= end) break;
    }
    return { fg, bg };
  };

  const bgOf = optionTokens.map((t) => styleAt(t.start, t.end).bg);
  const counts = new Map<string, number>();
  for (const bg of bgOf) counts.set(bg ?? "", (counts.get(bg ?? "") ?? 0) + 1);
  let baseBg: string | undefined;
  let max = 0;
  let tie = false;
  for (const [bg, count] of counts) {
    if (count > max) {
      max = count;
      baseBg = bg === "" ? undefined : bg;
      tie = false;
    } else if (count === max) {
      tie = true;
    }
  }
  if (max < 1 || tie || optionTokens.length < 2) return null;
  let pointer = -1;
  for (let i = 0; i < optionTokens.length; i++) {
    if (bgOf[i] !== baseBg) {
      if (pointer >= 0) return null;
      pointer = i;
    }
  }
  if (pointer < 0) return null;

  // 4. Keys: forward offset from the current pointer (with wrap, probed), then Enter.
  const out: PromptOption[] = [];
  for (let i = 0; i < optionTokens.length; i++) {
    const offset = (i - pointer + optionTokens.length) % optionTokens.length;
    const keys: string[] = [];
    for (let k = 0; k < offset; k++) keys.push("Right");
    keys.push("Enter");
    out.push({ label: optionTokens[i]!.text, keys });
  }
  return out;
}
