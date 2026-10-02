// The omp `/resume` SESSION PICKER grammar (.adr/0076), the one omp screen this adapter lifts.
//
// omp paints `/resume` in two layouts, and both are recognised.
//
// NEW, boxed (omp 18.4, `omp--v18-4-resume*.txt`): a rounded box that fills the pane,
//
//     ╭─ Resume Session (current folder) ───────────────────────────╮     <- also `(all projects)`
//     │                                                             │
//     │ > ab                                                        │     <- the search row, `>` + typed text
//     │                                                             │
//     │ ❯ Render Fancy Content in Terminal                          │     <- a session: a TITLE row …
//     │   lets push the boundaries here abit and render some fancy  │     <- … its first-PROMPT row …
//     │   7 minutes ago  ·  138.1KB  ·  current  ·  ✔ done  ·  ⑂ fork │   <- … and its META row
//     │                                                             │
//     │   Render Fancy Content in Terminal                          │
//     │   …                                                         │
//     │                                                             │     <- blank rows down to the footer
//     │ [⌦/⌫ delete · ⏎ select · ⇥ all projects · ⎋ cancel]         │     <- `⇥ current folder` in the other view
//     │                                                             │
//     ╰─────────────────────────────────────────────────────────────╯
//
// OLD, unboxed (omp 17.x to 18.1, `omp--menu-resume*.txt`): the same rows with no box, a rule under the
// title, the pointer in column 0, and the footer in text keycaps,
//
//      Resume Session (current folder)
//
//     ─────────────────────────────────────────────────────────────
//
//     >
//
//     ❯ 1
//       count from 1 to 20 slowly in your reply, one number per line, no tools
//       1 minute ago  ·  1.9KB  ·  ✔ done
//
//       run the shell command: ls -la                                         <- an UNTITLED session: two
//       3 minutes ago  ·  14.4KB  ·  ⚠ interrupted                               rows, first prompt + meta
//
//       [Del/⌫ delete · Enter select · Tab all projects · Esc cancel]
//
//     ─────────────────────────────────────────────────────────────
//
// WHY THIS IS NOT ADR 0058's EXCEPTION. ADR 0058 had to carve out an unprinted Enter for Claude's
// picker, whose footer never names it. omp's does: `⏎ select` / `Enter select` is in the
// footer of both layouts, and the `❯` is the row it takes. So a tap is the arrow walk from the pointed
// row plus a key the screen printed, inside ADR 0009's rule, and no digit is invented (ADR 0055).
//
// FAIL CLOSED. Every piece of evidence is required, and any one missing returns null, which leaves the
// raw mirror and the unread-dialog card (omp/modal.ts) exactly as they were before this file:
//   * the layout's own bottom border at the tail, one spacer row, and a bracketed footer above it that
//     is a hint list ending in a way out (`⎋ cancel`) and naming `select`;
//   * the layout's own title, search row and blank rows, in order, directly above the list;
//   * the list itself as blank-separated groups, each ending in a meta row that carries an age (or the
//     date omp prints from seven days on) and a size: three rows (title, first prompt, meta), or two rows (first prompt, meta) for an
//     untitled session, in both layouts (captured in `omp--menu-resume.txt` and
//     `omp--v18-4-resume-untitled-dated.txt`); nothing else
//     between the last group and the footer;
//   * exactly one `❯`. None, or two, is not one list, and a walk needs a start.
// The no-match screen ("No sessions in current folder. Press ⇥ to view all.") has no rows and declines.
//
// NOT MODELLED, on purpose: `⌦/⌫ delete` and `⇥ all projects` act on the picker, not on a session, and
// `PromptModel` has no field for footer actions (ADR 0058 point 5), so they stay off the card; the Keys
// drawer reaches them. The search box is typed through Type mode. Sessions that share a title are
// common (a forked session keeps its parent's), so the description carries the whole meta row, and the
// signature carries the whole region verbatim.
//
// A REGION LONGER THAN THE BRIDGE ACCEPTS DECLINES. The box fills the pane, so the signature (which is
// also the bound `expected_prompt`) is about rows times columns. The bridge refuses a binding over
// 32768 characters (bridge/server.ts MAX_EXPECTED_PROMPT_CHARS) with a 400, and every tap would fail on
// a very wide pane (about 550 columns at 59 rows). Declining up front leaves the card honest: the raw mirror plus the Cancel card.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other grammar.

