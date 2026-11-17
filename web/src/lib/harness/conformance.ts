// The HarnessAdapter CONFORMANCE suite — the CI gate every adapter must clear before its dialog
// buttons are allowed to go hot. It is a single `describe`-registering function, parameterised on
// the adapter under test plus three fixture cohorts, so a future adapter (codex/pi/opencode) gets
// the exact same invariants for free by calling it from its own `*.test.ts`:
//
//   1. CONSERVATIVE DETECTION (fail-closed) — the adapter must return ONLY raw blocks on every
//      FOREIGN adapter's fixtures and on NEUTRAL (plain shell / log) output. A detector that lifts
//      an interactive block from a buffer it doesn't own would type keystrokes into a live terminal,
//      so "return null on anything unrecognised" is non-negotiable and pinned here.
//   2. TAIL-ANCHORING — every one of the adapter's OWN dialogs lifts ONLY while it sits at the
//      buffer tail. Append a couple of lines of ordinary output below it (the menu has scrolled up)
//      and detection must fall back to raw-only. This is the false-positive guard every detector
//      leans on (see the grammars' "the footer is the last non-blank line" invariant).
//   3. KEY-GRAMMAR VALIDITY — every keystroke any interactive block can emit is a valid Herdr
//      `pane.send_keys` key (HERDR_API.md §"send_keys key grammar"): a single literal char, a bare
//      special key, or a `+`-joined modifier chord. Multi-char digit runs ("10") and the paging/edit
//      keys (PageUp/Home/End/Delete) are rejected — Herdr answers those with `invalid_key`. A key
//      plan a model declares as data (`advanceKeys`, a review's `submitKeys`/`cancelKeys`/`backKeys`)
//      must also be non-empty, since a button bound to an empty plan sends nothing.
//   4. THE GENERIC MODAL CONTRACT — for any fixture that lifts a `menu` block: every action key is on
//      the shared allowed list (`menuKeyFor`, menu-hints.ts) and none is a digit (.adr/0009), a walk is
//      arrows of one direction and then Enter (item 6's pointer-walk leg), the model carries a
//      non-empty signature that MOVES when the region's text does (it is the whole race guard), and
//      the adapter's `composerReady` — if it has one — says false while the modal has the keyboard.
//      Neutral output must lift no menu at all. An adapter with no menu fixtures registers a todo.
//      This leg does NOT prove that the screen printed each key: only a notice card's keys are
//      compared with the key block the screen printed. The named exceptions of ADR 0151 rule 3 are
//      reviewed per dialog, not by this suite.
//   5. THE DIALOG-MODEL CONTRACT — for EVERY block kind the adapter up-levels (the generalisation of
//      4's signature leg): the model's signature and its bound region text are non-empty, the
//      signature MOVES when a row the dialog was derived from changes, and the kind's comparators
//      (harness/dialog-contract.ts) agree — the same screen re-derived is the same dialog, a
//      perturbed one fails the COMMITTING comparison. That is precisely what the race guard
//      (lib/dialog-guard.ts) leans on to refuse a tap on a stale render; an adapter that emits a
//      constant signature would disable it silently. A kind the adapter never emits registers a todo.
//
//   6. THE WALK PAIRS (ADR 0080 point 5, harness/walk-pairs.ts): a grammar whose pointed list is walked
//      must keep its dialog's identity while the pointer moves: the corpus must hold two real captures
//      of the dialog with the pointer on different rows, and they must be `promptsSameIdentity`. The
//      ratchet fails for any fixture whose grammar has neither such a pair nor a listed gap.
//
// Pure + offline: it drives the adapter over the byte-faithful fixture corpus (web/src/fixtures/
// panes/*.txt) through the same parseAnsi → splitLines pipeline the renderer uses. It never touches
// a pane or the network (guard.ts owns that), so it can gate a read-only Tier-1 lift from fixtures
// alone.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../ansi";
import { displayWidth } from "../text-width";
import { lineText, splitLines, type Block, type MultiSelectModel, type StyledLine } from "../blocks";
import type { HarnessAdapter } from "./types";
import { withUnreadDialog } from "./index";
import {
  commitKeysFor,
  identityDiff,
  promptsEqual,
  promptsSameIdentity,
  sameKeys,
  splitWalk,
  type PromptModel,
} from "./prompt-model";
import { WALK_GAPS, WALK_PAIRS, walkGroupKey } from "./walk-pairs";
// The bridge's own verifier, imported so the phone's `styledSignature` is checked against what the
// bridge really computes from the same bytes (a web test may import the bridge's pure modules; the
// bridge imports web/src/lib/styled-region.ts the other way, and neither pulls a cycle).
import { verifyExpectedStyled, verifyPromptBinding } from "../../../../bridge/prompt-binding.ts";
import { cropRawColumns, type ColumnRange } from "../column-range";
import { MAX_TAIL_LINES } from "../tail-lines";
import { trailingTaskChecklistStart } from "../task-checklist";
import { findInputFrame, plainRows } from "../surface/frame";
import { loadProfiles, requireProfile } from "../surface/profile";
import {
  DIALOG_CONTRACT,
  dialogComparators,
  dialogModelOf,
  type DialogKind,
  type DialogModels,
} from "./dialog-contract";
import {
  WIZARD_BACK_KEYS,
  WIZARD_CANCEL_KEYS,
  WIZARD_NEXT_KEYS,
  WIZARD_SUBMIT_KEYS,
} from "./wizard-model";
import {
  MENU_DOWN_KEYS,
  MENU_LEFT_KEYS,
  MENU_RIGHT_KEYS,
  MENU_UP_KEYS,
  menuKeyFor,
  readKeyHintFooter,
} from "./menu-hints";

// Anchored on this file's own directory (NOT `new URL(..., import.meta.url)`, which Vite statically
// rewrites into a root-relative asset path) so fixtures resolve regardless of the run cwd. This file
// sits one level ABOVE the per-detector tests, so it's two ".."s to src, not three.
const PANES_DIR = join(import.meta.dirname, "..", "..", "fixtures", "panes");

function loadRaw(name: string): string {
  return readFileSync(join(PANES_DIR, name), "utf8");
}

function loadLines(name: string): StyledLine[] {
  return splitLines(parseAnsi(loadRaw(name)));
}

// A single unstyled visual line — the minimum an AnsiSegment needs (no colour flags). Used to
// synthesise the trailing output that pushes a dialog off the buffer tail.
function textLine(text: string): StyledLine {
  return { segments: [{ text, style: {}, muted: false }] };
}

// `DEFAULT_PROMPT_TAIL_LINES` in bridge/prompt-binding.ts, plus the steps of its matcher this suite
// has to reproduce to count the rows under a match: the normalisation, the last match, and the two
// cuts at the end of the read (`rowsBelowMatch`). Mirrored rather than imported: the bridge's matcher
// answers a verdict, not a count. Both sides work on ALREADY-parsed text here, so the bridge's SGR
// strip has nothing left to do — what remains is its rstrip and its "blank rows are not rows" rule,
// which is the counting the tail window is expressed in.
const BRIDGE_PROMPT_TAIL_LINES = 6;

function normalizeRegion(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.length > 0);
}

/** Index in `fresh` of the LAST line of the LAST occurrence of `expected`, or -1. */
function lastMatchEnd(fresh: string[], expected: string[]): number {
  if (expected.length === 0) return -1;
  let end = -1;
  for (let start = 0; start <= fresh.length - expected.length; start++) {
    if (expected.every((line, offset) => fresh[start + offset] === line)) {
      end = start + expected.length - 1;
    }
  }
  return end;
}

/** The normalized index of the first row of the footer run a profile names under an input box
 *  (`Frame.volatile.named`), as the bridge finds it: only profiles that declare
 *  `idle.volatile.below.footerRows` are asked, the first whose frame names one decides, or null. */
function namedFooterStart(rows: readonly string[]): number | null {
  for (const profile of loadProfiles().values()) {
    if (profile.idle.volatile.below.footerRows === undefined) continue;
    const first = findInputFrame(plainRows(rows), profile.idle)?.volatile.named[0];
    if (first === undefined) continue;
    return rows.slice(0, first.row).filter((row) => row.replace(/\s+$/, "").length > 0).length;
  }
  return null;
}

/**
 * The non-blank rows the bridge counts below the last match of `expected` in a read of `rows`, or null
 * when the read does not hold it (bridge/prompt-binding.ts `matchText`). A task checklist that ends the
 * read is not counted. Nor is the footer run a profile names under its box, cut only when the read
 * would be refused `not_in_tail` without the cut, the uncut count kept when the cut leaves the match
 * unfound or still out of the tail. A generic footer (`Frame.volatile.footer`) is never cut.
 */
function rowsBelowMatch(
  rows: readonly string[],
  expected: string[],
  tailLines: number = BRIDGE_PROMPT_TAIL_LINES,
): number | null {
  const read = normalizeRegion(rows.join("\n"));
  const end = trailingTaskChecklistStart(read) ?? read.length;
  const matchEnd = lastMatchEnd(read.slice(0, end), expected);
  if (matchEnd === -1) return null;
  const below = end - 1 - matchEnd;
  if (below < tailLines) return below;
  const footer = namedFooterStart(rows);
  if (footer === null || footer >= end) return below;
  const aboveFooter = lastMatchEnd(read.slice(0, footer), expected);
  if (aboveFooter === -1 || footer - 1 - aboveFooter >= tailLines) return below;
  return footer - 1 - aboveFooter;
}

// A couple of lines of ordinary agent output to append below a dialog. They must be NON-blank (a
// trailing blank run is trimmed off the tail by every detector, which would re-expose the footer)
// and must not themselves look like a menu footer or option row — so appending them makes the
// dialog's footer no longer the last non-blank line, and every tail-anchored detector bails.
function trailingOutput(): StyledLine[] {
  return [textLine("● Wrote the file"), textLine("  ⎿  done")];
}

/** The FIRST row of the tail's key-hint footer, which is the last non-blank row on a wide pane and
 *  the top of the wrapped group on a narrow one. Falls back to the last non-blank row for a tail
 *  that is not a key-hint footer at all. */
function footerTop(lines: StyledLine[]): number {
  return readKeyHintFooter(lines.map(lineText))?.startLine ?? lastNonBlank(lines);
}

