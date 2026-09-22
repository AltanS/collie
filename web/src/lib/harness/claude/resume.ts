// The /resume SESSION PICKER grammar (.adr/0058) — the one dialog on which a tap sends a key the
// screen never printed.
//
// Claude Code 2.1.278 paints `/resume` as a titled modal with a search box, a list of past sessions
// and a key-hint footer:
//
//        Resume session
//        ╭──────────────────────╮
//        │ ⌕ Search…            │
//        ╰──────────────────────╯
//          resume-lab                        <- project heading, not a session
//
//          Count to three                    <- a session: a title row …
//          1 minute ago · master · 177.4KB   <- … and its meta row
//
//        ❯ say ok                            <- the pointed session: `❯` in the box's column
//          2 minutes ago · master · 176.8KB
//
//          Ctrl+A to show all projects · Ctrl+B to only show current branch · Space to preview ·
//          Ctrl+R to rename · Type to search · Esc to cancel
//
// The footer NEVER names Enter or the arrows, so under ADR 0009 the generic menu (menu.ts) can only
// offer Cancel, and no card could ever resume a session. ADR 0058 makes the one exception: this
// dialog, recognised by its own title, its own search box and its own footer, is lifted as the
// pointed list ADR 0055 already walks, and a tap is the arrow walk from the `❯` plus an unprinted
// `Enter`. The `❯` pointer means "Enter takes this row" in every Claude list; the exception is
// scoped to this screen and gives no other dialog an unprinted key.
//
// FAIL CLOSED. Every piece of evidence is required — the title, the rounded search box directly
// under it, and a footer (read across its wrapped rows by `readKeyHintFooter`) that names `Esc to
// cancel` or `Esc to clear`. Any one missing returns null, and the generic menu still runs.
//
// NOT MODELLED, on purpose: `Ctrl+R to rename` and `Space to preview` open sub-states this card does
// not draw, and `PromptModel` has no place for footer actions, so `Ctrl+A` / `Ctrl+B` stay off the
// card too. The Keys drawer and the card's Terminal control (.adr/0056) remain the way to reach
// them. The search box is typed through Type mode.
//
// Pure functions over `StyledLine[]`, tail-anchored like every other Claude grammar.

import type { StyledLine } from "../../blocks";
import { hasInputBox } from "./chrome";
import { isBlank, lineText } from "./markers";
import { coreRegionSignature, pointerWalk, regionSignature, type PromptRegion } from "./prompt-select";
import type { PromptModel, PromptOption } from "../prompt-model";
import { readKeyHintFooter } from "../menu-hints";

/** The dialog's own title: `Resume session`, or `Resume session (1 of 50)` in the all-projects view. */
const TITLE = /^Resume session(?: \(\d+ of \d+\))?$/;

/** The footer's way out, in either of the two states the picker prints: the list (`Esc to cancel`)
 *  and a typed search (`Esc to clear`). Required as evidence, and it is the card's Cancel. */
const FOOTER_ESCAPE = /\bEsc to (?:cancel|clear)\b/;

/** The footer's commit key, printed only in the search state. The one unpointed arm requires it. */
const FOOTER_ENTER = /\bEnter to \w+/;

/** A session's META row: `<age> ago · <branch> · <size>`, or `now · …` for a session touched this
 *  second, with a project path appended in the all-projects view. Tolerant on purpose — an age
 *  ending in `ago` (or `now`), then at least one ` · ` segment. */
const META_ROW = /^(?:\S.*\bago|now) · \S/;

/** The glyphs the picker draws in the pointer column. `❯` is the pointer; `↓` / `↑` mark that the
 *  list scrolls past this row — the row is still a session, just not the pointed one. */
const POINTER = "❯";
const SCROLL_MARKERS = new Set(["↓", "↑"]);

/** `"❯ "`: a session title starts this many cells right of the pointer column. */
const POINTER_COLUMN = 2;

/** How far above the footer the title may sit. The all-projects view shows nine sessions (three rows
 *  each) plus the search box; the window is generous and still bounded, so scrollback can't count. */
const REGION_SCAN_WINDOW = 60;

interface Session {
  title: string;
  meta: string;
  pointed: boolean;
}

/**
 * Detect the /resume session picker at the tail of `lines`. Returns a `prompt-select` model whose
 * options are the listed sessions plus the footer's Esc action, and the index of the title row — or
 * null when any piece of evidence is missing.
 */
