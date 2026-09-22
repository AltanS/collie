// The EFFORT SLIDER grammar — the one Claude screen the generic menu can see but cannot read.
//
// `/effort` paints a modal with no options and no highlight: a full-width rule, the title `Effort`,
// a `───` scale carrying a single `▲` marker, a row of labels under it, and the key-hint footer
//
//     ←/→ to adjust · Enter to confirm · s for this session only · Esc to cancel
//
// The generic grammar (menu.ts) claims this screen and gets two of its four affordances right. It
// misses the other two, and neither miss is fixable there:
//
//   * THE VALUE. `MENU_ARROW_ROW` is scanned across the region's rows only, strictly ABOVE the
//     footer — and here the `←/→` phrase IS the footer, so the generic detector finds no arrow row
//     and `nav.leftRight` stays undefined, i.e. no Left/Right buttons at all. Applying
//     MENU_ARROW_ROW to the footer line instead would be worse than nothing: it matches, with an
//     EMPTY value and a "verb" that is the whole rest of the footer. The value on this screen is not
//     written in words anywhere; it is the COLUMN of the `▲` against the label row. Reading a
//     position is a Claude-specific act, so it belongs in a Claude-specific detector (ADR 0053).
//   * THE `s` KEY. `parseKeyHintFooter` needs the literal word `to` between key and verb, and this
//     screen writes `s for this session only`. Widening that shared grammar to accept `for` would
//     loosen every adapter's footer parsing for one screen's wording, so the segment is read here.
//
// Everything else is inherited: this detector emits the SAME `MenuModel`, so it renders through
// `MenuBlock` with no new component, and it takes the identity comparator and the race guard as they
// stand. That pairing is what makes the arrows safe — `menusSameIdentity` deliberately ignores
// `nav.leftRight.label` (menu-model.ts:72-86), so a tap that moves the `▲` is the expected outcome
// rather than a stale-screen abort, while `menusEqual` folds in the signature, so a marker that
// moved under the operator still aborts a COMMITTING key.
//
// POSITION-INDEPENDENT BY CONSTRUCTION. Nothing below names a column number, a pane width or a label
// set: the marker row is found by its glyph, the label row by adjacency, and the value by nearest
// label centre. Two captures of this screen at different widths are in the corpus for exactly that
// reason.
//
// NO DIGITS, and nothing the screen did not print (.adr/0009): the emitted keys are `Enter`, `s` and
// `Escape`, all three named in the footer, plus the `Left`/`Right` the footer advertises with `←/→`.
// The operator reaches `low` from `xhigh` by tapping Left, never by Collie typing a key that means
// "jump to low".
//
// Pure functions over `StyledLine[]`, tail-anchored like every other Claude grammar.

import type { StyledLine } from "../../blocks";
import { displayWidth } from "../../text-width";
import { hasInputBox } from "./chrome";
import { isBlank, isBoxBorder, isHorizontalRule, lineText } from "./markers";
import type { MenuRegion } from "./menu";
import { regionSignature } from "./prompt-select";
import type { MenuAction, MenuModel } from "../menu-model";
import { capitaliseMenuLabel, menuKeyFor, parseKeyHintFooter } from "../menu-hints";

// The slider's marker. Deliberately NOT a member of the rule-glyph family (markers.ts), so the scale
// row it sits in is not mistaken for the region's opening rule.
const MARKER = "▲";

// The footer's own advertisement of the arrows, and the verb it gives them. Matched against the
// FOOTER because that is where this screen prints it — never against a region row, and never with
// `MENU_ARROW_ROW`, whose group 1 (the value) is empty here and whose group 2 would swallow the rest
// of the footer.
const FOOTER_ARROWS = /←\/→\s+to\s+(\w+)/;

// The one footer segment `parseKeyHintFooter` cannot take: "<key> for <verb phrase>", which this
// screen writes instead of "<key> to <verb phrase>". Read here rather than widening the shared
// grammar for one screen's wording.
const FOR_SEGMENT = /^(\S+)\s+for\s+(.+)$/;

// The footer's segment separator, the same middle-dot-with-spaces menu-hints.ts splits on. Kept local
// rather than exported from there: this file reads ONE segment shape that the shared parser
// deliberately refuses, so it does not share that parser's grammar.
const SEGMENT_SPLIT = /\s+·\s+/;