/** The index of the last non-blank line — where every tail-anchored grammar's footer sits. */
function lastNonBlank(lines: StyledLine[]): number {
  let i = lines.length - 1;
  while (i >= 0 && lines[i]!.segments.map((s) => s.text).join("").trim() === "") i--;
  return i < 0 ? lines.length : i;
}

/** Whether a block is a menu lifted off a notice above a live box (`MenuModel.liveBox`). */
function isNoticeMenu(block: Block): boolean {
  return block.kind === "menu" && block.menu.liveBox !== undefined;
}

/** Whether a block is the keyless card a titled box above the live input box lifts as. */
function isBoxText(block: Block): boolean {
  return block.kind === "box-text";
}

/** The notice heads a profile marks `letters`: a card lifted off one of them prints single letters, not digits. */
const LETTERED_HEADS = [...loadProfiles().values()].flatMap((profile) =>
  (profile.idle.notices ?? []).filter((notice) => notice.letters === true).map((notice) => new RegExp(notice.head, "u")),
);

/** A keyed item as a row prints it: a letter or a digit after a space, the row's start or a separator glyph, then a colon or a parenthesis. */
const PRINTED_KEY = /(?:^|[\s|│·•])([A-Za-z0-9])[:)]/gu;

/**
 * The keys a notice card's trailing key block printed, top row first: walking up from the card's last
 * row, each row while it holds a printed key. When every row under the head holds one, the head row's
 * keys printed after the card's title count too (an inline head, `✦ Dismissed.   1: …`).
 */
function printedNoticeKeys(rows: readonly string[], title: string): string[] {
  const keyed = (text: string): string[] => [...text.matchAll(PRINTED_KEY)].map((m) => m[1]!);
  const keys: string[][] = [];
  for (let row = rows.length - 1; row > 0; row--) {
    const found = keyed(rows[row]!);
    if (found.length === 0) break;
    keys.unshift(found);
  }
  if (keys.length === rows.length - 1) {
    const head = rows[0]!.trim().replace(/^\S+\s+/u, "");
    keys.unshift(keyed(head.startsWith(title) ? head.slice(title.length) : head));
  }
  return keys.flat();
}

/** The signatures of every menu block in a build — the race guard's freshness token, in order. */
function menuSignatures(blocks: Block[]): string[] {
  return blocks.flatMap((b) => (b.kind === "menu" ? [b.menu.signature] : []));
}

/** Every interactive block kind, in the order the contract table declares them. A kind added to
 *  `DialogModels` without a fixture that lifts it registers a todo below, never a silent pass. */
// SAFETY: `DIALOG_CONTRACT` is annotated `DialogContract`, a mapped type whose keys ARE exactly
// `DialogKind` — so its own keys are that union and nothing else. `Object.keys` is only weakly typed
// because a wider object could be assigned; this table is a literal declared right here.
const DIALOG_KINDS = Object.keys(DIALOG_CONTRACT) as DialogKind[];

/** The models of `kind` the adapter lifts from `name`, in order (usually 0 or 1 — a grammar claims at
 *  most one tail dialog). Re-parses the fixture on every call, which is the point: the race guard
 *  re-derives from scratch on every tap, so the invariants must hold on a fresh derivation. */
function modelsOf<K extends DialogKind>(
  adapter: HarnessAdapter,
  name: string,
  kind: K,
): DialogModels[K][] {
  return modelsIn(adapter.buildBlocks(loadLines(name)), kind);
}

function modelsIn<K extends DialogKind>(blocks: Block[], kind: K): DialogModels[K][] {
  return blocks.flatMap((b) => {
    const model = dialogModelOf(b, kind);
    return model === null ? [] : [model];
  });
}

/** Change one letter of line `i` that lies inside `columns`, keeping its width and every style. A model
 *  read from a column range (`bindColumns`) ignores what lies outside it, so the marker
 *  {@link perturbLine} appends at the row's end would land beside the dialog, not in it. Null when
 *  the row has no ASCII letter in range. */
function perturbLineInColumns(lines: StyledLine[], i: number, columns: ColumnRange): StyledLine[] | null {
  let column = 0;
  const segments = lines[i]!.segments;
  for (let s = 0; s < segments.length; s++) {
    const chars = Array.from(segments[s]!.text);
    for (let c = 0; c < chars.length; c++) {
      if (column >= columns.start && column < columns.end && /[a-z]/.test(chars[c]!)) {
        chars[c] = chars[c] === "q" ? "x" : "q";
        const copy = [...lines];
        copy[i] = { ...lines[i]!, segments: segments.with(s, { ...segments[s]!, text: chars.join("") }) };
        return copy;
      }
      column += displayWidth(chars[c]!);
    }
  }
  return null;
}

/** Change visible text without discarding style-only dialog identity. The in-text probe keeps
 * fixed-width borders intact when appending outside the box would invalidate the grammar. */
function perturbLine(lines: StyledLine[], i: number, withinText: boolean): StyledLine[] {
  const segments = [...lines[i]!.segments];
  if (withinText) {
    const at = segments.findLastIndex((segment) => /[\p{L}\p{N}]/u.test(segment.text));
    if (at < 0) return lines;
    const segment = segments[at]!;
    segments[at] = {
      ...segment,
      text: segment.text.replace(/[\p{L}\p{N}]/u, (char) => char === "z" ? "x" : "z"),
    };
  } else {
    segments.push({ text: " zqx", style: {}, muted: false });
  }
  const copy = [...lines];
  copy[i] = { segments };
  return copy;
}

// How far ABOVE the lifted region a perturbation may reach. Every grammar folds a bounded run of
// lines above its first option into the signature (the dialog's SUBJECT — the diff, command, or
// prompt it is about, which is what tells two same-shaped dialogs apart), and for the preview variant
// that subject is the ONLY thing the core signature takes in full: its option rows contribute their
// left column, and the preview pane / notes line are normalised out by design. So a probe confined to
// the region would find nothing to move there, and would be testing the normalisation rather than the
// guard. Sized past every grammar's own lookback.
const PERTURB_LOOKBACK = 60;

/**
 * Perturb ONE row the model was derived from and return the re-derived model, or null when no row
 * works. Rows are tried region-first, then upward into the subject lines above it, until one both
 * keeps the dialog liftable and moves its signature.
 *
 * The invariant is that SOME visible text the user is looking at reaches the signature — not that
 * every row does: a signature that ignored the pointer column would be right to (the choreography
 * moves it), while one that ignored everything would silently disable the race guard.
 *
 * The footer (the last non-blank line) is never perturbed: every grammar is tail-anchored on it, so
 * touching it tests detection, not the signature.
 */
function perturbRegion<K extends DialogKind>(
  adapter: HarnessAdapter,
  name: string,
  kind: K,
): DialogModels[K] | null {
  const lines = loadLines(name);
  const blocks = adapter.buildBlocks(lines);
  const count = modelsIn(blocks, kind).length;
  const region = blocks.find((b) => dialogModelOf(b, kind) !== null)!;
  const start = lines.length - region.lines.length; // the region is the buffer's tail slice
  const footer = lastNonBlank(lines);
  const signature = DIALOG_CONTRACT[kind].signature;
  const tapped = modelsIn(blocks, kind).at(-1)!;
  const before = signature(tapped);
  const columns = dialogComparators(kind).columns?.(tapped);

  const candidates = [
    ...range(start, lines.length), // the region itself, top-down
    ...range(Math.max(0, start - PERTURB_LOOKBACK), start).toReversed(), // then upward into the subject
  ];
  for (const i of candidates) {
    if (i === footer) continue;
    if (lineIsBlank(lines[i]!)) continue;
    for (const withinText of [false, true]) {
      const perturbed =
        columns === undefined ? perturbLine(lines, i, withinText) : perturbLineInColumns(lines, i, columns);
      if (perturbed === null) continue;
      const after = modelsIn(adapter.buildBlocks(perturbed), kind);
      if (after.length !== count) continue; // this row is load-bearing for detection — try another
      if (signature(after.at(-1)!) !== before) return after.at(-1)!;
    }
  }
  return null;
}

/**
 * Whether ANY single-row perturbation of the dialog's region (as {@link perturbRegion} makes them) still
 * lifts the same number of models with the SAME signature: the race guard would be blind to that change.
 * For a dialog with no free-text row the answer must be false, because every change stops the lift.
 */
function perturbationsLeaveItBlind<K extends DialogKind>(adapter: HarnessAdapter, name: string, kind: K): boolean {
  const lines = loadLines(name);
  const blocks = adapter.buildBlocks(lines);
  const count = modelsIn(blocks, kind).length;
  const region = blocks.find((b) => dialogModelOf(b, kind) !== null)!;
  const start = lines.length - region.lines.length;
  const footer = lastNonBlank(lines);
  const signature = DIALOG_CONTRACT[kind].signature;
  const before = signature(modelsIn(blocks, kind).at(-1)!);
  for (const i of range(start, lines.length)) {
    if (i === footer || lineIsBlank(lines[i]!)) continue;
    for (const withinText of [false, true]) {
      const perturbed = perturbLine(lines, i, withinText);
      if (perturbed === lines) continue; // a row with no letter or digit: nothing to change
      const after = modelsIn(adapter.buildBlocks(perturbed), kind);
      if (after.length === count && signature(after.at(-1)!) === before) return true;
    }
  }
  return false;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);
}

function lineIsBlank(line: StyledLine): boolean {
  return line.segments.map((s) => s.text).join("").trim().length === 0;
}

/** Every non-raw block — i.e. an interactive dialog the adapter lifted out of the raw mirror.
 *  Kind-agnostic (`kind !== "raw"`) so a newly-added block kind counts as interactive automatically. */
function interactiveBlocks(blocks: Block[]): Block[] {
  return blocks.filter((b) => b.kind !== "raw");
}

// Herdr's verified pane.send_keys grammar (HERDR_API.md + project CLAUDE.md). Bare special keys are
// case-insensitive; a lone character is typed literally; modifiers join with `+`.
const SPECIAL_KEYS = new Set([
  "up",
  "down",
  "left",
  "right",
  "tab",
  "enter",
  "escape",
  "space",
  "backspace",
  "bs",
]);
// Explicitly rejected by Herdr (any spelling → invalid_key): no paging or forward-delete via keys.
const UNSUPPORTED_KEYS = new Set(["pageup", "pagedown", "home", "end", "insert", "delete"]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "cmd", "super"]);