import type { StyledLine } from "../../blocks";
import { pointerWalk } from "../menu-hints";
import type { PromptModel, PromptOption } from "../prompt-model";
import { isBlank, lineText, rstrip } from "./markers";
import { readOmpHintList } from "./modal";

export interface ResumePickerRegion {
  model: PromptModel;
  /** Index of the title row: the region is [`startLine` … the bottom border at the tail]. */
  startLine: number;
}

/** The bridge's cap on a bound region (`MAX_EXPECTED_PROMPT_CHARS`, bridge/server.ts), less a margin.
 *  Mirrored rather than imported, as everything else bridge-sized is in `web/`. */
const MAX_REGION_CHARS = 32_000;

/** How far above the footer the title may sit. A tall pane is a few dozen rows; the bound keeps
 *  scrollback out of the search. */
const TITLE_SCAN_WINDOW = 120;

/** The pointer omp's default `unicode` symbol preset prints. The `nerd` and `ascii` presets print
 *  another glyph, and the grammar declines them rather than guess. */
const POINTER = "❯";

/** A session's meta row: an age, then a size, then anything (`current`, `✔ done`, `⚠ interrupted`,
 *  `⑂ fork`, a cwd in the all-projects view). Segments are separated by ` · ` with a double space on
 *  each side. The age is `just now`, `N minute(s) ago`, `N hour(s) ago` or `N day(s) ago` up to six
 *  days; from seven days on omp 18.4.10 prints `toLocaleDateString()` instead (`9/23/2026` in en-US,
 *  `23.9.2026` in de, `2026-09-23` in sv), read from its source, not from a capture. A locale whose
 *  date is not three numbers joined by one of `/`, `.` or `-` declines. */
const AGE = /^(?:\d+ \w+ ago|now|just now|\d{1,4}([./-])\d{1,2}\1\d{1,4})$/;
const SIZE = /^\d+(?:\.\d+)?[KMG]?B$/;
const META_SPLIT = /\s+·\s+/;

interface Layout {
  /** Whether a session may print without a title row, as two rows (first prompt, meta) instead of
   *  three. True where a capture shows it: `omp--menu-resume.txt` (unboxed) lists two of its three
   *  sessions that way, and `omp--v18-4-resume-untitled-dated.txt` shows it in the boxed layout. */
  untitledGroups: boolean;
  /** The title row that opens the region. */
  title: (text: string) => string | null;
  /** Rows directly under the title down to the first session row, as predicates, in order. */
  header: ((text: string) => boolean)[];
  /** A blank row of this layout (the box's blank row, or an empty row). */
  blank: (text: string) => boolean;
  /** The row's interior from the pointer column on, with the frame taken off; null when the row is not
   *  of this layout's frame. `strict` requires the closing border where the layout has one. */
  interior: (text: string, strict: boolean) => string | null;
  /** The bottom border that must be the last non-blank row. */
  bottom: (text: string) => boolean;
  /** The footer row's bracketed hint list, taken out of this layout's frame. */
  footer: (text: string) => string | null;
}

const BOXED: Layout = {
  untitledGroups: true,
  // `(all projects)` is the second state omp 18.4 prints, captured in `omp--v18-4-resume-all-projects.txt`.
  title: (t) => /^╭─ (Resume Session \((?:current folder|all projects)\)) ─+╮$/.exec(t)?.[1] ?? null,
  header: [
    (t) => BOXED.blank(t),
    (t) => /^│ >(?: .*)?│$/.test(t), // the search row: `>` and whatever is typed
    (t) => BOXED.blank(t),
  ],
  blank: (t) => /^│\s*│$/.test(t),
  interior(t, strict) {
    if (!t.startsWith("│ ")) return null;
    const body = t.slice(2);
    if (!strict) return body;
    return /\s*│$/.test(body) ? body.replace(/\s*│$/, "") : null;
  },
  bottom: (t) => /^╰─+╯$/.test(t),
  footer: (t) => /^│ \[(.*)\]\s*│$/.exec(t)?.[1] ?? null,
};