// How far the nearest label centre must beat the second-nearest by, in display cells, before the
// value is reported at all. One cell: the read is a position, and a position that cannot pick a side
// has not read anything. Measured 2026-09-21, the margin is 8.5 cells on the 82-column capture
// (`xhigh` at 0.5 against `high` at 9) and 8 cells on the 120-column one (`high` at 1 against
// `medium` at 9), so a real layout clears this eight times over.
const MIN_VALUE_MARGIN = 1;

// How far above the footer to look for the region's opening rule — the same window menu.ts uses, for
// the same reason: generous enough for a tall modal, bounded so a borderless buffer can't be claimed.
const REGION_SCAN_WINDOW = 30;

/** One label on the slider's label row: its text and its CENTRE, in display cells. */
interface LabelSpan {
  text: string;
  centre: number;
}

// A label carries a word. Observed at narrow pane widths (60 and below, 2026-09-21): Claude lays the
// slider out as a flex row, so under about 86 columns the scale ITSELF wraps and the row directly
// under the marker is the scale's continuation — more rule glyphs — with the real labels a row
// further down, themselves broken mid-word. Requiring a letter or a digit in every label is what
// keeps a continuation row from being read as labels and a rule glyph from being reported as the
// operator's current effort. A wrapped slider is declined outright; the generic menu still gives it
// Confirm and Cancel.
const LABEL_WORD = /[\p{L}\p{N}]/u;

/** The label spans of a row, left to right — every run of non-space, measured in display cells so a
 *  wide glyph counts as the two columns the terminal drew it in. */
function labelSpans(text: string): LabelSpan[] {
  const spans: LabelSpan[] = [];
  const run = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = run.exec(text)) !== null) {
    const start = displayWidth(text.slice(0, m.index));
    spans.push({ text: m[0], centre: start + displayWidth(m[0]) / 2 });
  }
  return spans;
}

/**
 * Detect the `/effort` slider at the tail of `lines`. Returns the model + the index of the region's
 * opening rule, or null.
 *
 * Ordered bails, cheapest and most decisive first:
 *   1. the last non-blank line parses as a key-hint footer AND advertises `←/→` with a verb — this
 *      is the screen's own claim that the arrows do something, and no other capture in the corpus
 *      makes it from its footer;
 *   2. there must be NO input box at the tail, for the reason menu.ts:79 has the same bail: fake
 *      buttons under a live composer are worse than no buttons;
 *   3. exactly one row of the region carries exactly one `▲`, and the FIRST non-blank row beneath it
 *      splits into two or more labels, each carrying a word. First row, not any row: the row under
 *      the labels is a DESCRIPTION line ("xhigh + workflows"), and a detector that took every row
 *      would try to read it as labels too. Each carrying a word, because on a pane too narrow for
 *      the slider the row under the marker is the scale's own wrapped continuation;
 *   4. the region's opening rule / border is found the way menu.ts:84-89 finds it, and the first
 *      non-blank row under it is the title;
 *   5. the marker picks ONE label clearly — the nearest label centre beats the second-nearest by at
 *      least a display cell. A near-tie is not a value, it is a different layout.
 *
 * Pure; the caller owns pane access.
 */