/**
 * Whether `key` is a keystroke Herdr's `pane.send_keys` accepts. A key is valid when it is a single
 * literal character (digit/letter/punct), a bare special key (`Enter`, `Up`, `shift`-less `Tab`, …),
 * a function key `F1`–`F12`, or a `+`-joined modifier chord (`ctrl+c`, `shift+tab`, `ctrl+left`).
 * Rejects multi-char digit runs (`"10"`) and the unsupported paging/edit keys — the two ways a
 * detector could emit an unsendable plan.
 */
export function isValidHerdrKey(key: string): boolean {
  if (key.length === 0) return false;
  const lower = key.toLowerCase();
  if (UNSUPPORTED_KEYS.has(lower)) return false;
  if (key.length === 1) return true; // a single literal character (digit, letter, punctuation)
  if (SPECIAL_KEYS.has(lower)) return true; // a bare special key (case-insensitive)
  if (/^f([1-9]|1[0-2])$/i.test(key)) return true; // F1..F12
  const parts = lower.split("+");
  if (parts.length < 2 || parts.some((p) => p.length === 0)) return false;
  const last = parts[parts.length - 1]!;
  const mods = parts.slice(0, -1);
  if (!mods.every((m) => MODIFIERS.has(m))) return false;
  if (last.length === 1) return true; // ctrl+c, shift+a
  return SPECIAL_KEYS.has(last) && !UNSUPPORTED_KEYS.has(last); // shift+tab, ctrl+left
}

// NON-interactive block kinds (like `raw`) that carry no keystrokes and so need no key walk. A new
// INTERACTIVE kind that lands without a case below must FAIL the suite (see the default branch), not
// slip through as a silent `null`; only a deliberately keyless kind belongs in this allowlist.
//
// `autocomplete` is one: the agent's completion popup is painted while its input box is LIVE under it
// (harness/autocomplete-model.ts), so the block emits nothing, races nothing, and has no row in the
// dialog contract. Its fixtures still take the fail-closed and tail-anchoring legs above, which is
// where a popup grammar could actually do harm.
//
// `box-text` is the other: the Authentication box's text and links are shown, and nothing is sent.
const KEYLESS_FUTURE_KINDS = new Set<string>(["autocomplete", "box-text"]);

/**
 * Every keystroke an interactive block's own controls can emit: {@link emittableKeySends} without the
 * keys an action recipe adds (`recipe`) and without the steps. `null` = a keyless kind (`raw`, or a
 * future entry in KEYLESS_FUTURE_KINDS) whose keys needn't be validated.
 */
export function emittableKeys(block: Block): string[] | null {
  return emittableKeySends(block)?.flatMap((send) => (send.recipe ? [] : [send.key])) ?? null;
}

/**
 * What one emittable key does in its recipe, which is what decides whether the screen had to print it
 * (ADR 0151 rule 2) and which named exception may cover it when it did not (rule 3):
 *  - `key`: a key the block sends as itself, a row's own key, a footer action, a control constant;
 *  - `walk`: an arrow of a pointer walk, licensed by the pointer the grammar read (rule 2);
 *  - `nav`: a menu's arrow, printed as an arrow or licensed by a pointer on the dialog's rows;
 *  - `commit`: the key that commits a walked row or a typed answer (`splitWalk`'s commit);
 *  - `edge`: the sticky arrow `commitKeysFor` adds on a list declared `clampedEnds` (rule 6);
 *  - `feedback-commit`: the Enter that submits Claude's typed plan feedback (`submitPromptFeedback`);
 *  - `clear`: an edit key that empties a field Collie types into (`clearField`, the note sweep);
 *  - `cancel`: the unread-dialog card's declared key (`HarnessAdapter.cancelKey`, ADR 0053).
 */
export type KeyStep = "key" | "walk" | "nav" | "commit" | "edge" | "feedback-commit" | "clear" | "cancel";

/** One key a lifted block can emit, and the step of its recipe that sends it. `recipe` marks a key an
 *  action module sends beyond the plans the block's model carries (an edge arrow, the feedback row's
 *  Enter, an answer field's walk, clear and commit): {@link emittableKeys} leaves those out, so it stays
 *  the keys the screen's own controls offer, which the capture-lab corpus table pins. */
export interface KeySend {
  readonly key: string;
  readonly step: KeyStep;
  readonly recipe?: true;
}

const sends = (step: KeyStep, keys: readonly string[]): KeySend[] => keys.map((key) => ({ key, step }));

/** {@link sends} for keys an action recipe adds beyond the model's own plans. */
const recipeSends = (step: KeyStep, keys: readonly string[]): KeySend[] =>
  keys.map((key) => ({ key, step, recipe: true }));

/** A walk-class plan split into its walk and its commit, a plan of any other shape as plain keys. */
function planSends(keys: readonly string[]): KeySend[] {
  const plan = splitWalk([...keys]);
  if (plan === null) return sends("key", keys);
  return [...sends("walk", plan.walk), ...sends("commit", plan.commit)];
}

/** The keys of an answer field's recipe (lib/answer-field.ts, ADR 0113): its digit while it is empty,
 *  the verified `Up`/`Down` walk onto a filled one, the `ctrl+u ctrl+k` clear, and, where the caller
 *  commits, the `Enter` that answers. */
function answerFieldSends(key: string, commits: boolean): KeySend[] {
  return [
    ...recipeSends("key", [key]),
    ...recipeSends("walk", ["Up", "Down"]),
    ...recipeSends("clear", ["ctrl+u", "ctrl+k"]),
    ...(commits ? recipeSends("commit", ["Enter"]) : []),
  ];
}

function promptSends(model: PromptModel): KeySend[] {
  const options = model.options.flatMap((option, index) => {
    if (splitWalk(option.keys) === null) return sends("key", option.keys);
    const commit = commitKeysFor(model, index);
    return [...planSends(option.keys), ...recipeSends("edge", commit.slice(0, -1))];
  });
  const row = model.feedback;
  if (row === undefined || row.purpose === "free-text") return options;
  if (row.purpose === "answer") return [...options, ...answerFieldSends(row.key, true)];
  return [...options, ...recipeSends("key", [row.key]), ...recipeSends("feedback-commit", ["Enter"])];
}

/**
 * Every key an interactive block can emit, each with the step of its recipe that sends it, walked off
 * its model and the family's control constants. `null` = a keyless kind (`raw`, or a future entry in
 * KEYLESS_FUTURE_KINDS). An interactive kind with no case here THROWS, so neither the key-grammar leg
 * nor the printed-key leg can go silently vacuous when a new dialog kind ships.
 */
export function emittableKeySends(block: Block): KeySend[] | null {
  switch (block.kind) {
    case "raw":
      return null;
    case "prompt-select":
      return promptSends(block.prompt);
    case "wizard": {
      // Both phases can navigate steps; the review phase's controls ARE submit/cancel, the plans the
      // model declares or the 1/2 constants.
      const nav = sends("key", [...WIZARD_BACK_KEYS, ...WIZARD_NEXT_KEYS]);
      const wizard = block.wizard;
      if (wizard.phase === "question") {
        return [
          ...wizard.options.flatMap((o) => planSends(o.keys)),
          ...nav,
          ...sends("key", [...WIZARD_SUBMIT_KEYS, ...WIZARD_CANCEL_KEYS]),
          ...(wizard.field === undefined ? [] : answerFieldSends(wizard.field.key, true)),
        ];
      }
      return [
        ...nav,
        ...sends("key", wizard.submitKeys ?? WIZARD_SUBMIT_KEYS),
        ...sends("key", wizard.cancelKeys ?? WIZARD_CANCEL_KEYS),
      ];
    }
    case "preview-select":
      // preview-action.ts's recipe: a digit moves the pointer, Enter selects, `n` opens the note
      // input, ctrl+k and a Backspace sweep clear it, Escape blurs; a wizard step navigates with
      // Left/Right.
      return [
        ...sends("key", block.preview.options.map((o) => String(o.n))),
        ...sends("key", ["Enter", "n", "Escape"]),
        ...(block.preview.steps === null ? [] : sends("key", [...WIZARD_BACK_KEYS, ...WIZARD_NEXT_KEYS])),
        ...sends("clear", ["ctrl+k", "Backspace"]),
      ];
    case "multi-select": {
      // checkbox: a digit toggles each option (and the "Chat about this" escape) in digit mode, or
      // jumps the pointer there in pointer mode, plus the pointer's Up/Down and the Enter on the advance
      // row; a declared `advanceKeys` plan rides too, and a modelled answer field's recipe (no commit:
      // the filled row stays ticked). review: the confirm screen's `1. Submit answers / 2. Cancel` in
      // digit mode, a pointer walk + Enter in pointer mode, or the declared plans in keys mode, plus
      // the declared way back.
      const multi = block.multi;
      if (multi.phase === "checkbox") {
        return [
          ...sends("key", multi.options.map((o) => String(o.n))),
          ...(multi.escape ? sends("key", [String(multi.escape.n)]) : []),
          ...sends("walk", ["Up", "Down"]),
          ...sends("commit", ["Enter"]),
          ...sends("key", multi.advanceKeys ?? []),
          ...(multi.field === undefined ? [] : answerFieldSends(String(multi.field.n), false)),
        ];
      }
      return [...reviewActionSends(multi), ...sends("key", multi.backKeys ?? [])];
    }
    case "menu":
      // The generic grammar emits ONLY the keys the screen's own footer named, plus the arrows it
      // advertised. Walking `actions` here is what pins .adr/0009's ban in CI: a digit can only
      // appear in this list if the detector synthesised one, and the key-grammar leg would still pass
      // it as a valid Herdr key — so the menu-grammar tests assert the absence directly, and the
      // printed-key leg checks the screen named each one.
      return [
        ...sends("key", block.menu.actions.flatMap((a) => a.keys)),
        ...sends("nav", [
          ...(block.menu.nav.upDown ? [...MENU_UP_KEYS, ...MENU_DOWN_KEYS] : []),
          ...(block.menu.nav.leftRight !== undefined ? [...MENU_LEFT_KEYS, ...MENU_RIGHT_KEYS] : []),
        ]),
      ];
    case "unread-dialog":
      // The card's ONE control, and it is a DECLARATION (HarnessAdapter.cancelKey), not something
      // read off the screen. `adapter.buildBlocks` never emits this kind: the printed-key leg runs the
      // post-pass (`withUnreadDialog`) over each capture to reach it.
      return sends("cancel", [block.cancel.key]);
    default: {
      // SAFETY: `block` is `never` here today — every kind is cased above — so widening it back to
      // `Block` cannot be wrong for any value that exists. The assertion is what names the offending
      // kind at runtime once a FUTURE Block kind is added to the union without a case here: a keyless
      // one is tolerated via the allowlist; any other (an interactive block whose keys aren't being
      // validated) fails loudly so the key-grammar invariant can't go vacuous.
      const kind = (block as Block).kind;
      if (KEYLESS_FUTURE_KINDS.has(kind)) return null;
      throw new Error(`conformance: unmodelled interactive block kind "${kind}" — extend emittableKeys`);
    }
  }
}