const BARE: Layout = {
  untitledGroups: true,
  // Only `(current folder)` is in the corpus for this layout; the all-projects title is not guessed.
  title: (t) => /^ (Resume Session \(current folder\))$/.exec(t)?.[1] ?? null,
  header: [
    (t) => BARE.blank(t),
    (t) => /^─+$/.test(t),
    (t) => BARE.blank(t),
    (t) => /^>(?: .*)?$/.test(t), // the search row: `>` and whatever is typed
    (t) => BARE.blank(t),
  ],
  blank: (t) => t.trim() === "",
  interior: (t) => (t.length === 0 ? null : t),
  bottom: (t) => /^─+$/.test(t),
  footer: (t) => /^ {2}\[(.*)\]$/.exec(t)?.[1] ?? null,
};

interface Session {
  title: string;
  /** The meta row's segments, normalised to single ` · ` separators. */
  meta: string;
  pointed: boolean;
  /** Screen row of the title, so the pointer's row is known without a second scan. */
  row: number;
}

/**
 * Detect the `/resume` session picker at the tail of `lines`. Returns a `prompt-select` model whose
 * options are the listed sessions plus the footer's own way out, and the index of the title row, or
 * null when any piece of evidence is missing.
 */
export function detectResumePickerRegion(lines: StyledLine[]): ResumePickerRegion | null {
  const texts = lines.map((l) => rstrip(lineText(l)));

  // 1. The tail. The last non-blank row is the layout's bottom border, one spacer sits under the
  //    footer, and the footer is the row above that.
  let end = texts.length - 1;
  while (end >= 0 && isBlank(texts[end]!)) end--;
  if (end < 2) return null;
  const layout = BOXED.bottom(texts[end]!) ? BOXED : BARE.bottom(texts[end]!) ? BARE : null;
  if (layout === null) return null;
  if (!layout.blank(texts[end - 1]!)) return null;
  const footerAt = end - 2;
  const hintText = layout.footer(texts[footerAt]!);
  if (hintText === null) return null;
  const footer = readOmpHintList(hintText);
  if (footer === null) return null;
  // Both layouts print the commit key. Without it this would be a screen whose Enter nobody printed,
  // and that is ADR 0058's exception, not this grammar.
  if (!footer.segments.some((s) => /^(?:⏎|enter) select$/i.test(s))) return null;

  // 2. The title, nearest above the footer, then the layout's fixed header rows under it.
  let titleAt = -1;
  let title = "";
  for (let i = footerAt - 1, seen = 0; i >= 0 && seen < TITLE_SCAN_WINDOW; i--, seen++) {
    const found = layout.title(texts[i]!);
    if (found !== null) {
      titleAt = i;
      title = found;
      break;
    }
  }
  if (titleAt < 0) return null;
  let cursor = titleAt + 1;
  for (const rowIs of layout.header) {
    if (cursor >= footerAt || !rowIs(texts[cursor]!)) return null;
    cursor++;
  }

  // 3. The sessions: blank-separated groups of rows, nothing else down to the footer. One unknown row
  //    anywhere (a scroll counter, a notice) declines the whole screen.
  const sessions: Session[] = [];
  while (cursor < footerAt) {
    if (layout.blank(texts[cursor]!)) {
      cursor++;
      continue;
    }
    const group = readGroup(layout, texts, cursor, footerAt);
    if (group === null) return null;
    sessions.push(group.session);
    cursor += group.rows;
    // A group is closed by a blank row or by the footer, so two groups can never run together.
    if (cursor < footerAt && !layout.blank(texts[cursor]!)) return null;
  }
  if (sessions.length === 0) return null;

  // 4. The pointer. One `❯` fixes where every walk starts; none or two is not one list.
  const pointedCount = sessions.filter((s) => s.pointed).length;
  if (pointedCount !== 1) return null;
  const pointedAt = sessions.findIndex((s) => s.pointed);

  const options: PromptOption[] = sessions.map((session, i) => ({
    label: session.title,
    description: session.meta,
    keys: pointerWalk(pointedAt, i),
    // The footer never names the arrows, only the pointer: so the pointed row's badge is the
    // terminal's own `❯` and every other row carries NO badge (`""` is the explicit "no badge" signal,
    // rendered as an empty same-width slot so every title starts at one column). Same as ADR 0058.
    keyLabel: i === pointedAt ? POINTER : "",
  }));
  // The footer's own way out, in its own words (`Cancel`). `PromptModel` has no actions field, so it
  // rides as the last row, with the key's name, exactly as claude/resume.ts does.
  options.push({ label: capitalise(footer.escapeVerb), keys: ["Escape"], keyLabel: "Esc" });

  // The signature is the region verbatim, title through the bottom border, trailing padding off (the
  // bridge compares with it off). It carries the `❯` column and every row of every session, so a
  // pointer moved between the render and the tap, a session added, or an age that ticked all refuse
  // the tap (ADR 0055 point 6; the age tick is the same safe-side trade ADR 0058 records).
  const signature = texts.slice(titleAt, end + 1).join("\n");
  // The bridge refuses a longer binding outright, so a longer region is a screen this card cannot
  // drive. See the header.
  if (signature.length > MAX_REGION_CHARS) return null;
  const pointedRow = sessions[pointedAt]!.row;
  const coreSignature = texts
    .slice(titleAt, end + 1)
    .map((row, i) => (titleAt + i === pointedRow ? row.replace(POINTER, " ") : row))
    .join("\n");

  const model: PromptModel = {
    question: title,
    // The card's caption is this dialog's own title, not the generic "Choose an option".
    caption: title,
    options,
    family: "select",
    signature,
    coreSignature,
  };
  return { model, startLine: titleAt };
}