export function detectEffortRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);

  let fi = texts.length - 1;
  while (fi >= 0 && isBlank(texts[fi]!)) fi--;
  if (fi < 0) return null;

  const footer = texts[fi]!;
  const arrows = FOOTER_ARROWS.exec(footer);
  if (arrows === null) return null;
  const footerActions = parseKeyHintFooter(footer);
  if (footerActions.length === 0) return null;
  if (hasInputBox(lines)) return null;

  // One upward pass: the region's top is the nearest rule/border above the footer, and the marker
  // rows are the rows between the two. Collecting both together is what makes "within the region"
  // mean the region and not a window.
  let top = -1;
  const markerRows: number[] = [];
  for (let i = fi - 1, seen = 0; i >= 0 && seen < REGION_SCAN_WINDOW; i--, seen++) {
    const t = texts[i]!;
    if (isBoxBorder(t) || isHorizontalRule(t)) {
      top = i;
      break;
    }
    if (t.includes(MARKER)) markerRows.push(i);
  }
  if (top < 0) return null;
  if (markerRows.length !== 1) return null;

  const markerRow = texts[markerRows[0]!]!;
  const markerAt = markerRow.indexOf(MARKER);
  if (markerRow.indexOf(MARKER, markerAt + 1) !== -1) return null;
  const markerColumn = displayWidth(markerRow.slice(0, markerAt));

  // The label row: the first non-blank row under the marker, still inside the region.
  let labels: LabelSpan[] = [];
  for (let i = markerRows[0]! + 1; i < fi; i++) {
    if (isBlank(texts[i]!)) continue;
    labels = labelSpans(texts[i]!);
    break;
  }
  if (labels.length < 2) return null;
  if (!labels.every((span) => LABEL_WORD.test(span.text))) return null;

  // Title = the first non-blank line under the rule, exactly as the generic grammar names a menu.
  let title = "";
  for (let i = top + 1; i < fi; i++) {
    if (!isBlank(texts[i]!)) {
      title = texts[i]!.trim();
      break;
    }
  }
  if (title === "") return null;

  // THE VALUE: the label whose centre is nearest the marker's column. Never a column constant, never
  // a label list — on the 82-column capture the marker sits at column 40 and `xhigh` is centred at
  // 40.5, against a next-nearest (`high`) at 31, so the read has a margin of 8.5 cells.
  //
  // AND THE MARGIN IS PART OF THE READ. The nearest centre must beat the second-nearest by at least
  // one display cell. A near-tie says the marker is standing between two labels, which the layout we
  // measured never does — so it is evidence that this is not that layout, and the honest answer is to
  // decline. Guessing here would put a level on the Left/Right buttons that the screen never showed.
  const byDistance = labels
    .map((span) => ({ span, distance: Math.abs(span.centre - markerColumn) }))
    .toSorted((a, b) => a.distance - b.distance);
  const [nearest, runnerUp] = byDistance;
  if (runnerUp!.distance - nearest!.distance < MIN_VALUE_MARGIN) return null;
  const value = nearest!.span;

  return {
    model: {
      title,
      actions: withSessionAction(footerActions, footer),
      // THE SCALE, in row order. `labels` is the FIRST non-blank row under the marker and nothing
      // else: the row beneath it is a DESCRIPTION line ("xhigh + workflows") and stays ignored, so
      // `values` is exactly the one row the screen printed the scale on. `value.text` is one of
      // these by construction — it is the span this list was picked from.
      nav: {
        upDown: false,
        leftRight: { verb: arrows[1]!, label: value.text, values: labels.map((s) => s.text) },
      },
      // The same helper, the same bounds as menu.ts:116 — so the marker row is inside the signature
      // and an arrow tap changes it, which is what `menusEqual` needs to abort a stale confirm.
      signature: regionSignature(texts, top, fi),
    },
    startLine: top,
  };
}

/** The footer's actions with its "<key> for <verb phrase>" segment folded in, ahead of the cancel
 *  action so the two committing keys sit together. A footer without such a segment is returned
 *  unchanged: the screen named two keys and we emit two, rather than inventing a third. */
function withSessionAction(actions: MenuAction[], footer: string): MenuAction[] {
  let extra: MenuAction | null = null;
  for (const segment of footer.trim().split(SEGMENT_SPLIT)) {
    const m = FOR_SEGMENT.exec(segment.trim());
    if (m === null) continue;
    const key = menuKeyFor(m[1]!);
    if (key === null) continue;
    extra = { label: capitaliseMenuLabel(m[2]!), keys: [key] };
    break;
  }
  if (extra === null) return actions;
  const cancelAt = actions.findIndex((a) => a.cancel === true);
  if (cancelAt < 0) return [...actions, extra];
  return [...actions.slice(0, cancelAt), extra, ...actions.slice(cancelAt)];
}

/** Detect the `/effort` slider at the tail of `lines`, returning just the model (or null) — the thin
 *  matcher the race guard re-derives with, and the one tests assert on. */
export function detectEffort(lines: StyledLine[]): MenuModel | null {
  return detectEffortRegion(lines)?.model ?? null;
}