/** The keys a multi-select review's submit and cancel can send, per its `submit` recipe. */
function reviewActionSends(multi: Extract<MultiSelectModel, { phase: "review" }>): KeySend[] {
  if (multi.submit === "pointer") return [...sends("walk", ["Up", "Down"]), ...sends("commit", ["Enter"])];
  if (multi.submit === "keys") return sends("key", [...multi.submitKeys, ...multi.cancelKeys]);
  return sends("key", ["1", "2"]);
}

/** A live probe that verified a declared key on one screen of a harness, and where it is recorded. */
export interface LiveProbe {
  readonly harness: string;
  readonly screen: string;
  readonly record: string;
}

/**
 * One named exception of ADR 0151 rule 3: a dialog or an action step that sends a key no screen printed.
 * `steps` and `title` are what the printed-key leg matches a key against: the step of the recipe that
 * sends it ({@link KeyStep}), and, for an exception scoped to one dialog, that dialog's own title (a
 * prompt's caption or question, a menu's title). `probes` names the live probes behind a declared key.
 */
export interface UnprintedKeyException {
  readonly letter: "a" | "b" | "c" | "d" | "e" | "f" | "g";
  readonly harnesses: readonly string[];
  readonly dialog: string;
  readonly steps: readonly KeyStep[];
  readonly title?: RegExp;
  readonly keys: readonly string[];
  readonly files: readonly string[];
  readonly probes?: readonly LiveProbe[];
}

/**
 * THE CLOSED LIST of keys Collie sends that the screen did not print (ADR 0151 rule 3, a to g). A key
 * a lifted block can emit that is neither printed on its screen nor matched here fails the printed-key
 * leg. A new exception changes this list, the pinned test in conformance.test.ts and ADR 0151 in one
 * commit. File paths are from the repository root.
 */
export const UNPRINTED_KEY_EXCEPTIONS: readonly UnprintedKeyException[] = [
  {
    letter: "a",
    harnesses: ["claude"],
    dialog: "the /resume session picker commits the walked row with an Enter its footer never prints",
    steps: ["commit"],
    title: /^Resume session\b/u,
    keys: ["Enter"],
    files: ["web/src/lib/harness/claude/resume.ts"],
  },
  {
    letter: "b",
    harnesses: ["claude"],
    dialog: "the \"Switch model?\" confirmation prints no footer: a tap is the pointer walk, then Enter",
    steps: ["commit"],
    title: /^Switch model\?/u,
    keys: ["Enter"],
    files: ["web/src/lib/harness/claude/switch-model.ts"],
  },
  {
    letter: "c",
    harnesses: ["claude"],
    dialog: "the plan dialog's feedback row: the typed text is submitted with an Enter the footer does not print",
    steps: ["feedback-commit"],
    keys: ["Enter"],
    files: ["web/src/lib/prompt-action.ts"],
  },
  {
    letter: "d",
    harnesses: ["agy", "antigravity"],
    dialog: "the /artifact review: Enter on a row, and Tab then Enter for Submit",
    steps: ["key"],
    title: /artifact/iu,
    keys: ["Enter", "Tab"],
    files: ["web/src/lib/harness/agy/artifact.ts"],
  },
  {
    letter: "e",
    harnesses: ["omp", "kiro", "claude"],
    dialog: "an edge row of a list declared clampedEnds commits with one more arrow toward the edge",
    steps: ["edge"],
    keys: ["Up", "Down"],
    files: [
      "web/src/lib/harness/prompt-model.ts",
      "web/src/lib/harness/omp/approval.ts",
      "web/src/lib/harness/kiro/workspace-trust.ts",
      "web/src/lib/harness/claude/first-run-theme.ts",
    ],
  },
  {
    letter: "f",
    harnesses: ["agy", "antigravity", "claude", "codex", "grok", "hermes", "kiro", "muse", "omp", "opencode", "pi"],
    dialog: "the unread-dialog card offers its adapter's declared cancel key, on the adapter's own modal evidence",
    steps: ["cancel"],
    keys: ["Escape", "ctrl+c"],
    files: [
      "web/src/lib/harness/index.ts",
      "web/src/lib/harness/agy/index.ts",
      "web/src/lib/harness/claude/index.ts",
      "web/src/lib/harness/codex/index.ts",
      "web/src/lib/harness/grok/index.ts",
      "web/src/lib/harness/hermes/index.ts",
      "web/src/lib/harness/kiro/index.ts",
      "web/src/lib/harness/muse/index.ts",
      "web/src/lib/harness/omp/index.ts",
      "web/src/lib/harness/opencode/index.ts",
      "web/src/lib/harness/pi/index.ts",
    ],
    // Hermes declares ctrl+c. The 2026-10-16 live probe verified it on the clarify and approval
    // panels, where Hermes binds no Escape. The command palette prints "Esc cancels" and has no probe
    // listed here: hermes.test.ts holds that case open until the palette is probed live.
    probes: [
      { harness: "hermes", screen: "clarify panel", record: "web/src/lib/harness/hermes/CLARIFY_NOTES.md" },
      { harness: "hermes", screen: "approval panel", record: "web/src/lib/harness/hermes/APPROVAL_NOTES.md" },
    ],
  },
  {
    letter: "g",
    harnesses: ["claude"],
    dialog: "a field Collie types into is cleared with edit keys: AskUserQuestion's ctrl+u ctrl+k, the preview note's ctrl+k and Backspace sweep",
    steps: ["clear"],
    keys: ["ctrl+u", "ctrl+k", "Backspace"],
    files: ["web/src/lib/answer-field.ts", "web/src/lib/preview-action.ts"],
  },
];

/** The title a dialog names itself by: a prompt's caption or question, a menu's title, a step's
 *  question. Empty for the unread card, which reads nothing off the screen. */
function blockTitle(block: Block): string {
  switch (block.kind) {
    case "prompt-select":
      return block.prompt.caption ?? block.prompt.question;
    case "menu":
      return block.menu.title;
    case "wizard":
      return block.wizard.phase === "question" ? block.wizard.question : "";
    case "multi-select":
      return block.multi.phase === "checkbox" ? block.multi.question : "";
    default:
      return "";
  }
}

/** The exception of {@link UNPRINTED_KEY_EXCEPTIONS} that covers `send` on `block` of `agent`, or null. */
export function unprintedKeyException(agent: string, block: Block, send: KeySend): UnprintedKeyException | null {
  const title = blockTitle(block);
  return (
    UNPRINTED_KEY_EXCEPTIONS.find(
      (entry) =>
        entry.harnesses.includes(agent) &&
        entry.steps.includes(send.step) &&
        entry.keys.includes(send.key) &&
        (entry.title === undefined || entry.title.test(title)),
    ) ?? null
  );
}

/** Key names a screen prints, each mapped to the Herdr key it names (lower case). The keycap glyphs are
 *  the ones the harnesses draw: `⎋ ⏎ ⇥`, and omp's Nerd Font caps (`omp/keycaps.ts`). */
const NAMED_KEYS: readonly [RegExp, readonly string[]][] = [
  [/\besc(?:ape)?\b|⎋|\u{F12B7}/iu, ["escape"]],
  [/\b(?:enter|return)\b|[⏎↵\u{F0311}]/iu, ["enter"]],
  [/\bshift\s*\+?\s*tab\b|⇧\s*(?:tab|⇥)/iu, ["shift+tab"]],
  [/\btab\b|[⇥\u{F0312}]/iu, ["tab"]],
  [/\bspace\b|␣/iu, ["space"]],
  [/\bbackspace\b|⌫/iu, ["backspace"]],
  [/[↑▲]|\bup\s*\/\s*down\b/iu, ["up"]],
  [/[↓▼]|\bup\s*\/\s*down\b/iu, ["down"]],
  [/[←◀]|\bleft\s*\/\s*right\b/iu, ["left"]],
  [/[→▶]|\bleft\s*\/\s*right\b/iu, ["right"]],
];

/** A modifier chord a screen prints: `ctrl+c`, `Ctrl-C`, `⌃C`, `^C`. */
const PRINTED_CHORD = /(?:\bctrl|\bcontrol|⌃)\s*[+-]?\s*([a-z])\b|\^([A-Za-z])\b/giu;

/** A row's own key: a digit or a letter at the row's start or after a space, a pointer, a gutter or a
 *  bracket, then `.`, `)`, `]`, `:` or a spaced `(` (a numbered option `1.`, a notice's `1:`, a hotkey
 *  `(y)` or `[n]`, Grok's `1 (○) Red`). */
const PRINTED_ROW_KEY = /(?:^|[\s❯›>│┃([])([A-Za-z0-9])(?:[.):\]]|\s+\()/gu;

/** A row's own key standing apart from its label by two or more spaces, at the row's head (Muse's
 *  `> 1  Trust and continue`) or at its end (Grok's `Yes, proceed            y`). */
const PRINTED_SPACED_KEY = /^[\s❯›>│┃]*([A-Za-z0-9])\s{2,}\S|\S\s{2,}([A-Za-z0-9])\s*$/u;

/** A letter hotkey a hint prints: `y/n`, `p Preview`, `n to add notes`, Muse's `1/2`. The key stands alone after
 *  the row's start, a space or a separator, and is followed by `/<letter>`, ` to `, ` for `, or a capitalised
 *  word (the `y/n Approve/reject · p Preview` footer dialect). */
const PRINTED_HINT_LETTER = /(?:^|[\s·•|│])([a-z])(?=\/[a-z]\b|\s+(?:to|for)\s|\s+[A-Z])|(?<=\b[a-z0-9]\/)([a-z0-9])\b|\b([0-9])(?=\/[0-9]\b)/gu;

/**
 * The keys `rows` print, as lower-case Herdr keys: the names of special keys (Esc, Enter, Tab, an arrow
 * glyph), modifier chords, and the digit or letter a row or a hint prints as its own key. This is what
 * "printed" means in ADR 0151 rule 2; the pointer's arrows are licensed separately (`walk` steps).
 */
export function printedKeys(rows: readonly string[]): Set<string> {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const [pattern, named] of NAMED_KEYS) if (pattern.test(row)) named.forEach((k) => keys.add(k));
    for (const m of row.matchAll(PRINTED_CHORD)) keys.add(`ctrl+${(m[1] ?? m[2]!).toLowerCase()}`);
    for (const m of row.matchAll(PRINTED_ROW_KEY)) keys.add(m[1]!.toLowerCase());
    for (const m of row.matchAll(PRINTED_HINT_LETTER)) keys.add((m[1] ?? m[2] ?? m[3]!).toLowerCase());
    const spaced = PRINTED_SPACED_KEY.exec(row);
    if (spaced !== null) keys.add((spaced[1] ?? spaced[2]!).toLowerCase());
  }
  return keys;
}

