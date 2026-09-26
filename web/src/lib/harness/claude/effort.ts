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
// label centre. Six captures of this screen, from 40 to 132 columns, are in the corpus for exactly
// that reason.
//
// AND WIDTH-INDEPENDENT SINCE 2026-09-22. Below about 70 columns Claude Code wraps this dialog three
// ways at once: each label word breaks onto a second row IN ITS OWN COLUMN, the track splits over two
// rows with the `▲` on the first, and the footer runs over two or three rows. None of that is a
// different screen, so none of it is a different grammar: the footer is read as the rows the
// terminal wrapped it onto (`readKeyHintFooter`, menu-hints.ts, shared), the track's second row is
// stepped over by its glyphs, and each label is rebuilt from its head and the fragment aligned under
// it. The alignment is the whole test — a fragment that does not start on a head's own start column
// refuses the row — and a merge that makes anything but letters and digits declines the screen.
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
import { isBlank, lineText } from "./markers";
import { SEGMENT_SPLIT } from "../menu-hints";
import type { MenuRegion } from "./menu";
import { regionSignature } from "./prompt-select";
import { MODAL_EDGE_WINDOW, regionTopAt } from "./region-top";
import type { MenuAction, MenuModel } from "../menu-model";
import { capitaliseMenuLabel, menuKeyFor, readKeyHintFooter } from "../menu-hints";

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

// How far the nearest label centre must beat the second-nearest by, in display cells, before the
// value is reported at all. One cell: the read is a position, and a position that cannot pick a side
// has not read anything. Measured 2026-09-21, the margin is 8.5 cells on the 82-column capture
// (`xhigh` at 0.5 against `high` at 9) and 8 cells on the 120-column one (`high` at 1 against
// `medium` at 9), so a real layout clears this eight times over.
const MIN_VALUE_MARGIN = 1;

/** One label on the slider's label row: its text, its CENTRE in display cells — what the marker is
 *  measured against — and its START column, which is what a wrapped fragment on the row below must
 *  match exactly to belong to it. */
interface LabelSpan {
  text: string;
  centre: number;
  start: number;
}

// A label carries a word. Claude lays the slider out as a flex row, so below about 70 columns the
// scale ITSELF wraps and the row directly under the marker is the scale's continuation — more rule
// glyphs. Requiring a letter or a digit in every label keeps a rule glyph from ever being reported
// as the operator's current effort, and it stays the guard of last resort now that the track row is
// also stepped over by name (TRACK_ONLY below).
const LABEL_WORD = /[\p{L}\p{N}]/u;

// The slider's TRACK: the glyphs Claude draws the scale's rule with, and nothing else. On a pane too
// narrow for the whole scale the track wraps, and its second row sits BETWEEN the marker row and the
// labels. Naming those glyphs does two jobs: the label search steps over that row instead of reading
// `──┆` as labels, and the upward region scan does not mistake it for the dialog's own opening rule
// (it is one, lexically — `isHorizontalRule` compacts the interior spaces away).
const TRACK_ONLY = /^[\u2500\u2506\s]+$/;

// A MERGED label must be LETTERS AND DIGITS, nothing else. Rebuilding a label from its head and the
// fragment under it is a guess about layout, and this is where the guess is checked. Punctuation is
// excluded on purpose rather than for tidiness: `+` is exactly what the description row
// ("xhigh + workflows") would contribute if its columns ever lined up with the heads, and no level
// Claude prints carries a `+` or a `-`. This is a SHAPE test, not a vocabulary one — the grammar
// still names no level anywhere.
const MERGED_LABEL = /^[\p{L}\p{N}]+$/u;

/** The label spans of a row, left to right — every run of non-space, measured in display cells so a
 *  wide glyph counts as the two columns the terminal drew it in. */
function labelSpans(text: string): LabelSpan[] {
  const spans: LabelSpan[] = [];
  const run = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = run.exec(text)) !== null) {
    const start = displayWidth(text.slice(0, m.index));
    spans.push({ text: m[0], centre: start + displayWidth(m[0]) / 2, start });
  }
  return spans;
}

