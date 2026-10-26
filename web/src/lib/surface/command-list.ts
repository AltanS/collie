// The harness's own completion list for a slash command (`idle.volatile.below.commandList`), read at
// a box: the run of rows straight under the bottom edge, right over the top edge, or inside the box
// under the prompt row, that the profile's patterns name as the list's entries. Two callers: the
// frame module, which may find a box only past its list (the list pushes the box's own rows out of
// the frame's reach) and keeps an inside list's rows out of the draft, and the modal cues, which
// leave the typed command's own list out of every cue read.
//
// Pure: no DOM, no Bun API, no harness name. Every pattern comes from the profile; the rows are read
// by their texts alone, except a list whose pointer is bold paint (`pointerBold`), which also reads
// the styled rows when the caller holds them.

import type { FrameRow } from "./frame";
import type { CommandListRows, CommandListSide } from "./profile";

/**
 * The profile's command list, read at a box: the command its pointer rests on with the profile's lead
 * in front (null with no pointer), the side of the box it stands on, its first and last row, and the
 * command of every entry on screen with the lead in front, the pointed one included, top to bottom.
 */
export interface CommandListRead {
  readonly pointed: string | null;
  readonly side: CommandListSide;
  readonly first: number;
  readonly last: number;
  readonly entries: readonly string[];
}

interface CompiledCommandList {
  readonly pointer: RegExp;
  readonly entry: RegExp;
  readonly wrapped: RegExp;
  readonly lead: string;
  readonly namespaces: readonly string[];
  readonly under: boolean;
  readonly above: boolean;
  readonly inside: boolean;
  readonly pointerBold: boolean;
  readonly footer: { readonly pattern: RegExp; readonly maxRows: number } | null;
  readonly notForText: RegExp | null;
}

const compiledLists = new WeakMap<CommandListRows, CompiledCommandList>();

function listPatterns(list: CommandListRows): CompiledCommandList {
  const known = compiledLists.get(list);
  if (known !== undefined) return known;
  const sides = list.sides ?? ["under", "above"];
  const compiled: CompiledCommandList = {
    pointer: new RegExp(list.pointer, "u"),
    entry: new RegExp(list.entry, "u"),
    wrapped: new RegExp(list.wrapped, "u"),
    lead: list.lead ?? "",
    namespaces: list.namespaces ?? [],
    under: sides.includes("under"),
    above: sides.includes("above"),
    inside: sides.includes("inside"),
    pointerBold: list.pointerBold === true,
    footer: list.footer === undefined ? null : { pattern: new RegExp(list.footer.pattern, "u"), maxRows: list.footer.maxRows },
    notForText: list.notForText === undefined ? null : new RegExp(list.notForText, "u"),
  };
  compiledLists.set(list, compiled);
  return compiled;
}