/** A key one of `blocks` can emit that its screen did not print and no exception covers. */
export interface UnprintedKey {
  readonly kind: Block["kind"];
  readonly title: string;
  readonly step: KeyStep;
  readonly key: string;
}

/** The rows a block's model was derived from, as its bound region holds them: a grammar may lift a
 *  block narrower than the rows it read (Codex's options sit above its region's first row). */
function regionRows(block: Block): string[] {
  return DIALOG_KINDS.flatMap((kind) => {
    const model = dialogModelOf(block, kind);
    return model === null ? [] : dialogComparators(kind).region(model).split("\n");
  });
}

/** A pointer drawn at the head of a row (after any gutter): the mark that licenses a list's arrows. */
const POINTER_ROW = /^[\s│┃]*[❯›▸►>\u{F054}]\s/u;

/**
 * Every key `blocks` can emit that is neither printed on the dialog's rows nor licensed by its pointer
 * (a `walk` arrow, or a menu's `nav` arrow under a pointed row) nor covered by an entry of
 * {@link UNPRINTED_KEY_EXCEPTIONS} for `agent`. The dialog's rows are its block's lines, every row
 * below them to the screen's end (a dialog is tail-anchored, and its footer may sit under its block),
 * and the rows of its bound region.
 */
export function unprintedKeys(agent: string, blocks: readonly Block[]): UnprintedKey[] {
  const out: UnprintedKey[] = [];
  blocks.forEach((block, at) => {
    if (block.kind === "raw") return;
    const rows = [...blocks.slice(at).flatMap((b) => b.lines.map(lineText)), ...regionRows(block)];
    const printed = printedKeys(rows);
    const pointed = block.lines.map(lineText).some((row) => POINTER_ROW.test(row));
    for (const send of emittableKeySends(block) ?? []) {
      if (send.step === "walk") continue;
      if (send.step === "nav" && pointed) continue;
      if (printed.has(send.key.toLowerCase())) continue;
      if (unprintedKeyException(agent, block, send) !== null) continue;
      const found = { kind: block.kind, title: blockTitle(block), step: send.step, key: send.key };
      if (!out.some((u) => u.title === found.title && u.step === found.step && u.key === found.key)) out.push(found);
    }
  });
  return out;
}

/** The blocks a capture shows: the adapter's own lift, then the unread-dialog post-pass over it. */
export function shownBlocks(adapter: HarnessAdapter, lines: StyledLine[]): Block[] {
  return withUnreadDialog(adapter, lines, adapter.buildBlocks(lines));
}

/**
 * Every key PLAN a block's model declares as data, named by field — as opposed to the plans the
 * action modules derive from rows or constants. Each is sent as one write, so an empty plan is a
 * button that sends nothing, and the suite refuses it (every key in it is also walked by
 * {@link emittableKeys}, which refuses an empty string). Kinds that declare no plans return none.
 */
export function declaredKeyPlans(block: Block): { field: string; keys: string[] }[] {
  const plans: { field: string; keys: string[] | undefined }[] = [];
  if (block.kind === "multi-select" && block.multi.phase === "checkbox") {
    plans.push({ field: "advanceKeys", keys: block.multi.advanceKeys });
  }
  if (block.kind === "multi-select" && block.multi.phase === "review") {
    plans.push(
      { field: "submitKeys", keys: block.multi.submitKeys },
      { field: "cancelKeys", keys: block.multi.cancelKeys },
      { field: "backKeys", keys: block.multi.backKeys },
    );
  }
  if (block.kind === "wizard" && block.wizard.phase === "review") {
    plans.push(
      { field: "submitKeys", keys: block.wizard.submitKeys },
      { field: "cancelKeys", keys: block.wizard.cancelKeys },
    );
  }
  return plans.flatMap((p) => (p.keys === undefined ? [] : [{ field: p.field, keys: p.keys }]));
}

/** The index of the one option whose plan is a bare Enter (the pointed offered row), or null. A label
 *  would not do: two sessions in a resume list can share a title. */
function enterIndex(model: PromptModel): number | null {
  const at = model.options.findIndex((o) => sameKeys(o.keys, ["Enter"]));
  return at < 0 ? null : at;
}

/** Whether any option's plan is a real walk: arrows then Enter, at least one arrow. */
function hasWalkedPlan(model: PromptModel): boolean {
  return model.options.some((o) => (splitWalk(o.keys)?.walk.length ?? 0) > 0);
}

/**
 * Every fixture in the whole corpus that `adapter` lifts into a `prompt-select` model with a walked
 * plan, and that model (the last one at the tail). Read off the adapter over EVERY capture, not off a
 * test file's cohort lists, so a grammar cannot leave its walked dialogs out of the ratchet by filing
 * their captures elsewhere. Another adapter's capture lifts nothing here: that is the fail-closed leg.
 */
function walkedFixtures(adapter: HarnessAdapter): Map<string, PromptModel> {
  const out = new Map<string, PromptModel>();
  for (const name of readdirSync(PANES_DIR).filter((f) => f.endsWith(".txt")).toSorted()) {
    const model = modelsOf(adapter, name, "prompt-select").at(-1);
    if (model !== undefined && hasWalkedPlan(model)) out.set(name, model);
  }
  return out;
}

/**
 * Register the conformance invariants for `adapter` against its fixture cohorts:
 *  - `ownFixtures`     — this adapter's dialog captures (EACH must lift ≥1 interactive block).
 *  - `foreignFixtures` — OTHER adapters' dialog captures (must stay raw — cross-adapter fail-closed).
 *  - `neutralFixtures` — plain shell output / logs with no dialog (must stay raw).
 *
 * Fail-closed on a misfiled fixture: every own fixture must lift an interactive block (checked
 * per-fixture below). A no-dialog capture misfiled into `ownFixtures` would otherwise pass
 * tail-anchoring trivially and never exercise the key-grammar leg — so it is a failure, named by
 * fixture, not silently tolerated.
 */