/**
 * Detect the `/effort` slider at the tail of `lines`. Returns the model + the index of the region's
 * opening rule, or null.
 *
 * Ordered bails, cheapest and most decisive first:
 *   1. the tail's key-hint footer — its last one to three rows, joined (menu-hints.ts) — parses AND
 *      advertises `←/→` with a verb. This is the screen's own claim that the arrows do something,
 *      and no other capture in the corpus makes it from its footer;
 *   2. there must be NO input box at the tail, for the reason menu.ts:79 has the same bail: fake
 *      buttons under a live composer are worse than no buttons;
 *   3. exactly one row of the region carries exactly one `▲`, and the first row beneath it that is
 *      neither blank nor the track's own wrapped continuation splits into two or more labels, each
 *      carrying a word. First row, not any row: the row under the labels is a DESCRIPTION line
 *      ("xhigh + workflows"), and a detector that took every row would try to read it as labels too;
 *   4. the region's opening rule, border or `▔` edge is found the way menu.ts finds it
 *      (region-top.ts), and the first non-blank row under it is the title;
 *   5. the marker picks ONE label clearly — the nearest label centre beats the second-nearest by at
 *      least a display cell. A near-tie is not a value, it is a different layout.
 *
 * Pure; the caller owns pane access.
 */
export function detectEffortRegion(lines: StyledLine[]): MenuRegion | null {
  const texts = lines.map(lineText);

  // The footer, read as the one OR MORE rows the terminal wrapped it onto (menu-hints.ts). Below
  // about 70 columns this screen's footer runs over two or three rows, and the `←/→` phrase this
  // grammar is anchored on sits on the first of them.
  const footerAt = readKeyHintFooter(texts);
  if (footerAt === null) return null;
  const footer = footerAt.text;
  const arrows = FOOTER_ARROWS.exec(footer);
  if (arrows === null) return null;
  const footerActions = footerAt.actions;
  if (hasInputBox(lines)) return null;

  // One upward pass: the region's top is the nearest rule/border above the footer, and the marker
  // rows are the rows between the two. Collecting both together is what makes "within the region"
  // mean the region and not a window.
  //
  // With ONE exception, and it is the wrapped track. The scale's second row is lexically a
  // horizontal rule, so a scan that stopped at it would call it the region's top and then find no
  // marker at all. It is stepped over only while the marker is still unseen — above the marker row
  // the first rule really is the dialog's own opening rule, and that is still where the region ends.
  let top = -1;
  const markerRows: number[] = [];
  //
  // The top itself is found the way menu.ts finds it (region-top.ts): the nearest rule within the rule
  // window, or the `▔` modal edge Claude Code 2.1.27x+ opens the slider with, further up if need be.
  // Before the edge was read, a live slider with no transcript rule in reach declined here.
  for (let i = footerAt.startLine - 1, seen = 0; i >= 0 && seen < MODAL_EDGE_WINDOW; i--, seen++) {
    const t = texts[i]!;
    if (t.includes(MARKER)) {
      markerRows.push(i);
      continue;
    }
    if (markerRows.length === 0 && isTrackRow(t)) continue;
    const kind = regionTopAt(texts, i, seen, footerAt.startLine);
    if (kind === "stop") return null;
    if (kind !== null) {
      top = i;
      break;
    }
  }
  if (top < 0) return null;
  if (markerRows.length !== 1) return null;

  const markerRow = texts[markerRows[0]!]!;
  const markerAt = markerRow.indexOf(MARKER);
  if (markerRow.indexOf(MARKER, markerAt + 1) !== -1) return null;
  const markerColumn = displayWidth(markerRow.slice(0, markerAt));

  // The label row: the first row under the marker that is neither blank nor the track's own wrapped
  // continuation, still inside the region.
  let head = -1;
  let trackWrapped = false;
  for (let i = markerRows[0]! + 1; i < footerAt.startLine; i++) {
    if (isBlank(texts[i]!)) continue;
    if (isTrackRow(texts[i]!)) {
      trackWrapped = true;
      continue;
    }
    head = i;
    break;
  }
  if (head < 0) return null;
  let labels = labelSpans(texts[head]!);
  if (labels.length < 2) return null;
  if (!labels.every((span) => LABEL_WORD.test(span.text))) return null;

  // WRAPPED LABELS. On a narrow pane each level breaks onto a second row, in its own column: `mediu`
  // over `m`, `lo` over `w`. That row is claimed as a continuation only when EVERY one of its tokens
  // starts on exactly the column a head token starts on — which the description row `xhigh +
  // workflows` never does, at any width, because it is centred under the track rather than
  // left-aligned with a label. The merged text becomes the label; the SPANS stay the head row's,
  // because that is the row the marker was drawn against.
  const below =
    head + 1 < footerAt.startLine && !isBlank(texts[head + 1]!) ? labelSpans(texts[head + 1]!) : [];
  //
  // AND A WRAPPED TRACK MEANS WRAPPED LABELS. Claude draws the whole slider as ONE flex row, so the
  // track and the labels wrap together: the two narrow captures wrap both, the wide ones wrap
  // neither. So when the track wrapped, a head row we could not complete is not a scale we may show
  // — the heads there are truncated words (`mediu`, `hig`, `ultracod`), every one of which passes
  // LABEL_WORD, and falling back to them would put a confident invented scale on the card. Declining
  // costs the operator nothing they had: the generic menu still gives the screen Confirm and Cancel.
  // With an UNwrapped track the refused row is the description line and the heads are whole words,
  // so they stand alone exactly as they always did.
  const merged = mergeWrappedLabels(labels, below);
  if (merged === null) {
    if (trackWrapped) return null;
  } else {
    if (!merged.every((span) => MERGED_LABEL.test(span.text))) return null;
    labels = merged;
  }

  // Title = the first non-blank line under the rule, exactly as the generic grammar names a menu.
  let title = "";
  for (let i = top + 1; i < footerAt.startLine; i++) {
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
      // THE SCALE, in row order. `labels` is the one label row the screen printed — its head row
      // alone on a wide pane, its head row plus the fragments aligned under it on a narrow one. The
      // DESCRIPTION line ("xhigh + workflows") is neither, so it stays out of `values`. `value.text`
      // is one of these by construction — it is the span this list was picked from.
      nav: {
        upDown: false,
        leftRight: { verb: arrows[1]!, label: value.text, values: labels.map((s) => s.text) },
      },
      // The same helper, the same bounds as menu.ts:116 — so the marker row is inside the signature
      // and an arrow tap changes it, which is what `menusEqual` needs to abort a stale confirm.
      signature: regionSignature(texts, top, footerAt.endLine),
    },
    startLine: top,
  };
}