/** The model alone (or null), the thin matcher tests assert on. */
export function detectResumePicker(lines: StyledLine[]): PromptModel | null {
  return detectResumePickerRegion(lines)?.model ?? null;
}

/**
 * One session group at row `at`, or null. A group is an optional TITLE row, a first-PROMPT row and a META
 * row, and the meta row is what tells the shapes apart: when the second row is a meta row the group is
 * two rows long and its first row, the first prompt, is the only name the session has (`omp--menu-resume.txt`
 * lists two of three sessions that way); otherwise the third row must be the meta row. Anything else
 * declines, including a first-prompt row that happens to read like a meta row, because the row after it
 * is then not blank.
 *
 * The first row opens with the pointer column (`❯` or a space) and a space. The first-prompt row of a
 * titled group is free text and is checked only for its indent: its bytes ride in the signature, nobody
 * parses them. A meta row carries an age and a size.
 */
function readGroup(
  layout: Layout,
  texts: string[],
  at: number,
  footerAt: number,
): { session: Session; rows: number } | null {
  const first = layout.interior(texts[at]!, true);
  if (first === null) return null;
  const head = /^([❯ ]) (\S.*)$/.exec(first);
  if (head === null) return null;
  const pointed = head[1] === POINTER;
  const name = head[2]!.trim();

  const second = at + 1 < footerAt ? readMeta(layout, texts[at + 1]!) : null;
  if (second !== null) {
    if (!layout.untitledGroups) return null;
    return { session: { title: name, meta: second, pointed, row: at }, rows: 2 };
  }

  if (at + 2 >= footerAt) return null;
  const prompt = layout.interior(texts[at + 1]!, false);
  if (prompt === null || !/^ {2}\S/.test(prompt)) return null;
  const third = readMeta(layout, texts[at + 2]!);
  if (third === null) return null;
  return { session: { title: name, meta: third, pointed, row: at }, rows: 3 };
}

/** A session's meta row as one normalised string, or null when the row is not one: an age, then a
 *  size, then anything, each separated by ` · ` with a double space on each side on screen. */
function readMeta(layout: Layout, row: string): string | null {
  const body = layout.interior(row, true);
  if (body === null) return null;
  const text = /^ {2}(\S.*)$/.exec(body);
  if (text === null) return null;
  const segments = text[1]!.trim().split(META_SPLIT);
  if (segments.length < 2) return null;
  if (!AGE.test(segments[0]!) || !SIZE.test(segments[1]!)) return null;
  return segments.join(" · ");
}

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