export function describeAdapterConformance(
  adapter: HarnessAdapter,
  opts: {
    ownFixtures: string[];
    foreignFixtures: string[];
    neutralFixtures: string[];
    /** Captures where the composer is ready but no region can bind: an animated prompt row or one
     *  outside the bridge's tail window. Each one is a named exception
     *  to "a region exists exactly when the composer is ready": the sweep goes out unbound there,
     *  and the list says so in the test output rather than in a silent null. */
    unboundComposerFixtures?: string[];
    /** Dialogs whose region holds no free-text row, so no row can change and still lift (omp's `Allow
     *  tool: goal`: a title, two choices and a footer, nothing else). The perturbation test cannot
     *  find a row that keeps the lift and moves the signature; instead it checks the stronger fact
     *  that EVERY perturbation either stops the lift or moves the signature, never neither. */
    fixedRegionFixtures?: string[];
    /** Captures where a lifted block emits a key the screen did not print and no entry of
     *  UNPRINTED_KEY_EXCEPTIONS names: an OPEN FINDING, fixture to reason. Each runs as an expected
     *  failure (`it.fails`), so it stays visible in the output, and goes red the day the key is printed,
     *  named or no longer sent, when its line here must go. Never a way to add an exception. */
    unprintedKeyFindings?: Readonly<Record<string, string>>;
  },
): void {
  const { ownFixtures, foreignFixtures, neutralFixtures } = opts;
  const unbound = opts.unboundComposerFixtures ?? [];
  const fixedRegion = new Set(opts.fixedRegionFixtures ?? []);

  describe(`HarnessAdapter conformance — ${adapter.agent}`, () => {
    describe("conservative detection (fail-closed on foreign + neutral buffers)", () => {
      const alien: { name: string; cohort: string }[] = [
        ...foreignFixtures.map((name) => ({ name, cohort: "foreign" })),
        ...neutralFixtures.map((name) => ({ name, cohort: "neutral" })),
      ];
      if (alien.length === 0) it.todo("no foreign or neutral fixtures supplied");
      for (const { name, cohort } of alien) {
        it(`${name} (${cohort}) → raw-only, no interactive block`, () => {
          const blocks = adapter.buildBlocks(loadLines(name));
          expect(blocks.length).toBeGreaterThan(0);
          expect(interactiveBlocks(blocks)).toEqual([]);
        });
      }
    });

    describe("own fixtures each lift an interactive block (no misfiled raw capture)", () => {
      if (ownFixtures.length === 0) it.todo("no own dialog fixtures supplied");
      for (const name of ownFixtures) {
        it(`${name}: lifts ≥1 interactive block`, () => {
          const lifted = interactiveBlocks(adapter.buildBlocks(loadLines(name)));
          expect(
            lifted.length,
            `${name} lifted no interactive block — a neutral/raw capture misfiled into ownFixtures?`,
          ).toBeGreaterThan(0);
        });
      }
    });

    // `composerPrompt` is the region a DESTRUCTIVE write gets bound to (harness/types.ts): the reply
    // path hands it to the caller's pre-clear sweep, which passes it as `expected_prompt` so the
    // bridge can 409 a burst aimed at a screen that moved. Its whole value is that it describes the
    // same screen `composerReady` just approved — an adapter that named a region for a screen it
    // refuses would hand out a binding to a pane the pre-flight will not type into, and one that
    // named none for a screen it approves silently downgrades the sweep to an unbound write. Both are
    // caught by requiring the two to agree, on every cohort.
    describe("composerPrompt agrees with composerReady", () => {
      const all = [...ownFixtures, ...foreignFixtures, ...neutralFixtures];
      if (!adapter.composerPrompt || !adapter.composerReady) {
        it.todo("adapter supplies no composerPrompt/composerReady pair");
      } else {
        const prompt = adapter.composerPrompt.bind(adapter);
        const ready = adapter.composerReady.bind(adapter);
        for (const name of all) {
          if (unbound.includes(name)) {
            it(`${name}: the composer is ready, and no region can bind`, () => {
              const lines = loadLines(name);
              expect(ready(lines)).toBe(true);
              expect(prompt(lines)).toBeNull();
            });
            continue;
          }
          it(`${name}: a region exists exactly when the composer is ready`, () => {
            const lines = loadLines(name);
            const region = prompt(lines);
            expect(region === null).toBe(!ready(lines));
            // A region the bridge cannot find on screen binds nothing at all.
            if (region !== null) expect(region.trim().length).toBeGreaterThan(0);
          });
        }

        // The other half of "the bridge can actually use this": `verifyExpectedPrompt`
        // (bridge/prompt-binding.ts) accepts a binding only when the match ENDS within the last
        // DEFAULT_PROMPT_TAIL_LINES (6) NON-BLANK rows of the fresh read. A region an adapter names
        // with more than that beneath it can never verify, so every destructive sweep on that screen
        // 409s ("The input box changed while clearing it") with nothing actually wrong — fail-closed,
        // but a permanent refusal the user cannot act on. omp shipped one row of margin here (its
        // slash palette is painted BELOW the box); this leg is what stops the next adapter repeating
        // it. An adapter that cannot fit the window must return null and take an unbound write.
        for (const name of all) {
          it(`${name}: a named region ends inside the bridge's ${BRIDGE_PROMPT_TAIL_LINES}-row tail window`, () => {
            const lines = loadLines(name);
            const region = prompt(lines);
            if (region === null) return;
            // Both sides normalized the way the bridge normalizes: trailing whitespace off, blank
            // rows dropped entirely (bridge/prompt-binding.ts `normalizePromptRegion`).
            const fresh = normalizeRegion(lines.map(lineText).join("\n"));
            const expected = normalizeRegion(region);
            const matchEnd = lastMatchEnd(fresh, expected);
            expect(matchEnd, `${name}: the named region is not on its own screen`).toBeGreaterThan(-1);
            expect(
              fresh.length - 1 - matchEnd,
              `${name}: ${fresh.length - 1 - matchEnd} non-blank rows sit below the named region — ` +
                `the bridge can only bind within the last ${BRIDGE_PROMPT_TAIL_LINES}`,
            ).toBeLessThan(BRIDGE_PROMPT_TAIL_LINES);
          });
        }
      }
    });

    describe("tail-anchoring (a dialog lifts only at the buffer tail)", () => {
      if (ownFixtures.length === 0) it.todo("no own dialog fixtures supplied");

      for (const name of ownFixtures) {
        it(`${name}: does NOT lift once ordinary output scrolls below it`, () => {
          const scrolled = [...loadLines(name), ...trailingOutput()];
          // A notice card (`MenuModel.liveBox`, ADR 0109) is exempt here. It lifts only with the live
          // input box under it, whose status rows cannot be told from output walked as status rows. Its
          // binding region runs through the box's bottom edge, so the bridge binds the tap only while
          // that box still stands inside its tail window: the leg below holds both halves of that.
          //
          // A `box-text` card is exempt for its own reason. It emits no keystroke, so a stale card costs a
          // wrong or expired link and never a key typed into a terminal, and under a live frame output rows
          // cannot be told from status rows. The leg below holds the one rule that bounds the stale case.
          expect(interactiveBlocks(adapter.buildBlocks(scrolled)).filter((b) => !isNoticeMenu(b) && !isBoxText(b))).toEqual([]);
        });
      }

      const boxTextFixtures = ownFixtures.filter((fixture) => adapter.buildBlocks(loadLines(fixture)).some(isBoxText));
      if (adapter.agent === "claude") {
        it("claude's own fixtures lift at least one box-text card", () => {
          expect(boxTextFixtures).not.toEqual([]);
        });
      }
      for (const name of boxTextFixtures) {
        it(`${name}: a box-text card is buried once ordinary output passes the status-row cap under the input box`, () => {
          const statusRowCap = requireProfile(adapter.agent).idle.volatile.below.maxRows;
          const output = Array.from({ length: statusRowCap + 1 }, (_, i) => textLine(`output row ${String(i)}`));
          expect(adapter.buildBlocks([...loadLines(name), ...output]).some(isBoxText)).toBe(false);
        });
      }

      for (const name of ownFixtures.filter((fixture) => adapter.buildBlocks(loadLines(fixture)).some(isNoticeMenu))) {
        it(`${name}: a notice card binds only while its box stands in the bridge's tail window`, () => {
          // A notice card that still lifts under scrolled output names a region the bridge finds inside
          // its window (bridge/prompt-binding.ts), box and all.
          const scrolled = [...loadLines(name), ...trailingOutput()];
          for (const block of adapter.buildBlocks(scrolled).filter(isNoticeMenu)) {
            if (block.kind !== "menu") continue;
            // Counted as the bridge counts them: a named footer run under the box is not (`rowsBelowMatch`).
            const below = rowsBelowMatch(scrolled.map(lineText), normalizeRegion(block.menu.signature));
            expect(below).not.toBeNull();
            expect(below!).toBeLessThan(BRIDGE_PROMPT_TAIL_LINES);
          }
          // Output enough to push the box out of that window: the bridge would refuse the region, so no
          // card lifts at all.
          const buried = [...loadLines(name), ...Array.from({ length: BRIDGE_PROMPT_TAIL_LINES }, () => trailingOutput()).flat()];
          expect(interactiveBlocks(adapter.buildBlocks(buried))).toEqual([]);
        });
      }
    });

    // The GENERIC MODAL contract (harness/menu-model.ts + menu-hints.ts). Every adapter that ships
    // menu fixtures gets these for free; an adapter with none of them registers the todo and stays
    // honest about it. What is pinned here is what a menu block PROMISES the renderer and the race
    // guard — not how any one harness finds it.
    describe("menu blocks (the generic modal contract)", () => {
      // A menu lifted off a notice ABOVE a live box (`MenuModel.liveBox`, ADR 0109) is held to its own
      // contract below: its keys are digits its key row printed, and the box stays the composer's.
      const menuFixtures = ownFixtures.filter((name) =>
        adapter.buildBlocks(loadLines(name)).some((b) => b.kind === "menu" && !isNoticeMenu(b)),
      );
      const noticeFixtures = ownFixtures.filter((name) => adapter.buildBlocks(loadLines(name)).some(isNoticeMenu));
      if (menuFixtures.length === 0) it.todo("adapter lifts no menu blocks from its own fixtures");

      for (const name of noticeFixtures) {
        // .adr/0009 still holds: no key is synthesised. Each is one digit the notice's own key block
        // printed as `<digit>:` (the trailing rows of the block), in the printed order; under a head
        // the profile marks `letters`, one letter printed as `<letter>:` instead, and never a digit. The block is
        // parsed here on its own terms, not the reader's: every keyed item, a letter or a digit after a
        // space, the row's start or a separator glyph, so a letter key the reader dropped shows.
        it(`${name}: a notice card's keys are the digits (letters under a letters head) its key block printed`, () => {
          for (const block of adapter.buildBlocks(loadLines(name))) {
            if (block.kind !== "menu" || block.menu.liveBox === undefined) continue;
            const printed = printedNoticeKeys(block.lines.map(lineText), block.menu.title);
            const head = lineText(block.lines[0]!).trimEnd();
            const lettered = LETTERED_HEADS.some((pattern) => pattern.test(head));
            const kind = lettered ? /^[A-Za-z]$/u : /^\d$/u;
            expect(printed.every((key) => kind.test(key)), `${name}: a key row with a ${lettered ? "digit key under a letters head" : "letter key"} lifted a card`).toBe(true);
            expect(block.menu.actions.map((a) => a.keys)).toEqual(printed.map((key) => [key]));
            expect(block.menu.nav).toEqual({ upDown: false });
          }
        });

        it(`${name}: composerReady is true under a notice card (the box keeps the keys)`, () => {
          if (!adapter.composerReady) return;
          expect(adapter.composerReady(loadLines(name))).toBe(true);
        });

        // A row between the key row and the box breaks the notice's exact shape: no interactive block
        // lifts at all, and the screen falls back to what it was without the reader.
        it(`${name}: a splice that breaks the notice lifts no card`, () => {
          const lines = loadLines(name);
          const block = adapter.buildBlocks(lines).find(isNoticeMenu)!;
          const keyRow = lines.indexOf(block.lines.at(-1)!);
          const perturbed = [...lines];
          perturbed.splice(keyRow + 1, 0, textLine("  ○ Something else entirely"));
          expect(interactiveBlocks(adapter.buildBlocks(perturbed))).toEqual([]);
        });
      }

      for (const name of menuFixtures) {
        // .adr/0009 at the CI edge: a synthesised digit is a VALID Herdr key, so the key-grammar leg
        // above would happily pass one. Round-tripping through the shared whitelist is what makes an
        // invented key impossible — `menuKeyFor` is the only sanctioned source of a menu action key.
        it(`${name}: every action key came from the shared whitelist, and none is a digit`, () => {
          for (const block of adapter.buildBlocks(loadLines(name))) {
            if (block.kind !== "menu") continue;
            for (const key of block.menu.actions.flatMap((a) => a.keys)) {
              expect(/^\d+$/.test(key), `${name} synthesised the digit key ${key} (.adr/0009)`).toBe(
                false,
              );
              expect(menuKeyFor(key), `${name} emits off-whitelist menu key ${key}`).toBe(key);
            }
          }
        });

        // The signature IS the race guard (Herdr's `revision` is a stub). An empty or constant one
        // would disable it silently, so both halves are checked: present, and text-sensitive.
        it(`${name}: the menu carries a non-empty, text-sensitive signature`, () => {
          const lines = loadLines(name);
          for (const block of adapter.buildBlocks(lines)) {
            if (block.kind !== "menu") continue;
            expect(block.menu.signature.length, `${name} signs its menu with ""`).toBeGreaterThan(0);
            expect(block.menu.title.length, `${name} lifts an untitled menu`).toBeGreaterThan(0);
          }
          // Perturb the region's text (a row inserted just ABOVE the footer, so the footer stays the
          // last thing on screen and the menu still lifts): the signature must move with it. ABOVE
          // THE FOOTER GROUP, not above the last row: a narrow pane wraps a footer onto two or three
          // rows (menu-hints.ts `readKeyHintFooter`), and a row spliced into the middle of one would
          // be cutting the footer in half rather than adding a row above it.
          const perturbed = [...lines];
          perturbed.splice(footerTop(lines), 0, textLine("  ○ Something else entirely"));
          const after = menuSignatures(adapter.buildBlocks(perturbed));
          expect(after.length, `${name}: the perturbed capture stopped lifting a menu`).toBe(
            menuSignatures(adapter.buildBlocks(lines)).length,
          );
          expect(after).not.toEqual(menuSignatures(adapter.buildBlocks(lines)));
        });

        // A menu HAS the keyboard. If the adapter can tell whether its composer is on screen, it must
        // say no here — otherwise the reply pre-flight (lib/reply-action.ts) would type the user's
        // message into the modal, which is the exact `/model` bug the grammar exists to end.
        it(`${name}: composerReady is false while the modal is up`, () => {
          if (!adapter.composerReady) return; // "no idea" is allowed; a wrong "yes" is not
          expect(adapter.composerReady(loadLines(name))).toBe(false);
        });
      }

      // Neutral output is never a modal — a menu lifted from a log would put live keystroke buttons
      // under ordinary text. (Implied by the fail-closed leg; asserted directly so the menu contract
      // reads whole in one place.)
      for (const name of neutralFixtures) {
        it(`${name} (neutral): lifts no menu block`, () => {
          expect(adapter.buildBlocks(loadLines(name)).some((b) => b.kind === "menu")).toBe(false);
        });
      }
    });

    // THE DIALOG-MODEL contract (harness/*-model.ts + dialog-contract.ts), checked for EVERY block
    // kind the adapter up-levels — the generalisation of the menu-signature invariant above. What is
    // pinned is what the race guard (lib/dialog-guard.ts) assumes of ANY adapter's model:
    //   * the signature is non-empty (an empty/constant one silently disables the guard, because
    //     Herdr's `revision` is a stub and this is the whole freshness check), and the bound region
    //     text is non-empty too (the bridge has to find it in its own fresh read);
    //   * the signature is TEXT-SENSITIVE: perturb a row of the region and it moves;
    //   * the comparators agree with that: the same screen re-derived is the same dialog, and a
    //     perturbed screen FAILS the committing comparison — which is exactly what stops a tap on a
    //     stale render from firing at the screen that replaced it.
    // A kind the adapter never emits registers a todo rather than passing vacuously.
    describe("dialog models (signature + identity contract)", () => {
      for (const kind of DIALOG_KINDS) {
        const kindFixtures = ownFixtures.filter((name) => modelsOf(adapter, name, kind).length > 0);
        if (kindFixtures.length === 0) {
          it.todo(`adapter lifts no ${kind} blocks from its own fixtures`);
          continue;
        }
        // `kind` is the UNION here, so addressing the table with it would intersect the five models
        // into an impossible parameter type. `dialogComparators` does that erasure once, in the
        // module that owns the table, and keeps this loop one generic pass instead of five
        // hand-written copies. The comparators are only ever handed models this same table produced
        // for this same kind (`modelsOf(..., kind)`).
        const contract = dialogComparators(kind);

        for (const name of kindFixtures) {
          it(`${name}: the ${kind} model signs itself (signature + bound region non-empty)`, () => {
            for (const model of modelsOf(adapter, name, kind)) {
              expect(contract.signature(model).length, `${name} signs its ${kind} with ""`).toBeGreaterThan(0);
              expect(contract.region(model).length, `${name} binds its ${kind} to ""`).toBeGreaterThan(0);
            }
          });

          it(`${name}: the ${kind} bound region ends inside the bridge's tail window (${BRIDGE_PROMPT_TAIL_LINES} rows, or the model's declared tail)`, () => {
            // The first write of every choreography binds `region` as the bridge's expected prompt,
            // and `verifyExpectedPrompt` (bridge/prompt-binding.ts) only accepts a match ENDING
            // within the last 6 non-blank rows of the fresh read. A region ending higher 409s every
            // tap on a screen that never moved — Muse's checkbox shipped exactly that (question →
            // Submit left 6 rows below the match) until a live toggle caught it. Same normalisation
            // as the composerPrompt leg above: trailing whitespace off, blanks dropped.
            const whole = loadLines(name).map(lineText);
            for (const model of modelsOf(adapter, name, kind)) {
              // A model read from a column range is matched, as the bridge matches it, against the
              // read cut to that range (lib/column-range.ts).
              const columns = contract.columns?.(model);
              const read =
                columns === undefined ? whole : splitLines(parseAnsi(cropRawColumns(loadRaw(name), columns))).map(lineText);
              // Nor, as the bridge does not, is a task checklist that ends the read counted against the
              // tail (lib/task-checklist.ts), nor a named footer run under the box the region ends above
              // (`rowsBelowMatch`, cut only where the uncut read would be refused).
              const expected = normalizeRegion(contract.region(model));
              // A model that declares a tail window (`bindTail`, lib/tail-lines.ts) is matched against
              // that window, which the bridge accepts only from its default up to MAX_TAIL_LINES.
              const declared = contract.tail?.(model);
              if (declared !== undefined) {
                expect(declared, `${name}: the ${kind} declares a tail the bridge refuses`).toBeGreaterThan(BRIDGE_PROMPT_TAIL_LINES);
                expect(declared, `${name}: the ${kind} declares a tail the bridge refuses`).toBeLessThanOrEqual(MAX_TAIL_LINES);
              }
              const tailWindow = declared ?? BRIDGE_PROMPT_TAIL_LINES;
              const below = rowsBelowMatch(read, expected, tailWindow);
              expect(below, `${name}: the ${kind} region is not on its own screen`).not.toBeNull();
              expect(
                below!,
                `${name}: ${String(below)} non-blank rows sit below the ${kind} region — ` +
                  `the bridge can only bind within the last ${String(tailWindow)}`,
              ).toBeLessThan(tailWindow);
            }
          });

          // A model that declares a tail window (`bindTail`) binds to its own raw capture through the
          // bridge's verifier with that window, and the same region is refused with the default one:
          // a declared tail that was not needed would only widen what a stale copy can match.
          it(`${name}: a ${kind} declared tail binds to its own raw capture through the bridge's verifier, and is needed`, () => {
            for (const model of modelsOf(adapter, name, kind)) {
              const tail = contract.tail?.(model);
              if (tail === undefined) continue;
              const raw = loadRaw(name);
              const region = contract.region(model);
              const columns = contract.columns?.(model);
              expect(verifyPromptBinding(raw, region, contract.styled?.(model), columns, tail).ok, `${name} with tail ${tail}`).toBe(true);
              expect(verifyPromptBinding(raw, region, contract.styled?.(model), columns), `${name} with the default tail`).toMatchObject({
                ok: false,
                reason: "not_in_tail",
              });
            }
          });

          // A model that names a column range (`bindColumns`) binds to what the bridge's own verifier
          // finds in the raw capture after cutting it to that range: the phone's crop and the
          // bridge's must agree cell for cell.
          it(`${name}: a ${kind} column range binds to its own raw capture through the bridge's verifier`, () => {
            for (const model of modelsOf(adapter, name, kind)) {
              const columns = contract.columns?.(model);
              if (columns === undefined) continue;
              expect(verifyPromptBinding(loadRaw(name), contract.region(model), contract.styled?.(model), columns)).toEqual(
                contract.styled?.(model) === undefined ? { ok: true } : { ok: true, styled: "checked" },
              );
            }
          });

          it(`${name}: re-deriving the same screen is the same ${kind}`, () => {
            // Two independent derivations of the same bytes (a fresh parse each time — what the guard
            // does on every tap). Both the identity and the committing comparison must hold, or a
            // guard would reject taps on a screen that never moved.
            const a = modelsOf(adapter, name, kind).at(-1)!;
            const b = modelsOf(adapter, name, kind).at(-1)!;
            expect(contract.identity(a, b), `${name}: ${kind} identity is unstable`).toBe(true);
            expect(contract.commits(a, b), `${name}: ${kind} equality is unstable`).toBe(true);
          });

          it(`${name}: a perturbed region moves the signature and fails the committing check`, () => {
            const before = modelsOf(adapter, name, kind).at(-1)!;
            if (fixedRegion.has(name)) {
              expect(perturbationsLeaveItBlind(adapter, name, kind), `${name}: a perturbed row still lifts with the same signature`).toBe(false);
              return;
            }
            const probe = perturbRegion(adapter, name, kind);
            expect(
              probe,
              `${name}: no row of the ${kind} region changes its signature — the race guard is blind ` +
                `to a screen that changed under the user`,
            ).not.toBeNull();
            expect(contract.signature(probe!)).not.toBe(contract.signature(before));
            expect(
              contract.commits(before, probe!),
              `${name}: a ${kind} whose region text changed still passes the committing comparison`,
            ).toBe(false);
          });
        }
      }
    });

    // The pointer-walk shape the action layer relies on (ADR 0080, lib/prompt-action.ts). It splits a
    // plan with `splitWalk`, sends the arrows, and waits for the tapped row's plan to become exactly
    // ["Enter"]. That only works if every walk-class plan is one direction of arrows (Up, Down, Left or
    // Right, whatever the grammar's list runs along) then Enter (a
    // mixed walk is not a walk of one pointer), and at most one row is the pointed one (two rows
    // answering to a bare Enter means the pointer is ambiguous and the verify step could pass on the
    // wrong row).
    describe("pointer walks (walk, verify, commit)", () => {
      for (const name of ownFixtures) {
        const models = modelsOf(adapter, name, "prompt-select");
        if (models.length === 0) continue;
        it(`${name}: walk plans are one-direction arrows then Enter, and at most one row is pointed`, () => {
          for (const model of models) {
            for (const option of model.options) {
              const plan = splitWalk(option.keys);
              if (plan === null) continue;
              expect(
                new Set(plan.walk).size,
                `${name}: "${option.label}" mixes arrow directions in ${JSON.stringify(option.keys)}`,
              ).toBeLessThanOrEqual(1);
            }
            const pointed = model.options.filter((o) => sameKeys(o.keys, ["Enter"]));
            expect(
              pointed.length,
              `${name}: ${pointed.length} rows carry the plan ["Enter"], the pointer is ambiguous`,
            ).toBeLessThanOrEqual(1);
          }
        });
      }
    });

    // THE WALK PAIRS (ADR 0080 point 5, harness/walk-pairs.ts). A walked tap reads the screen again
    // after the arrows and sends Enter only when that read is the SAME dialog (`promptsSameIdentity`)
    // with the tapped row pointed. A `coreSignature` that kept text which follows the pointer (a detail
    // row, a description of the highlighted row, a position counter) fails that check after every walk.
    // Only real captures show it, so the corpus must hold a pair for each grammar that walks.
    //
    // Which fixtures count is read off the adapter, not off the cohort lists: every fixture in the
    // corpus the adapter lifts into a `prompt-select` with a walked plan. A grammar cannot opt out by
    // leaving its captures out of `ownFixtures`.
    describe("walk pairs (the pointer moves, the dialog does not)", () => {
      const walked = walkedFixtures(adapter);
      const pairs = WALK_PAIRS.filter(([agent]) => agent === adapter.agent);

      if (walked.size === 0) it.todo(`${adapter.agent}: lifts no walked pointer list from the corpus`);
      for (const [, nameA, nameB] of pairs) {
        it(`${nameA} <> ${nameB}: the pointer moved, the dialog is the same`, () => {
          const a = walked.get(nameA);
          const b = walked.get(nameB);
          expect(a, `${nameA} is not a walked prompt-select of ${adapter.agent}`).toBeDefined();
          expect(b, `${nameB} is not a walked prompt-select of ${adapter.agent}`).toBeDefined();
          expect(
            walkGroupKey(adapter.agent, a!),
            `${nameA} and ${nameB} are not one grammar group, so not one dialog`,
          ).toBe(walkGroupKey(adapter.agent, b!));
          // The pair must really move the pointer: the row answering to a bare Enter (the pointed
          // offered row, none while it is on a hidden row) differs. Two captures of one pointer
          // position would prove nothing.
          expect(enterIndex(a!), `${nameA} and ${nameB} have the pointer on the same row`).not.toBe(
            enterIndex(b!),
          );
          for (const [name, model] of [[nameA, a!], [nameB, b!]] as const) {
            const rows = model.options.filter((o) => sameKeys(o.keys, ["Enter"]));
            expect(rows.length, `${name}: ${rows.length} rows carry the plan ["Enter"]`).toBeLessThanOrEqual(1);
          }
          expect(
            promptsSameIdentity(a!, b!) && promptsSameIdentity(b!, a!),
            `${nameA} and ${nameB} are one dialog with the pointer on another row, yet are not the same ` +
              `identity: a walked tap on this grammar answers "changed" and never commits. Its ` +
              `coreSignature keeps text that follows the pointer (a detail row, a description of the ` +
              `highlighted row, a position counter). Blank it in the grammar.`,
          ).toBe(true);
          // The verdict is the diff: `promptsSameIdentity` is `identityDiff === null`, on the real captures.
          for (const [x, y] of [[a!, b!], [b!, a!]] as const) {
            expect(identityDiff(x, y), `${nameA} <> ${nameB}`).toBeNull();
            expect(promptsSameIdentity(x, y)).toBe(identityDiff(x, y) === null);
          }
          expect(promptsEqual(a!, b!), `${nameA} and ${nameB} are byte-identical, not a moved pointer`).toBe(
            false,
          );
          // A pointer drawn only as a style leaves the two signatures EQUAL, so the bridge's text
          // binding cannot tell the pair apart. Such a grammar must hand the bridge the styled lines
          // (ADR 0080 point 7), and they must move with the pointer.
          if (a!.signature === b!.signature) {
            expect(
              a!.styledSignature !== undefined && b!.styledSignature !== undefined,
              `${nameA} and ${nameB}: the pointer is a style: the grammar must set styledSignature so the bridge can bind to it`,
            ).toBe(true);
            expect(
              a!.styledSignature,
              `${nameA} and ${nameB}: the pointer is a style: the grammar must set styledSignature so the bridge can bind to it, and it must differ between the two pointers`,
            ).not.toBe(b!.styledSignature);
          }
        });

        // The phone's value is what the bridge computes. For a pair whose models carry one, each side's
        // `styledSignature` is found in its OWN raw capture by the bridge's verifier, and is NOT
        // found in the other capture of the pair: the same dialog with the pointer elsewhere.
        it(`${nameA} <> ${nameB}: styledSignature binds to its own capture and refuses the other`, () => {
          const a = walked.get(nameA);
          const b = walked.get(nameB);
          if (a?.styledSignature === undefined || b?.styledSignature === undefined) return;
          const rawA = readFileSync(join(PANES_DIR, nameA), "utf8");
          const rawB = readFileSync(join(PANES_DIR, nameB), "utf8");
          expect(verifyExpectedStyled(rawA, a.signature, a.styledSignature), `${nameA} against its own styledSignature`).toEqual({ ok: true });
          expect(verifyExpectedStyled(rawB, b.signature, b.styledSignature), `${nameB} against its own styledSignature`).toEqual({ ok: true });
          expect(verifyExpectedStyled(rawB, a.signature, a.styledSignature).ok, `${nameB} must not pass ${nameA}'s styledSignature`).toBe(false);
          expect(verifyExpectedStyled(rawA, b.signature, b.styledSignature).ok, `${nameA} must not pass ${nameB}'s styledSignature`).toBe(false);
        });
      }

      // Every walked capture whose model carries a styledSignature, pair or not: the bridge's
      // verifier accepts it against the capture's raw bytes. This is the contract between the two
      // sides: the same function over the same bytes gives the same lines.
      for (const [name, model] of walked) {
        if (model.styledSignature === undefined) continue;
        it(`${name}: the bridge finds the phone's styledSignature in the raw capture`, () => {
          const raw = readFileSync(join(PANES_DIR, name), "utf8");
          expect(verifyExpectedStyled(raw, model.signature, model.styledSignature!)).toEqual({ ok: true });
        });
      }

      // The ratchet. Every walked fixture's grammar group has a pair or a reason.
      const groups = new Map<string, string[]>();
      for (const [name, model] of walked) {
        const key = walkGroupKey(adapter.agent, model);
        groups.set(key, [...(groups.get(key) ?? []), name]);
      }
      const paired = new Set(
        pairs.flatMap(([, a]) => (walked.has(a) ? [walkGroupKey(adapter.agent, walked.get(a)!)] : [])),
      );
      for (const [key, names] of groups) {
        for (const name of names) {
          it(`${name}: its grammar group "${key}" has a walk pair or a listed gap`, () => {
            expect(
              paired.has(key) || Object.hasOwn(WALK_GAPS, key),
              `${name} lifts a pointed list with walked plans, group "${key}", and nothing proves the ` +
                `grammar survives its own walk. Capture the same dialog with the pointer on another row, ` +
                `add both fixtures to WALK_PAIRS in harness/walk-pairs.ts (agent "${adapter.agent}"), or ` +
                `list the group in WALK_GAPS ({ since, reason }) and in the pinned list in conformance.test.ts: a new gap is a reviewed decision, and a second capture is the fix.`,
            ).toBe(true);
          });
        }
        if (Object.hasOwn(WALK_GAPS, key)) {
          it(`"${key}": the listed gap is still a gap (no pair has landed since)`, () => {
            expect(
              paired.has(key),
              `"${key}" now has a declared walk pair: delete its line from WALK_GAPS in harness/walk-pairs.ts`,
            ).toBe(false);
          });
        }
      }
      for (const key of Object.keys(WALK_GAPS).filter((k) => k.startsWith(`${adapter.agent} | `))) {
        it(`"${key}": the listed gap names a group this adapter still lifts`, () => {
          expect(groups.has(key), `"${key}" has no walked fixture: delete its line from WALK_GAPS`).toBe(true);
        });
      }
    });

    // ADR 0151 rule 2: Collie sends only keys the screen printed, plus the arrows of a walk, plus the
    // named exceptions of rule 3 (UNPRINTED_KEY_EXCEPTIONS). Every capture of this adapter, the raw
    // cohort included, goes through the unread-dialog post-pass too, so its declared key is walked.
    describe("unprinted key (every key a lifted block can emit is printed or a named exception)", () => {
      const own = [...ownFixtures, ...neutralFixtures];
      const findings = opts.unprintedKeyFindings ?? {};
      if (own.length === 0) it.todo("no own fixtures supplied");
      for (const name of Object.keys(findings)) {
        it(`${name}: an open unprinted key finding names one of this adapter's own captures`, () => {
          expect(own, `${name} is listed in unprintedKeyFindings and is not an own capture`).toContain(name);
        });
      }
      for (const name of own) {
        const finding = findings[name];
        const register = finding === undefined ? it : it.fails;
        const title =
          finding === undefined
            ? `${name}: no unprinted key outside the named exceptions`
            : `${name}: no unprinted key outside the named exceptions (expected to fail, open finding: ${finding})`;
        register(title, () => {
          const unnamed = unprintedKeys(adapter.agent, shownBlocks(adapter, loadLines(name)));
          expect(
            unnamed.map((u) => `${name}: ${u.kind} "${u.title.split("\n")[0]}" sends ${u.key} (${u.step}), which the screen did not print`),
            `${name} emits a key its screen did not print and no entry of UNPRINTED_KEY_EXCEPTIONS names it (ADR 0151 rule 3)`,
          ).toEqual([]);
        });
      }
    });

    describe("key-grammar validity (every emittable key is send_keys-valid)", () => {
      if (ownFixtures.length === 0) it.todo("no own dialog fixtures supplied");
      for (const name of ownFixtures) {
        it(`${name}: every keystroke its blocks can emit validates`, () => {
          for (const block of interactiveBlocks(adapter.buildBlocks(loadLines(name)))) {
            const keys = emittableKeySends(block)?.map((send) => send.key) ?? null;
            if (keys === null) continue; // a kind not modelled here yet — tolerated
            expect(keys.length, `${name} / ${block.kind} exposes no keys`).toBeGreaterThan(0);
            for (const key of keys) {
              expect(
                isValidHerdrKey(key),
                `${name} / ${block.kind} emits invalid key ${JSON.stringify(key)}`,
              ).toBe(true);
            }
            for (const plan of declaredKeyPlans(block)) {
              expect(
                plan.keys.length,
                `${name} / ${block.kind} declares an empty ${plan.field} plan`,
              ).toBeGreaterThan(0);
            }
          }
        });
      }
    });
  });
}