/** True when a row is the slider's TRACK and nothing else — rule glyphs, the `\u2506` divider and
 *  spaces. A blank row is not one: blankness is already handled, and calling it track would let an
 *  empty region read as a wrapped one. */
function isTrackRow(text: string): boolean {
  return text.trim() !== "" && TRACK_ONLY.test(text);
}

/**
 * Merge a wrapped label row's fragments onto the head labels above them, or return null when `below`
 * is not a continuation row at all and the head row stands alone.
 *
 * THE TEST IS EXACT START-COLUMN EQUALITY, and that is the whole guard. Claude lays each level out
 * as its own flex column and wraps the word INSIDE that column, so a continuation is left-aligned
 * with its head, not merely near it: on the real captures `lo`/`w` both start at column 3,
 * `medi`/`um` both at 7, `mediu`/`m` both at 10, `hig`/`h` both at 20, `ultracod`/`e` both at 48.
 * One fragment that starts anywhere else refuses the WHOLE row — a partial merge would invent a
 * level nobody printed.
 *
 * A window ("inside the head's span, or one column past its end") was tried first and is wrong. The
 * row directly under the labels on a wide pane is the DESCRIPTION line "xhigh + workflows", and a
 * window only refuses it by luck of where those three words happen to land: at some width nobody
 * captured, `xhigh` falls inside the `max` span and `+ workflows` inside the `ultracode` one, and
 * the card then shows `maxxhigh` and `ultracode+workflows` as levels. Exact equality fails closed at
 * every width instead, because the description line is centred under the track and never
 * left-aligned with a label.
 *
 * With exact equality no two heads can claim one fragment — head starts are distinct by
 * construction, since each is a run of non-space and they are disjoint — so there is no ambiguity
 * branch here. A fragment matching nothing is the only refusal.
 */
function mergeWrappedLabels(heads: LabelSpan[], below: LabelSpan[]): LabelSpan[] | null {
  if (below.length === 0) return null;
  const parts = heads.map(() => "");
  for (const fragment of below) {
    const owner = heads.findIndex((head) => head.start === fragment.start);
    if (owner < 0) return null;
    parts[owner] += fragment.text;
  }
  return heads.map((head, i) => ({ ...head, text: head.text + parts[i]! }));
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