export function detectResumePickerRegion(lines: StyledLine[]): PromptRegion | null {
  const texts = lines.map(lineText);

  // 1. The footer, read across the rows the terminal wrapped it onto, naming the way out.
  const footerAt = readKeyHintFooter(texts);
  if (footerAt === null) return null;
  if (!FOOTER_ESCAPE.test(footerAt.text)) return null;
  const escape = footerAt.actions.find((a) => a.cancel === true);
  if (escape === undefined) return null;
  // A modal, never a live composer: fake buttons over an input box are worse than none (menu.ts).
  if (hasInputBox(lines)) return null;

  // 2. The title, nearest above the footer, with the rounded search box directly under it.
  let titleAt = -1;
  for (let i = footerAt.startLine - 1, seen = 0; i >= 0 && seen < REGION_SCAN_WINDOW; i--, seen++) {
    if (TITLE.test(texts[i]!.trim())) {
      titleAt = i;
      break;
    }
  }
  if (titleAt < 0) return null;
  const column = searchBoxColumn(texts, titleAt + 1, footerAt.startLine);
  if (column === null) return null;

  // 3. The sessions: every title row directly followed by a meta row, in screen order. Everything
  //    else between the box and the footer (the project heading, blank rows) is skipped.
  const sessions: Session[] = [];
  const end = footerAt.startLine;
  for (let i = titleAt + 4; i < end; i++) {
    const title = titleRow(texts[i]!, column);
    if (title === null) continue;
    const meta = i + 1 < end ? metaRow(texts[i + 1]!, column) : null;
    if (meta === null) continue;
    sessions.push({ title: title.text, meta, pointed: title.pointed });
    i++; // the meta row is consumed with its title
  }
  if (sessions.length === 0) return null;

  // 4. The pointer. One `❯` fixes where every walk starts. None is only safe with a single session
  //    and a footer that names Enter itself (the search state); two is not one list.
  const pointedCount = sessions.filter((s) => s.pointed).length;
  if (pointedCount > 1) return null;
  const pointedAt = sessions.findIndex((s) => s.pointed);
  if (pointedAt < 0 && !(sessions.length === 1 && FOOTER_ENTER.test(footerAt.text))) return null;

  const options: PromptOption[] = sessions.map((session, i) => {
    const option: PromptOption = {
      label: session.title,
      description: session.meta,
      keys: pointedAt < 0 ? ["Enter"] : pointerWalk(pointedAt, i),
    };
    // Unlike ADR 0055's trust prompt, this footer never names the arrows at all — only the pointer
    // and Esc. So the pointed row's badge is the terminal's own `❯`, and every OTHER session row
    // carries NO badge: `keyLabel: ""` is the explicit "no badge" signal, which the block renders
    // as an empty, same-width slot so every title still starts at the same column, pointed or not.
    if (pointedAt >= 0) option.keyLabel = i === pointedAt ? POINTER : "";
    return option;
  });
  // The footer's own way out, in its own words ("Cancel", or "Clear" while a search is typed).
  // `PromptModel` has no actions field, so it rides as the last row, with the footer's key name.
  options.push({ label: escape.label, keys: escape.keys, keyLabel: "Esc" });

  const title = texts[titleAt]!.trim();
  const model: PromptModel = {
    question: title,
    // The card's caption is this dialog's own title, not the generic "Choose an option" every other
    // `select` card shows — the reader needs to know they are looking at the resume picker.
    caption: title,
    options,
    family: "select",
    // Byte-faithful from the title through the footer: it carries the `❯` column verbatim, so a
    // pointer moved between the render and the tap refuses the tap (ADR 0055 point 6). The walk is
    // also baked into every option's `keys`, which the identity comparison checks.
    signature: regionSignature(texts, titleAt, footerAt.endLine),
    coreSignature: coreRegionSignature(texts, titleAt, footerAt.endLine, new Set()),
  };
  return { model, startLine: titleAt };
}

/**
 * The display column of the rounded search box's left edge when rows `from`, `from + 1` and
 * `from + 2` are exactly `╭…`, `│ ⌕ …` and `╰…` at one shared column — or null. That column is also
 * where the picker draws its pointer.
 */
function searchBoxColumn(texts: string[], from: number, end: number): number | null {
  if (from + 2 >= end) return null;
  const top = texts[from]!;
  const middle = texts[from + 1]!;
  const bottom = texts[from + 2]!;
  const column = top.indexOf("╭");
  if (column < 0 || top.slice(0, column).trim() !== "") return null;
  if (middle.indexOf("│") !== column || !middle.includes("⌕")) return null;
  if (bottom.indexOf("╰") !== column) return null;
  if (middle.slice(0, column).trim() !== "" || bottom.slice(0, column).trim() !== "") return null;
  return column;
}

/** A session title row: spaces up to the pointer column, then `❯`, a scroll marker or a space, one
 *  space, and text. Null for any other shape — including a glyph the picker is not known to draw. */
function titleRow(text: string, column: number): { text: string; pointed: boolean } | null {
  if (isBlank(text)) return null;
  if (text.slice(0, column).trim() !== "") return null;
  const glyph = text[column] ?? "";
  if (glyph !== " " && glyph !== POINTER && !SCROLL_MARKERS.has(glyph)) return null;
  if (text[column + 1] !== " ") return null;
  const rest = text.slice(column + POINTER_COLUMN);
  if (rest.length === 0 || rest[0] === " ") return null;
  return { text: rest.trim(), pointed: glyph === POINTER };
}

/** A session's meta row, trimmed, when it sits at the title's own column and reads as one. */
function metaRow(text: string, column: number): string | null {
  const indent = column + POINTER_COLUMN;
  if (text.slice(0, indent).trim() !== "") return null;
  const rest = text.slice(indent);
  if (rest.length === 0 || rest[0] === " ") return null;
  const meta = rest.trim();
  return META_ROW.test(meta) ? meta : null;
}

/** The model alone (or null) — the thin matcher tests assert on. */
export function detectResumePicker(lines: StyledLine[]): PromptModel | null {
  return detectResumePickerRegion(lines)?.model ?? null;
}