/** Whether the profile says the box's `text` opens no command list (`notForText`): another popup stands under it. */
function opensNoList(patterns: CompiledCommandList, text: string | undefined): boolean {
  return text !== undefined && patterns.notForText !== null && patterns.notForText.test(text);
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/** One row of a command list: the pointed entry or another entry, each with its command, a row that is no entry, or none of them. */
type ListRow = { readonly kind: "pointer" | "entry"; readonly command: string } | { readonly kind: "wrapped" } | null;

/**
 * Whether a styled row paints `command` bold: a `pointerBold` list's pointer (absent row = no
 * pointer). The bold run may carry the entry's tags after the command (`/plan · built-in …`), so
 * the command at the run's start, ended there or followed by a space, is the mark; a longer
 * command that merely opens with it (`/resume-claude` for `/resume`) is not.
 */
function paintsBold(row: FrameRow | undefined, command: string): boolean {
  if (row === undefined) return false;
  return row.segments.some((segment) => {
    if (segment.bold !== true) return false;
    const text = segment.text.trim();
    return text === command || text.startsWith(`${command} `);
  });
}

function listRow(text: string, patterns: CompiledCommandList, row?: FrameRow): ListRow {
  if (!patterns.pointerBold) {
    const head = patterns.pointer.exec(text);
    if (head !== null) {
      const command = head.groups?.["command"];
      return command === undefined ? null : { kind: "pointer", command: patterns.lead + command };
    }
  }
  const entry = patterns.entry.exec(text);
  if (entry !== null) {
    const command = entry.groups?.["command"];
    if (command === undefined) return null;
    const named = patterns.lead + command;
    return { kind: patterns.pointerBold && paintsBold(row, named) ? "pointer" : "entry", command: named };
  }
  if (patterns.wrapped.test(text)) return { kind: "wrapped" };
  return null;
}

/**
 * Whether the rows from `at` to the screen's last row are the footer the profile names under its list:
 * the first row matches the footer's pattern, no row in the run is blank, and the run is at most the
 * footer's `maxRows` tall.
 */
function footerFrom(texts: readonly string[], at: number, footer: CompiledCommandList["footer"]): boolean {
  if (footer === null || !footer.pattern.test(texts[at]!.trimEnd())) return false;
  let end = texts.length;
  while (end > at && isBlank(texts[end - 1]!)) end--;
  if (end - at > footer.maxRows) return false;
  for (let j = at; j < end; j++) if (isBlank(texts[j]!)) return false;
  return true;
}

/**
 * The list under the bottom edge `bottom`: the first row under it is an entry, every other non-blank
 * row is an entry or a row that is no entry, at most one carries the pointer, and the list runs to the
 * screen's last row, or to the profile's footer under it. Anything else there (a dialog, a status row
 * the profile does not name, a second pointer, a gap right under the edge) is no list.
 */
function listUnder(texts: readonly string[], bottom: number, patterns: CompiledCommandList, rows?: readonly FrameRow[]): CommandListRead | null {
  let pointed: string | null = null;
  const entries: string[] = [];
  let last = bottom;
  for (let i = bottom + 1; i < texts.length; i++) {
    const text = texts[i]!.trimEnd();
    if (isBlank(text)) {
      if (entries.length === 0) return null;
      continue;
    }
    const row = listRow(text, patterns, rows?.[i]);
    if (row === null) {
      if (entries.length > 0 && footerFrom(texts, i, patterns.footer)) break;
      return null;
    }
    if (row.kind === "wrapped") {
      if (entries.length === 0) return null;
    } else {
      if (row.kind === "pointer") {
        if (pointed !== null) return null;
        pointed = row.command;
      }
      entries.push(row.command);
    }
    last = i;
  }
  return entries.length === 0 ? null : { pointed, side: "under", first: bottom + 1, last, entries };
}

/**
 * The list over the top edge `top` (a tall pane draws it there): the run of rows right above the edge,
 * up to the first blank row or a row that is no entry, pointer or wrapped row. It opens on an entry; a
 * wrapped row over its first entry belongs to the transcript. At most one entry carries the pointer.
 */
function listAbove(texts: readonly string[], top: number, patterns: CompiledCommandList, styled?: readonly FrameRow[]): CommandListRead | null {
  const rows: { at: number; row: Exclude<ListRow, null> }[] = [];
  for (let i = top - 1; i >= 0; i--) {
    const text = texts[i]!.trimEnd();
    if (isBlank(text)) break;
    const row = listRow(text, patterns, styled?.[i]);
    if (row === null) break;
    rows.unshift({ at: i, row });
  }
  while (rows.length > 0 && rows[0]!.row.kind === "wrapped") rows.shift();
  if (rows.length === 0) return null;
  const pointers = rows.flatMap(({ row }) => (row.kind === "pointer" ? [row.command] : []));
  if (pointers.length > 1) return null;
  const entries = rows.flatMap(({ row }) => (row.kind === "wrapped" ? [] : [row.command]));
  return { pointed: pointers[0] ?? null, side: "above", first: rows[0]!.at, last: top - 1, entries };
}

/**
 * The list inside the box, under its prompt row: every row from the prompt row's next row to the
 * bottom edge is an entry or a row that is no entry (a count row), the first of them is an entry,
 * and at most one carries the pointer. Anything else there — a blank row, a wrapped draft row, a
 * dialog's rows, a second pointer — is no list: those rows stay the draft's, and every other read
 * of the box goes on as before.
 */
function listInside(texts: readonly string[], prompt: number, bottom: number, patterns: CompiledCommandList, rows?: readonly FrameRow[]): CommandListRead | null {
  let pointed: string | null = null;
  const entries: string[] = [];
  for (let i = prompt + 1; i < bottom; i++) {
    const row = listRow(texts[i]!.trimEnd(), patterns, rows?.[i]);
    if (row === null) return null;
    if (row.kind === "wrapped") {
      if (entries.length === 0) return null;
    } else {
      if (row.kind === "pointer") {
        if (pointed !== null) return null;
        pointed = row.command;
      }
      entries.push(row.command);
    }
  }
  return entries.length === 0 ? null : { pointed, side: "inside", first: prompt + 1, last: bottom - 1, entries };
}

/**
 * The list inside a box whose prompt row is `prompt` and whose bottom edge is `bottom`, when the
 * profile names that side ({@link listInside}). The frame module keeps such a list's rows out of
 * the draft it reads. Null otherwise.
 */
export function insideList(
  texts: readonly string[],
  prompt: number,
  bottom: number,
  list: CommandListRows | undefined,
  rows?: readonly FrameRow[],
): CommandListRead | null {
  if (list === undefined) return null;
  const patterns = listPatterns(list);
  return patterns.inside ? listInside(texts, prompt, bottom, patterns, rows) : null;
}

/**
 * The profile's command list at a box with its top edge on row `top` and its bottom edge (or an open
 * box's last row) on row `bottom`, on the sides the profile names: all that stands under the bottom
 * edge, the run right over the top edge, where a tall pane draws it, or inside the box under its
 * prompt row (`prompt`, needed for that side only). The command in the left column may have its
 * description in a second column on the same row, or wrapped onto rows under it. A list under the
 * box with a pointer wins; else a list inside it with a pointer; else the list over it; else a list
 * inside it; else a list under it with no pointer. Null when the profile names no list or no side
 * holds one. `rows` carries the styled rows a `pointerBold` list's pointer is read from. `text` is the
 * box's text: with the profile's `notForText` it names a text that opens another popup, and no list is read.
 */
export function commandListNear(
  texts: readonly string[],
  top: number,
  bottom: number,
  list: CommandListRows | undefined,
  rows?: readonly FrameRow[],
  prompt?: number,
  text?: string,
): CommandListRead | null {
  if (list === undefined) return null;
  const patterns = listPatterns(list);
  if (opensNoList(patterns, text)) return null;
  const under = patterns.under ? listUnder(texts, bottom, patterns, rows) : null;
  if (under !== null && under.pointed !== null) return under;
  const inside = patterns.inside && prompt !== undefined ? listInside(texts, prompt, bottom, patterns, rows) : null;
  if (inside !== null && inside.pointed !== null) return inside;
  return (patterns.above ? listAbove(texts, top, patterns, rows) : null) ?? inside ?? under;
}

/**
 * Whether the list's pointer rests on the command `typed`, so Enter there runs that command: the
 * pointed command is `typed` itself, or `typed` is the lead and a bare name and the pointer rests on
 * that name under one of the profile's namespaces (a harness that lists the skill `wrap-up` as
 * `skill:wrap-up` for a typed `/wrap-up`). The second form holds only while no entry on screen is
 * `typed` itself: a list that shows both spellings has two commands of that name, and Enter might run
 * the other one. False with no pointer.
 */
export function pointsAt(read: CommandListRead, typed: string, list: CommandListRows | undefined): boolean {
  const text = typed.trim();
  if (read.pointed === null) return false;
  if (read.pointed === text) return true;
  if (list === undefined) return false;
  if (pointsAtPathEnd(read, text, list)) return true;
  if (list.argumentList === true && pointsAtArgument(read, text, list.lead ?? "")) return true;
  const patterns = listPatterns(list);
  if (patterns.namespaces.length === 0 || !text.startsWith(patterns.lead) || read.entries.includes(text)) return false;
  const bare = text.slice(patterns.lead.length);
  if (bare.length === 0) return false;
  return patterns.namespaces.some((namespace) => !bare.startsWith(namespace) && read.pointed === patterns.lead + namespace + bare);
}

/**
 * Whether `text` is a path (`commandList.notForText`) and the pointer rests on the entry that completes
 * its last word: the popup of the path's own file, where Enter takes the typed path as it stands
 * (`/uploads/w2.png` with the pointer on `w2.png`). A pointer on any other entry is another command's
 * row, and Enter would run that one: a list drawn for such a text is read apart from {@link commandListNear}'s
 * text rule, which hides it from the cue and Surface reads only.
 */
function pointsAtPathEnd(read: CommandListRead, text: string, list: CommandListRows): boolean {
  const patterns = listPatterns(list);
  if (read.pointed === null || !opensNoList(patterns, text) || !read.pointed.startsWith(patterns.lead)) return false;
  const entry = read.pointed.slice(patterns.lead.length);
  return entry.length > 0 && text.endsWith(`/${entry}`);
}

/**
 * Whether `text`, a command word and its argument, has the pointer on that very argument
 * (`commandList.argumentList`): `/goal pause` with the pointer on `pause`. The list must not hold
 * the command word itself (`/goal`), or it is the list of commands, and the argument is the rest of
 * the text to the end, so a pointer on a longer or shorter name never stands for it.
 */
function pointsAtArgument(read: CommandListRead, text: string, lead: string): boolean {
  const word = /^\S+/u.exec(text)?.[0];
  if (word === undefined || !word.startsWith(lead) || read.entries.includes(word)) return false;
  const argument = text.slice(word.length).trim();
  if (argument.length === 0 || read.pointed === null || !read.pointed.startsWith(lead)) return false;
  return read.pointed.slice(lead.length) === argument;
}

/**
 * The list under the box whose bottom edge (or open box's last row) is row `bottom`, when its pointer
 * rests on `text`, the box's text ({@link pointsAt}): the typed command's own typeahead. Null otherwise,
 * and on a profile whose list never stands under the box.
 */
export function ownListUnder(texts: readonly string[], bottom: number, text: string, list: CommandListRows | undefined): CommandListRead | null {
  if (list === undefined) return null;
  const patterns = listPatterns(list);
  if (!patterns.under || opensNoList(patterns, text)) return null;
  const read = listUnder(texts, bottom, patterns);
  return read !== null && pointsAt(read, text, list) ? read : null;
}

/**
 * Whether `text`, the box's text, opened the list `read` on a profile with `leadOpens`: the text starts
 * with the profile's lead and the list stands under the box. The harness draws a fuzzy list for a
 * half-typed or unknown command (`/help` shows ten rows the pointer picks from), and that list belongs
 * to the box all the same; whether Enter would run what is typed is {@link pointsAt}'s question, asked
 * by the caller. False on a profile that does not name `leadOpens`.
 */
export function openedByText(read: CommandListRead, text: string, list: CommandListRows | undefined): boolean {
  if (list === undefined || list.leadOpens !== true || read.side !== "under") return false;
  const lead = list.lead ?? "";
  return lead.length > 0 && text.trimStart().startsWith(lead);
}

/**
 * The list under the box whose bottom edge (or open box's last row) is row `bottom`, when it is the
 * list the box's text opened: its pointer rests on the text ({@link ownListUnder}), or the profile's
 * `leadOpens` says the text opened it ({@link openedByText}) and the list has a pointer. Null
 * otherwise, and on a profile whose list never stands under the box.
 */
export function openListUnder(texts: readonly string[], bottom: number, text: string, list: CommandListRows | undefined): CommandListRead | null {
  if (list === undefined) return null;
  const patterns = listPatterns(list);
  if (!patterns.under || opensNoList(patterns, text)) return null;
  const read = listUnder(texts, bottom, patterns);
  if (read === null || read.pointed === null) return null;
  return pointsAt(read, text, list) || openedByText(read, text, list) ? read : null;
}

/**
 * The stale list under an empty box (`staleWhenEmpty`): the rows of a list under the bottom edge
 * `bottom` when the box's text is empty, so the harness left them from a text that is gone. Null
 * otherwise, and on a profile that does not name `staleWhenEmpty`.
 */
export function staleListUnder(texts: readonly string[], bottom: number, text: string, list: CommandListRows | undefined): CommandListRead | null {
  if (list === undefined || list.staleWhenEmpty !== true || text.trim().length > 0) return null;
  const patterns = listPatterns(list);
  return patterns.under ? listUnder(texts, bottom, patterns) : null;
}

/**
 * Whether any row from `first` to `last` is an entry or the pointed entry of the profile's list
 * (a wrapped row alone is none: it means something only under an entry). False on a profile whose
 * list never stands under the box. The frame module asks it of the rows under an open box before it
 * passes them over as an extension's widget: a list is read as the typed command's own or not at all.
 */
export function anyListRow(texts: readonly string[], first: number, last: number, list: CommandListRows | undefined): boolean {
  if (list === undefined) return false;
  const patterns = listPatterns(list);
  if (!patterns.under) return false;
  for (let i = first; i <= last && i < texts.length; i++) {
    const row = listRow(texts[i]!.trimEnd(), patterns);
    if (row !== null && row.kind !== "wrapped") return true;
  }
  return false;
}

/**
 * The row a box past its own list would end on: from the screen's last non-blank row (`end` - 1) up,
 * at most `reach` rows, the first row that is no list row and whose rows under it read as a list with
 * a pointer ({@link listUnder}). Only one row can: a row higher up has that row under it, which is no
 * list row. The frame module tries a box there when it found none at the screen's end, and keeps one
 * only when the list is its own. Null on a profile whose list never stands under the box.
 */
export function listedBottom(texts: readonly string[], end: number, reach: number, list: CommandListRows | undefined): number | null {
  if (list === undefined) return null;
  const patterns = listPatterns(list);
  if (!patterns.under) return null;
  for (let b = end - 2; b >= 0 && end - 1 - b <= reach; b--) {
    if (isBlank(texts[b]!) || listRow(texts[b]!.trimEnd(), patterns) !== null) continue;
    const read = listUnder(texts, b, patterns);
    if (read !== null && read.pointed !== null) return b;
  }
  return null;
}
