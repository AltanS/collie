// The Send Protocol v1 (M56 spec 05; the contract is in the M56 README, "Send Protocol", and the
// steps in experiments/reader-stability/ARCHITECTURE.md section 2). One request, one lock per pane,
// one receipt, a closed list of outcomes. The box is proven by what typing does, not by what it looks
// like, and the submit key leaves only through the key gate.
//
// Steps, each bounded as (max reads, max ms):
//   accept  write `<stateDir>/sends/<id>.json` before any key; the same id returns the same receipt
//   S0      (2, 1200) a fresh read after the request arrived, stable across two mux calls; the
//           Surface must be free, or unknown(no-match) with the hash of the rows the person saw
//   probe   (3, 900) on the probed path: write the probe character, require exactly that one new run
//           and no other change, Backspace through the gate, require the S0 box again. A probe that
//           fails with its character standing once in the box gets one Backspace and one more read
//   write   the whole text in one write per line (a bracketed paste where the multiplexer and the
//           profile allow it); a line break is the profile's newline key, through the gate
//   S1      (6, 2500) read until the box holds exactly the predicted text (or the profile's collapse
//           form) and nothing else moved; else `typed_not_submitted`
//   commit  the profile's submit keys through the gate with a 150 ms token; `submit-sent` is on disk first
//   S2      (6, 3000) read until the box is empty or a running sign shows: `sent`; else `unknown`
// A request past the sum of the bounds ends `unknown` and releases the lock. Escape is never sent.
//
// A send into a running turn: when the screen shows the turn running, no modal and an empty box, and
// the harness's profile says Enter queues while running (`keys.enterWhileRunning: "queues"`), the send
// goes ahead and the harness takes it after the turn. Such a send is always probed. The turn prints
// above the box while the text goes in, so the probe and S1 let the transcript move. The rows under
// the box keep their count, the cue read inside the frame may not grow, and the Surface must claim no
// modal. The frameless cue read is left out: a turn draws list and pointer rows around the box. S2
// needs the box empty, because the running sign shows from the start. A modal there, or two reads in
// a row with no box, ends `unknown(dialog_after_enter)`. The receipt says `queued`. A harness whose
// profile does not queue, a command, and a box that would go out as a command are refused
// `turn_running`; something open at the box is refused `not_free`.
//
// A turn the screen does not mark: Claude Code 2.1.301 draws no spinner while the answer streams, so
// S0 reads idle. On a harness that queues, a send that is not a command may see the rows above the
// box move while Collie types, if the frame stays, the rows under the box keep their count, the cue
// inside the frame stays and the Surface claims no modal (aboveMovedInTurn). From there it takes the
// queued path; the receipt says `queued` only on S0's running read or the S2 witness.
//
// A pane whose harness has a profile is read through its input frame. A pane with no profile has no
// frame: its Surface is unknown(no-match), every send on it is probed, and the probe's own landing
// spot (the row and column where the probe character appeared) is what S1 and S2 compare against.
//
// A manual send (the screen takes the two-tap Send: no profile, an unreadable overlay, a weak cue)
// compares less than a free one: the rows under the box (hints, footers, status rows) and the rest
// of the box may change while the probe and the text go in, as a `command` lets them. The rows
// above the box may lose text (go blank, or move because rows vanished) but never gain any, and a
// modal cue that shows still fails.
//
// Rows live only in the short memory ring below; the receipt and the request file hold hashes.
// No harness name lives here (no-harness-names.test.ts scans this folder).

import type { MuxAck, MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { isRunningRow, readCues, runningSign } from "../../web/src/lib/surface/cues.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { findInputFrame, rowText, type Frame, type FrameRow } from "../../web/src/lib/surface/frame.ts";
import { liftAsk, liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { ProfileMatch, QueuedRow } from "../../web/src/lib/surface/profile.ts";
import {
  offersFor,
  reservedLead,
  sendLines,
  takesManualSend,
  wsFree,
  type ReadMark,
  type SendAnswer,
  type SendCap,
  type SendMode,
  type SendOffer,
  type SendOutcome,
  type SendReason,
  type SendReceipt,
  type SendReceiptRow,
  type SendStep,
} from "../../web/src/lib/surface/send.ts";
import { isFree, shortHash, type Surface } from "../../web/src/lib/surface/surface.ts";
import type { CapState, CounterKey, ExampleEntry, InboxEntry } from "./counters.ts";
import { askLifetimeOf, type AskBook } from "./ask.ts";
import type { KeyGate } from "./key-gate.ts";
import type { RequestStore, SendRecord } from "./requests.ts";

/** The step bounds, written as (max reads, max ms). */
export const BOUNDS = {
  s0: { reads: 2, ms: 1200 },
  probe: { reads: 3, ms: 900 },
  s1: { reads: 6, ms: 2500 },
  s2: { reads: 6, ms: 3000 },
} as const;

/** The session lock's bound: the sum of the step bounds. A request past it ends `unknown`. */
export const LOCK_BOUND_MS = BOUNDS.s0.ms + BOUNDS.probe.ms + BOUNDS.s1.ms + BOUNDS.s2.ms;

/** The probe character on a pane with no profile: the slice 0 lab found it inert in every hotkey dialog. */
export const GENERIC_PROBE = "⌁";
/** The submit key on a pane with no profile. */
const GENERIC_SUBMIT = ["Enter"] as const;
/** The clear key on a pane with no profile. Never Escape. */
const GENERIC_CLEAR = { key: "Backspace", slack: 16 } as const;
/** The reserved leads on a pane with no profile: a slash command, a shell line, a file mention. */
const GENERIC_LEADS = ["/", "!", "@"] as const;

/** The detail after a failed probe whose one Backspace took the character out again. */
const PROBE_REMOVED = "One Backspace removed the probe character, so the box is clean again.";
/** The detail after a failed probe that left its character where Collie cannot take it out. */
function probeMayRemain(probe: string): string {
  return `A probe character (${probe}) may remain in the box. Check the pane before you type.`;
}

/** The detail after a Submit that went out on a box holding another text than the request named. */
const HELD_OTHER = "The box held a different text than the request when Enter went out.";

/** Rows one protocol read asks for. A viewport read never moves the screen. */
export const SEND_READ_LINES = 120;
/** The bottom window the probe must land in and the rows hash covers. */
export const CLUSTER_ROWS = 24;
/** The gap before the first poll of a step; each later gap doubles. */
const FIRST_GAP_MS = 80;
/** The gap between the two S0 reads. */
const S0_GAP_MS = 120;
/** Emptying a box (replace, discard) borrows the S2 bound: a read after every batch, inside S2's reads and ms. */
const CLEAR_BOUND = BOUNDS.s2;
/** Keys per clear batch; a read sits between two batches. */
const CLEAR_BATCH = 256;
/** Texts this short take the probed path whatever the profile says. */
const SHORT_TEXT = 3;

/** What a reserved lead is, for the refusal's sentence: each is sent as a `command`, never as a plain send. */
const LEAD_ROUTES = new Map<string, string>(Object.entries({
  "/": "A slash command is sent as a command (mode command), not as a message.",
  "!": "A shell line is sent as a command (mode command), not as a message.",
  "@": "A file mention at the start is sent as a command (mode command), not as a message.",
}));

// ── Ports ────────────────────────────────────────────────────────────────────────────────────────

/** What the protocol needs of a multiplexer besides keys (which only the gate sends). */
export interface ProtocolMux {
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;
  typeText(paneId: string, text: string): Promise<MuxAck>;
  /** A bracketed paste, where the multiplexer has one. */
  pasteText?(paneId: string, text: string): Promise<MuxAck>;
}

/** The pane a request is for, as the bridge's own snapshot names it. */
export interface SendTarget {
  readonly session: string;
  readonly paneId: string;
  /** The agent string the multiplexer reports; it picks the profile by id. */
  readonly harness: string;
}

/**
 * What the protocol tells the counters (M56 spec 09). Every call is made after the fact and inside a
 * try: a ledger that throws or is slow never changes an outcome and never blocks a send. The cap only
 * adds the one confirm its answer asks for.
 */
export interface SendLedger {
  send(key: CounterKey, end: { readonly outcome: string; readonly reason?: string | undefined; readonly probed: boolean }): void;
  noteManual(key: CounterKey): void;
  capState(harness: string, version: string): CapState;
  inbox(entry: InboxEntry): void;
  example(entry: ExampleEntry): void;
}

export interface SendDeps {
  readonly mux: ProtocolMux;
  readonly gate: KeyGate;
  readonly store: RequestStore;
  readonly locks: SessionLocks;
  readonly ring: RowRing;
  /** The harness's profile at its binary's version, or null when the harness has no profile. */
  readonly profile: (harness: string) => Promise<ProfileMatch | null>;
  /** The pane's generation now, or null when the pane is gone. */
  readonly generation: (paneId: string) => string | null;
  /** The counters, the cap and the lab's folders. Absent in a test that does not need them. */
  readonly ledger?: SendLedger | undefined;
  /** The session's ask book (M56 spec 08): a dialog a read lifts is named by its single-use id. */
  readonly asks?: AskBook;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** A request as the route checked it. */
export interface SendRequest {
  readonly id: string;
  readonly text: string;
  readonly mode: SendMode;
  readonly rowsHash?: string;
  /** The Surface revision the phone showed when the person tapped, or 0. */
  readonly revision?: number;
  /** The person's answer to the cap's extra confirm (M56 spec 09). */
  readonly capAck?: boolean;
}

// ── The lock and the ring ────────────────────────────────────────────────────────────────────────

/** One lock per pane, held by one request until it settles or its bound passes. */
export class SessionLocks {
  private readonly held = new Map<string, { owner: string; until: number }>();

  /** Take the lock, or false when another request holds it inside its bound. A lock past its bound is free. */
  acquire(key: string, owner: string, until: number, now: number): boolean {
    const current = this.held.get(key);
    if (current !== undefined && current.owner !== owner && current.until >= now) return false;
    this.held.set(key, { owner, until });
    return true;
  }

  /** Whether `owner` still holds the lock inside its bound. */
  owns(key: string, owner: string, now: number): boolean {
    const current = this.held.get(key);
    return current !== undefined && current.owner === owner && current.until >= now;
  }

  release(key: string, owner: string): void {
    if (this.held.get(key)?.owner === owner) this.held.delete(key);
  }
}

/** One read's rows, kept in memory only: they can hold secrets. */
export interface RingEntry {
  readonly requestId: string;
  readonly step: string;
  readonly at: number;
  readonly rows: readonly string[];
}

/** The short memory ring of rows the protocol read. Never written to disk, never on the wire. */
export class RowRing {
  private readonly entries: RingEntry[] = [];
  constructor(private readonly capacity = 32) {}

  push(entry: RingEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  of(requestId: string): RingEntry[] {
    return this.entries.filter((entry) => entry.requestId === requestId);
  }

  get size(): number {
    return this.entries.length;
  }
}

// ── One read ─────────────────────────────────────────────────────────────────────────────────────

/** One screen read as the protocol sees it. */
interface Snap {
  readonly revision: number;
  /** The gate's revision for the pane, taken with this read. */
  readonly gateRevision: number;
  readonly rows: readonly FrameRow[];
  /** Row texts, trailing blanks cut. */
  readonly texts: readonly string[];
  /** Row texts with faint (SGR 2) runs dropped, trailing blanks cut: a placeholder is faint. A running
   *  row's spinner glyph and bracketed digits are fixed marks ({@link steadyRow}), so its ticking
   *  timer moves no compare. */
  readonly plain: readonly string[];
  /** {@link plain} as read, nothing masked: what the lab's example keeps. */
  readonly plainRaw: readonly string[];
  readonly frame: Frame | null;
  readonly surface: Surface;
  readonly cueStrength: "none" | "weak" | "strong";
  /** The generic cues of the bottom cluster read as if no frame were found: a popup under the box
   *  that walks like a status row escapes the framed read, never this one. Compared with S0's. */
  readonly bareCues: "none" | "weak" | "strong";
  /** A short hash of the whole read. */
  readonly hash: string;
  /** A short hash of the bottom window, the rows a person checks before a two-tap send. */
  readonly rowsHash: string;
}

function plainOf(row: FrameRow): string {
  let out = "";
  for (const run of row.segments) if (run.dim !== true) out += run.text;
  return out.trimEnd();
}

/** The index past the last non-blank row. */
function contentEnd(texts: readonly string[]): number {
  let end = texts.length;
  while (end > 0 && texts[end - 1]!.trim().length === 0) end--;
  return end;
}

/** A run of rows: `first` included, `end` not. */
interface RowWindow {
  readonly first: number;
  readonly end: number;
}

function bottomWindow(texts: readonly string[]): RowWindow {
  const end = contentEnd(texts);
  return { first: Math.max(0, end - CLUSTER_ROWS), end };
}

/** A spinner glyph at the start of a running row: one or two characters with no letter and no digit. */
const SPINNER_LEAD = /^(\s*)[^\p{L}\p{N}\s]{1,2}(?=\s)/u;
/**
 * A spinner row by its words: a glyph, a verb that ends in an ellipsis, and at most one bracket group
 * after it, to the end of the row. In the first second of a turn the row has no bracket group yet
 * ("✶ Wibbling…"), then gains its timer ("* Wibbling… (4s · ↓ 304 tokens)"). The turn label does
 * not read this pattern (the running sign needs the timer); only the compares do.
 */
const SPINNER_VERB_ROW = /^(\s*)[^\p{L}\p{N}\s]{1,2}(\s+\p{L}[^()]*?(?:…|\.\.\.))\s*(?:\([^()]*\))?\s*$/u;
/** A bracketed run on a running row: where its timer and its token count stand. */
const BRACKET = /\([^()]*\)/gu;

/**
 * A row's plain text as the compares of a pane with no frame see it. A spinner row (SPINNER_VERB_ROW)
 * reads as its verb behind a fixed glyph mark, its bracket group dropped, so the row before and after
 * its timer shows compare equal. On another row that shows a running sign (an interrupt hint, a
 * spinner with text after its bracket), the spinner glyph at its start and the digits inside its
 * brackets read as fixed marks, so a timer and a token count that ticked between two reads
 * are not a moved screen, a probe that changed two rows, or a row that gained text. Every other
 * character of the row still counts: a row such as "2. No, tell Claude... (3m)" that changes its
 * words, or stops being a running row, still changes every compare.
 */
export function steadyRow(row: string): string {
  // A spinner row with or without its bracket group reads as the glyph mark and the verb alone.
  const verb = SPINNER_VERB_ROW.exec(row);
  if (verb !== null) return `${verb[1] ?? ""}*${verb[2] ?? ""}`;
  if (!isRunningRow(row)) return row;
  return row.replace(SPINNER_LEAD, "$1*").replace(BRACKET, (run) => run.replace(/\d+/gu, "0"));
}

function mark(snap: Snap | null): ReadMark | null {
  return snap === null ? null : { revision: snap.revision, hash: snap.hash };
}

/** What a frame says about the box: its text, or "" when it shows the placeholder. */
function boxText(frame: Frame): string {
  return frame.placeholder ? "" : frame.interior.text;
}

const CUE_RANK = { none: 0, weak: 1, strong: 2 } as const;

/**
 * Whether a modal cue grew since `before`: the framed read's or the bare cluster's. On a free S0 there
 * was none, so any cue counts; on a manual send the person confirmed a screen that already showed one
 * (an unreadable overlay, a weak cue), and only a stronger one is news.
 */
function cueAppeared(before: Snap, after: Snap): boolean {
  return CUE_RANK[after.cueStrength] > CUE_RANK[before.cueStrength] || CUE_RANK[after.bareCues] > CUE_RANK[before.bareCues];
}

/**
 * The cue check of a send into a running turn: only the cue read with the frame found may grow. The
 * frameless read is left out, because a turn draws what it reads as a cue around the box: Claude
 * Code's queued row (a pointer row with the text, over a "ctrl+enter to send now" hint) and a
 * numbered list streamed above the box. A real dialog takes the box away or makes the Surface claim
 * a modal, and those end the send on their own.
 */
function framedCueGrew(before: Snap, after: Snap): boolean {
  return CUE_RANK[after.cueStrength] > CUE_RANK[before.cueStrength];
}

/**
 * How long after S2 the late witness reads. Claude Code 2.1.301 empties the box one redraw before it
 * draws the queued row (lab, 2026-10-16: the row stood there 0.6 s after the receipt).
 */
const LATE_WITNESS_MS = 300;

/** How many rows above a queued hint are read for the queued texts. */
const QUEUED_SCAN_ROWS = 24;

/**
 * Whether a read shows a text as a message the harness queued, by the profile's own drawing of one
 * (`keys.queuedRow`): a hint row above the box, and over it, past at most `hintGap` blank rows, the
 * queued texts. Each starts on a row the pattern matches, its wrapped rows indented under it. One of
 * them, joined and whitespace-free, must equal the text. Rows inside the box are never read.
 */
function showsQueued(snap: Snap, queuedRow: QueuedRow | undefined, text: string): boolean {
  if (queuedRow === undefined || snap.frame === null || wsFree(text).length === 0) return false;
  const start = new RegExp(queuedRow.pattern, "u");
  const hint = new RegExp(queuedRow.hint, "u");
  const want = wsFree(text);
  const above = snap.texts.slice(0, snap.frame.top);
  for (let at = above.length - 1; at >= 0; at--) {
    if (!hint.test(above[at]!)) continue;
    let i = at - 1;
    for (let gap = 0; i >= 0 && gap < queuedRow.hintGap && above[i]!.trim().length === 0; gap++) i--;
    // Upward through the queued texts: an indented row waits for the row that starts its text.
    let wrapped: string[] = [];
    for (const floor = Math.max(0, i - QUEUED_SCAN_ROWS); i >= floor; i--) {
      const row = above[i]!;
      const head = start.exec(row);
      if (head !== null) {
        if (wsFree([head.groups?.["text"] ?? "", ...wrapped].join("")) === want) return true;
        wrapped = [];
        continue;
      }
      if (!/^\s+\S/u.test(row)) break;
      wrapped = [row.trim(), ...wrapped];
    }
  }
  return false;
}

/** Reads in a row with no frame before a queued send counts the box as gone: one may be a torn read. */
const FRAMELESS_READS = 2;

/**
 * Whether the Surface claims a modal while the box is found. A read with no box (a torn read, a
 * redraw) claims no modal here: two of those in a row count instead (FRAMELESS_READS).
 */
function modalAtBox(snap: Snap): boolean {
  return snap.frame !== null && snap.surface.modal !== "none";
}

/** The non-blank rows under a frame's bottom edge. */
function rowsBelow(snap: Snap, frame: Frame): number {
  let n = 0;
  for (let i = frame.bottom + 1; i < snap.texts.length; i++) if (snap.texts[i]!.trim().length > 0) n++;
  return n;
}

/** The rows above a frame, the volatile band over the top edge left out, trailing blanks cut. */
function transcriptAbove(snap: Snap, frame: Frame): string[] {
  const end = frame.volatile.above === null ? frame.top : frame.volatile.above.first;
  const rows = snap.texts.slice(0, end).map((t) => t.trimEnd());
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  return rows;
}

/**
 * Whether everything outside the box stayed put between two reads of a framed pane: the transcript
 * above (it may scroll up by as many rows as the box grew, plus one), the same count of rows under
 * the box (a popup adds rows there), and no modal cue. The volatile band over the box may change.
 */
function outsideUnchanged(before: Snap, after: Snap): boolean {
  if (before.frame === null || after.frame === null) return false;
  if (cueAppeared(before, after)) return false;
  if (rowsBelow(before, before.frame) !== rowsBelow(after, after.frame)) return false;
  return aboveUnchanged(before, after);
}

/**
 * Whether the rows of `after` only lost text against `before`: each non-blank row of `after` stands,
 * in the same order, among the non-blank rows of `before`. A row that went blank, rows that vanished
 * and moved the rest, rows scrolled off the top all pass; a row with new text (a dialog, a line of
 * output, a timer that ticked) fails. A manual send allows this above the box.
 */
function lostTextOnly(before: readonly string[], after: readonly string[]): boolean {
  const kept = before.map((row) => row.trimEnd()).filter((row) => row.length > 0);
  let k = 0;
  for (const row of after) {
    const text = row.trimEnd();
    if (text.length === 0) continue;
    while (k < kept.length && kept[k] !== text) k++;
    if (k === kept.length) return false;
    k++;
  }
  return true;
}

/**
 * What a send into a running turn asks of a framed pane: no modal cue grew and the rows under the box
 * keep their count. The transcript above may change, because the running turn prints there while the
 * text goes in (live on Claude Code 2.1.301: the reply streams above the box).
 */
function turnOutsideUnchanged(before: Snap, after: Snap): boolean {
  if (before.frame === null || after.frame === null) return false;
  if (framedCueGrew(before, after)) return false;
  return rowsBelow(before, before.frame) === rowsBelow(after, after.frame);
}

/**
 * Whether the harness takes a message typed and entered while its turn runs: its profile says Enter
 * queues, for a version the binary reported, on a range that is not revoked. A provisional version
 * counts, unless the nearest older range it borrows is revoked. Every send into a turn is probed,
 * whatever the status: a dialog can open at any moment of a turn.
 */
function queuesInTurn(match: ProfileMatch | null): boolean {
  if (match === null || match.version === null || match.status === "revoked" || match.range?.status === "revoked") return false;
  return match.profile.keys.enterWhileRunning === "queues";
}

/**
 * Why a request may not go into a running turn, or null when it may: the harness must queue; nothing
 * may be open at the box (a popup above or under it that the frame walks past, read by the frameless
 * cues); and what the box would hold once Enter goes out must not be a command (a request in mode
 * command, or a box text plus the new text that starts with a reserved lead). Discard always may.
 */
function turnRefusal(state: RunState, s0: Snap, frame: Frame): Ended | null {
  const { surface } = s0;
  const { request } = state;
  if (!queuesInTurn(state.match)) return new Ended("refused", "turn_running", { surface, detail: TURN_RUNNING });
  if (s0.bareCues === "strong") return new Ended("refused", "not_free", { surface, detail: OPEN_AT_BOX });
  if (request.mode === "discard") return null;
  const text = sendLines(request.text).join("");
  const box = boxText(frame);
  const goesOut = request.mode === "append" ? box + text : request.mode === "submit" ? box : text;
  const leads = state.match?.profile.reservedLeads ?? GENERIC_LEADS;
  if (request.mode === "command" || state.command || reservedLead(goesOut, leads) !== null || (request.mode === "submit" && reservedLead(text, leads) !== null)) {
    return new Ended("refused", "turn_running", { surface, detail: COMMAND_IN_TURN });
  }
  return null;
}

/** The detail of a send refused because the turn runs. */
const TURN_RUNNING = "The agent is working, and this harness does not take a message during a turn.";
/** The detail of a command refused because the turn runs. */
const COMMAND_IN_TURN = "A command waits until the turn ends.";
/** The detail of a send into a turn refused because something is open at the box (a popup over or under it). */
const OPEN_AT_BOX = "Something is open at the input box.";
/**
 * The detail of a queued send whose Enter met a dialog. Measured on Claude Code 2.1.301 (2026-10-16):
 * an Enter that lands 0, 25, 50, 100 or 200 ms after a permission dialog draws answers it with the
 * dialog's first option, so the person must look at the card before answering it again.
 */
const DIALOG_AFTER_ENTER = "A dialog opened as the message went in. Check the card before you answer it.";

/** {@link aboveUnchanged} for a manual send: the transcript above the box may lose text, never gain it. */
function aboveLostOnly(before: Snap, after: Snap): boolean {
  if (before.frame === null || after.frame === null) return false;
  return lostTextOnly(transcriptAbove(before, before.frame), transcriptAbove(after, after.frame));
}

/** What a manual send asks of a framed pane: no modal cue grew, and the transcript above the box only lost text. */
function manualOutsideUnchanged(before: Snap, after: Snap): boolean {
  return !cueAppeared(before, after) && aboveLostOnly(before, after);
}

/** {@link outsideUnchanged} for a `command`: the transcript above the box only; its popup may fill the rows under it. */
function aboveUnchanged(before: Snap, after: Snap): boolean {
  if (before.frame === null || after.frame === null) return false;
  const a = transcriptAbove(before, before.frame);
  const b = transcriptAbove(after, after.frame);
  const grew = after.frame.bottom - after.frame.top - (before.frame.bottom - before.frame.top);
  for (let shift = 0; shift <= Math.max(0, grew) + 1; shift++) {
    const tail = a.slice(shift);
    if (tail.length === b.length && tail.every((row, i) => row === b[i])) return true;
  }
  return false;
}

/** The lines with the first one's lead character cut: a shell line's `!` turns into the box's prompt glyph. */
function withoutLead(lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const first = lines[0]!.trimStart();
  return [first.slice(1).trimStart(), ...lines.slice(1)];
}

/** A mode marker a harness may draw in front of a command's text once it read the lead: `!`, `$`, `>`. */
const MODE_MARKER = /^\s*[^\p{L}\p{N}\s]{1,3}/u;

/**
 * Whether the box holds a command's text: as written, with its lead cut, or with the lead turned into
 * a mode marker in front of the rest (`! echo ok` for `!echo ok`). White space and wrapping are
 * ignored, as in {@link boxMatches}.
 */
export function commandBoxMatches(box: string, prefix: string, lines: readonly string[], collapse: RegExp | null): boolean {
  if (boxMatches(box, prefix, lines, collapse)) return true;
  const rest = withoutLead(lines);
  if (boxMatches(box, prefix, rest, collapse)) return true;
  const marker = MODE_MARKER.exec(box);
  return marker !== null && boxMatches(box.slice(marker[0].length), prefix, rest, collapse);
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/u.test(ch);
}

/**
 * Whether the box text equals `prefix` then each line, white space and wrapping ignored. A line may
 * also show as the profile's collapse form (a long paste the harness folded), whose line count, if it
 * carries one, must say one line: each written line is its own write.
 */
export function boxMatches(box: string, prefix: string, lines: readonly string[], collapse: RegExp | null): boolean {
  let p = 0;
  const skip = (): void => {
    while (isSpace(box[p])) p++;
  };
  const eat = (part: string): boolean => {
    let q = p;
    for (const ch of wsFree(part)) {
      while (isSpace(box[q])) q++;
      if (!box.startsWith(ch, q)) return false;
      q += ch.length;
    }
    p = q;
    return true;
  };
  const eatCollapse = (): boolean => {
    if (collapse === null) return false;
    skip();
    collapse.lastIndex = p;
    const m = collapse.exec(box);
    if (m === null || m.index !== p) return false;
    const lineCount = m.groups?.lines;
    if (lineCount !== undefined && Number(lineCount) > 1) return false;
    p += m[0].length;
    return true;
  };
  if (!eat(prefix)) return false;
  for (const line of lines) {
    const at = p;
    if (eat(line)) continue;
    p = at;
    if (!eatCollapse()) return false;
  }
  skip();
  return p === box.length;
}

/** Where the probe character landed on a pane with no frame: the row and the index in its plain text. */
interface Landing {
  readonly row: number;
  readonly index: number;
  /** The plain text of that row with the probe in it. */
  readonly probed: string;
  /** The probe's length in UTF-16 units. */
  readonly width: number;
}

/** The part of the probed row after the probe: what stays right of the typed text. */
function afterProbe(landing: Landing): string {
  return landing.probed.slice(landing.index + landing.width);
}

/**
 * Whether every row under `row` in `before` still reads the same in `after`, or went blank: a hint
 * that hides once the box holds a character. By default rows are matched by screen row: a read is
 * the viewport, so row i is the same screen row in both, and a harness with no frame keeps its
 * footer there while the box grows upward. A multiplexer may leave out the trailing blank rows
 * (Herdr's pane read does, live on Codex 0.163.0 once its hint row hid), so the two reads may differ
 * in length; a row a read left out is blank. `offset` moves the match when the box itself moved. A
 * row that shows other text fails: a list under a search field that narrows to the typed text is
 * not a hint.
 */
function belowHeldOrBlank(before: readonly string[], after: readonly string[], row: number, offset = 0): boolean {
  const end = Math.max(before.length, after.length - offset);
  for (let i = row + 1; i < end; i++) {
    const now = after[i + offset] ?? "";
    if (now.trim().length > 0 && wsFree(now) !== wsFree(before[i] ?? "")) return false;
  }
  return true;
}

/** How many times `needle` stands in the rows. */
function countIn(rows: readonly string[], needle: string): number {
  let n = 0;
  for (const row of rows) n += row.split(needle).length - 1;
  return n;
}

/**
 * The probe's landing on a pane with no frame: exactly one row of the read changed, inside the bottom
 * window, and the change is the probe character put in (blanks next to it may appear where a faint
 * placeholder stood). Null on anything else.
 *
 * With `freeBelow` (a manual send) see {@link looseLanding}.
 */
export function probeLanding(before: readonly string[], after: readonly string[], probe: string, options: { readonly freeBelow?: boolean } = {}): Landing | null {
  if (options.freeBelow === true) return looseLanding(before, after, probe);
  const endA = contentEnd(before);
  const endB = contentEnd(after);
  const end = Math.max(endA, endB);
  let changed = -1;
  for (let i = 0; i < end; i++) {
    if ((before[i] ?? "") === (after[i] ?? "")) continue;
    if (changed >= 0) return null;
    changed = i;
  }
  if (changed < 0 || changed < end - CLUSTER_ROWS) return null;
  const was = before[changed] ?? "";
  const now = after[changed] ?? "";
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head++;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail++;
  if (was.length - head - tail !== 0) return null;
  const put = now.slice(head, now.length - tail);
  if (put.trim() !== probe) return null;
  return { row: changed, index: head + put.indexOf(probe), probed: now, width: probe.length };
}

/**
 * The probe's landing on a pane with no frame, for a manual send. The probe stands exactly once more
 * in the read than at S0, on the lowest row of the bottom window that holds one more than before:
 * the landing row. Its text up to the probe (blanks cut) must start the row S0 had there, or a row
 * of S0 lower down when rows above vanished and moved the box up; what followed on that row may
 * change. The rows above may only lose text (a welcome picture that hides once the box holds a
 * character, live on a fresh Codex 0.163.0), never gain it. A row under it may go blank (the hint
 * row Codex 0.162.1 and 0.163.0 hide), never show other text. `row` is the landing row in S0's rows.
 */
function looseLanding(before: readonly string[], after: readonly string[], probe: string): Landing | null {
  if (countIn(after, probe) !== countIn(before, probe) + 1) return null;
  const win = bottomWindow(after);
  let row = -1;
  for (let i = win.end - 1; i >= win.first && row < 0; i--) if (countIn([after[i] ?? ""], probe) > countIn([before[i] ?? ""], probe)) row = i;
  if (row < 0) return null;
  const now = after[row]!;
  const index = now.indexOf(probe);
  const head = now.slice(0, index).trimEnd();
  for (let from = row; from < contentEnd(before); from++) {
    if (!(before[from] ?? "").startsWith(head)) continue;
    if (!lostTextOnly(before.slice(0, from), after.slice(0, row))) continue;
    if (!belowHeldOrBlank(before, after, from, row - from)) continue;
    return { row: from, index, probed: now, width: probe.length };
  }
  return null;
}

/**
 * Whether a failed probe left its character where one Backspace takes it out: it stands exactly once
 * in the read, and in the box. With a frame that is the interior; with none it is a row of the bottom
 * window that reads as it did at S0 once the character is cut, the landing row.
 */
export function probeInBox(s0: { readonly plain: readonly string[] }, now: { readonly texts: readonly string[]; readonly plain: readonly string[]; readonly frame: Frame | null }, probe: string): boolean {
  if (countIn(now.texts, probe) !== 1) return false;
  const row = now.texts.findIndex((text) => text.includes(probe));
  if (now.frame !== null) return row >= now.frame.interior.first && row <= now.frame.interior.last;
  const win = bottomWindow(now.texts);
  if (row < win.first || row >= win.end) return false;
  return wsFree((now.plain[row] ?? "").replace(probe, "")) === wsFree(s0.plain[row] ?? "");
}

/** The index of the last row with any non-blank character, or -1. */
function lastFilled(rows: readonly string[]): number {
  return rows.findLastIndex((row) => row.trim().length > 0);
}

/** The whole read as one compare string, white space dropped. */
function flat(rows: readonly string[]): string {
  return wsFree(rows.join(""));
}

/** On a pane with no frame: the rows as they should read once `typed` stands where the probe stood. */
function predictedRows(base: readonly string[], landing: Landing, typed: string): string[] {
  const rows = [...base];
  rows[landing.row] = landing.probed.slice(0, landing.index) + typed + afterProbe(landing);
  return rows;
}

/**
 * S1 of a manual send on a pane with no frame: the lowest row of the bottom window from which the
 * read goes on with the landing row up to the probe's spot and then the typed text (wrapped or not)
 * is the box. The rows above it may only lose text against S0's rows above the landing row (they
 * may scroll up, a welcome picture may hide), never gain it. What follows the text on that row may
 * differ, and a row under it may go blank (a hint that hides).
 */
function typedOnLanding(s0: readonly string[], now: readonly string[], landing: Landing, typed: string): boolean {
  if (!belowHeldOrBlank(s0, now, landing.row)) return false;
  const line = flat([landing.probed.slice(0, landing.index) + typed]);
  const win = bottomWindow(now);
  for (let row = win.end - 1; row >= win.first; row--) {
    if (!flat(now.slice(row)).startsWith(line)) continue;
    return lostTextOnly(s0.slice(0, landing.row), now.slice(0, row));
  }
  return false;
}

/**
 * S2 of a manual send on a pane with no frame: the landing row as S0 read it (the empty box) stands
 * again in the bottom window, and from that row down nothing holds the typed text. The transcript
 * above it may now show the text as the person's message. A landing row that read blank at S0 proves
 * nothing and never passes here.
 */
function emptyBoxBack(s0: readonly string[], now: readonly string[], landing: Landing, typed: string): boolean {
  return emptiedTo(s0[landing.row] ?? "", now, typed);
}

/**
 * Whether a row of the bottom window reads as `empty` (the box with nothing in it: its prompt glyph,
 * a placeholder's plain part) and from that row down nothing holds the typed text. An empty form that
 * is blank proves nothing and never passes.
 */
function emptiedTo(emptyRow: string, now: readonly string[], typed: string): boolean {
  const empty = wsFree(emptyRow);
  if (empty.length === 0) return false;
  const win = bottomWindow(now);
  for (let i = win.end - 1; i >= win.first; i--) {
    if (wsFree(now[i] ?? "") !== empty) continue;
    return !flat(now.slice(i)).includes(flat([typed]));
  }
  return false;
}

/** Where a text stands in a read with no frame: its row, and the row's plain text before it (the box's head). */
interface Located {
  readonly row: number;
  readonly head: string;
  /** The text as it was found: as written, with a command's lead cut, or only its first characters when the box holds a different text. */
  readonly text: string;
  /** True when only the start of the text stands there: the box holds a different text than the one asked for. */
  readonly partial: boolean;
}

/** The shortest start of `text` that is `length` characters long with white space dropped. */
function startOf(text: string, length: number): string {
  let out = "";
  for (const ch of text) {
    if (flat([out]).length >= length) break;
    out += ch;
  }
  return out;
}

/** How many leading characters `a` and `b` share. */
function sharedStart(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/**
 * The lowest spot of the bottom window where the read goes on with `text` (wrapped or not, white space
 * ignored): on a pane with no frame, the box that holds a text typed earlier. Null when it stands
 * nowhere there. With `partial`, a spot that goes on with the start of the text counts too, when that
 * start is at least two characters and at most two short of the whole text: the box a person's own
 * Backspace shortened. A row that shares less (a footer that starts alike) is not the box.
 * The lowest row wins, so an echo of the same text higher up (the harness's history) never beats the box.
 */
export function locateText(plain: readonly string[], text: string, partial = false): Located | null {
  const want = flat([text]);
  if (want.length === 0) return null;
  const first = [...want][0]!;
  const least = partial ? Math.min(want.length, Math.max(2, want.length - 2)) : want.length;
  const win = bottomWindow(plain);
  for (let row = win.end - 1; row >= win.first; row--) {
    const line = plain[row] ?? "";
    let best: { index: number; shared: number } | null = null;
    for (let i = line.indexOf(first); i >= 0; i = line.indexOf(first, i + 1)) {
      const shared = sharedStart(flat([line.slice(i), ...plain.slice(row + 1, win.end)]), want);
      if (shared >= least && (best === null || shared > best.shared)) best = { index: i, shared };
    }
    if (best !== null) return { row, head: line.slice(0, best.index), text: best.shared === want.length ? text : startOf(text, best.shared), partial: best.shared < want.length };
  }
  return null;
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────

interface RunState {
  readonly request: SendRequest;
  readonly record: SendRecord;
  readonly target: SendTarget;
  readonly match: ProfileMatch | null;
  readonly lockKey: string;
  readonly deadline: number;
  readonly marks: { s0: Snap | null; s1: Snap | null; s2: Snap | null };
  readonly gaps: Partial<Record<SendStep, number>>;
  readonly keys: string[];
  probed: boolean;
  /** The screen at S0 took the manual Send (no profile, an unreadable overlay, a weak cue): the probe and S1 compare less. */
  manual: boolean;
  /** The text is a command: sent as one, or a draft that starts with a reserved lead (Submit and Discard of a command). */
  command: boolean;
  /** A Submit or Discard found the box holding another text than the request names (the person's own Backspace shortened it). */
  heldOther: boolean;
  /** S0 read a running turn on a harness that queues, or S2 saw the harness's queued row with the text: the receipt says `queued`. */
  queued: boolean;
  /**
   * The rows above the box moved while Collie typed, on a harness that queues, with everything else
   * held ({@link SendProtocol.aboveMovedInTurn}): a turn the screen does not mark (Claude Code 2.1.301
   * draws no spinner while the answer streams). From there the send takes the queued path; the receipt
   * says `queued` only on S0's running read or the S2 witness.
   */
  streamed: boolean;
  stepStart: number;
}

type Verdict = "pass" | "wait" | "fail";

/** What an end carries besides its outcome: the screen it saw, the rows hash, a sentence, and whether the pane had a frame. */
interface EndNote {
  surface?: Surface;
  rowsHash?: string;
  detail?: string;
  framed?: boolean;
  cap?: SendCap;
  /** The offers, when an end's own differ from the shared rules (a Submit or Discard to look at again). */
  offers?: SendOffer[];
}

/** A receipt being built, field by field. */
type ReceiptDraft = { -readonly [K in keyof SendReceipt]: SendReceipt[K] };

/** A row of the list of recent sends being built, field by field. */
type RowDraft = { -readonly [K in keyof SendReceiptRow]: SendReceiptRow[K] };

/** An answer being built, field by field. */
type AnswerDraft = { -readonly [K in keyof SendAnswer]: SendAnswer[K] };

/** The note of an end that saw `snap`, when it saw one. */
function sawNote(snap: Snap | null, note: EndNote): EndNote {
  if (snap !== null) note.surface = snap.surface;
  return note;
}

/** An answer with the note's screen, rows hash and sentence copied on where they are set. */
function answerWith(draft: AnswerDraft, note: EndNote): SendAnswer {
  if (note.surface !== undefined) draft.surface = note.surface;
  if (note.rowsHash !== undefined) draft.rowsHash = note.rowsHash;
  if (note.detail !== undefined) draft.detail = note.detail;
  if (note.cap !== undefined) draft.cap = note.cap;
  return draft;
}

/** A read that a step's own bound cut short, before the request's bound. The step decides what it means. */
class StepLate extends Error {
  constructor() {
    super("step bound");
  }
}

/** A crash answer with the pane as it reads now, so the person checks it before sending again. */
function withLook(answer: SendAnswer, look: Snap | null): SendAnswer {
  if (look === null) return answer;
  return {
    ...answer,
    surface: look.surface,
    rowsHash: look.rowsHash,
    detail: "The bridge restarted during this send, so Collie cannot say whether it went out. Check the screen before you send again.",
  };
}

class Ended extends Error {
  constructor(
    readonly outcome: SendOutcome,
    readonly reason: SendReason | undefined,
    readonly extra: EndNote = {},
  ) {
    super(`${outcome}${reason === undefined ? "" : `(${reason})`}`);
  }
}

/**
 * The Send Protocol for one bridge session. Holds no state of its own beyond what its ports hold: the
 * lock map, the gate's revisions, the request files and the ring.
 */
export class SendProtocol {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<SendAnswer>>();

  constructor(private readonly deps: SendDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * The newest settled requests for a pane, newest first, as the session page lists them (M56 spec 09).
   * The request files hold receipts only, so no row of the screen and no text can come out of here.
   */
  recent(paneId: string, limit = 10): SendReceiptRow[] {
    const rows: SendReceiptRow[] = [];
    for (const record of this.deps.store.list().toReversed()) {
      if (rows.length >= limit) break;
      const receipt = record.receipt;
      if (record.paneId !== paneId || receipt === undefined) continue;
      const row: RowDraft = { requestId: record.id, at: record.acceptedAt, mode: record.mode, outcome: receipt.outcome, keys: receipt.keys, gapsMs: receipt.gapsMs, harness: receipt.harness, version: receipt.version };
      if (receipt.reason !== undefined) row.reason = receipt.reason;
      if (receipt.cap !== undefined) row.cap = receipt.cap;
      if (receipt.queued === true) row.queued = true;
      rows.push(row);
    }
    return rows;
  }

  /** One request, start to receipt. Never throws for a pane's state; every end is an answer. */
  async handle(request: SendRequest, target: SendTarget): Promise<SendAnswer> {
    if (request.mode === "prepare") return this.prepare(target);
    const running = this.inFlight.get(request.id);
    if (running !== undefined) {
      // The same id while it runs: wait for it, then answer the stored receipt.
      await running;
      return this.handle(request, target);
    }
    const generation = this.deps.generation(target.paneId) ?? "gone";
    const accepted = this.deps.store.accept({
      id: request.id,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: generation,
      surfaceRevision: request.revision ?? 0,
      mode: request.mode,
      text: request.text,
    });
    if (accepted.kind === "id_reused") {
      // The stored request is someone else's; this refusal is not stored under its id.
      const receipt = this.receiptOf(this.bareState(request, accepted.record, target, null), "refused", "id_reused");
      return { receipt, offers: [], detail: "This request id was already used for another text." };
    }
    if (accepted.kind === "replay") {
      const stored = accepted.record.receipt;
      if (stored !== undefined) {
        const replay: SendAnswer = { receipt: stored, offers: offersFor(stored.outcome, stored.reason, stored.profileId !== null), replayed: true };
        // A send a crash cut short: read the pane now and report it beside the stored receipt.
        if (stored.outcome !== "unknown" || stored.reason !== "crash") return replay;
        return withLook(replay, await this.lookAfterCrash(request, accepted.record, target));
      }
      // Unsettled and not running here: the bridge died while it ran, and the start-up recovery has
      // not seen it. It ends `unknown` now, like recovery would end it, with the pane read as S2.
      const look = await this.lookAfterCrash(request, accepted.record, target);
      const state = this.bareState(request, accepted.record, target, null);
      state.marks.s2 = look;
      const receipt = this.receiptOf(state, "unknown", "crash");
      this.deps.store.settle(request.id, receipt);
      this.count(state, receipt);
      return withLook({ receipt, offers: offersFor("unknown", "crash", false), replayed: true }, look);
    }
    const work = this.run(request, accepted.record, target);
    this.inFlight.set(request.id, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(request.id);
    }
  }

  /**
   * After a crash: one fresh read of the pane (read, report), never a key. Null when the pane cannot
   * be read inside S0's bound. The request's own bound is long past, so the read gets a fresh one.
   */
  private async lookAfterCrash(request: SendRequest, record: SendRecord, target: SendTarget): Promise<Snap | null> {
    const match = await this.deps.profile(target.harness);
    const until = this.now() + BOUNDS.s0.ms;
    const state: RunState = { ...this.bareState(request, record, target, match), deadline: until };
    try {
      return await this.readNow(state, "crash", until);
    } catch (err) {
      if (err instanceof Ended || err instanceof StepLate) return null;
      throw err;
    }
  }

  /** The receipt a request that never settled gets after a restart (RequestStore.recover). */
  static crashReceipt(record: SendRecord): SendReceipt {
    return {
      requestId: record.id,
      session: record.session,
      paneId: record.paneId,
      paneGeneration: record.paneGeneration,
      harness: "-",
      version: null,
      profileId: null,
      profileStatus: null,
      textHash: record.textHash,
      textLength: record.textLength,
      s0: null,
      s1: null,
      s2: null,
      gapsMs: {},
      keys: [],
      outcome: "unknown",
      reason: "crash",
    };
  }

  private bareState(request: SendRequest, record: SendRecord, target: SendTarget, match: ProfileMatch | null): RunState {
    const at = this.now();
    return {
      request,
      record,
      target,
      match,
      lockKey: `${target.session}\u0000${target.paneId}`,
      deadline: record.acceptedAt + LOCK_BOUND_MS,
      marks: { s0: null, s1: null, s2: null },
      gaps: {},
      keys: [],
      probed: false,
      manual: false,
      command: request.mode === "command",
      heldOther: false,
      queued: false,
      streamed: false,
      stepStart: at,
    };
  }

  private receiptOf(state: RunState, outcome: SendOutcome, reason: SendReason | undefined, cap?: SendCap): SendReceipt {
    const { record, target, match } = state;
    const base: SendReceipt = {
      requestId: record.id,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: record.paneGeneration,
      harness: target.harness,
      version: match?.version ?? null,
      profileId: match?.profile.id ?? null,
      profileStatus: match?.status ?? null,
      textHash: record.textHash,
      textLength: record.textLength,
      s0: mark(state.marks.s0),
      s1: mark(state.marks.s1),
      s2: mark(state.marks.s2),
      gapsMs: { ...state.gaps },
      keys: [...state.keys],
      outcome,
    };
    const receipt: ReceiptDraft = { ...base };
    if (reason !== undefined) receipt.reason = reason;
    if (cap !== undefined) receipt.cap = cap;
    if (state.queued && (outcome === "sent" || outcome === "effective")) receipt.queued = true;
    return receipt;
  }

  private async prepare(target: SendTarget): Promise<SendAnswer> {
    const match = await this.deps.profile(target.harness);
    const state = this.bareState({ id: "prepare", text: "", mode: "prepare" }, prepareRecord(target, this.now()), target, match);
    try {
      const snap = await this.stableRead(state, "prepare");
      return { surface: snap.surface, rowsHash: snap.rowsHash, offers: prepareOffers(snap) };
    } catch (err) {
      if (err instanceof Ended) return answerWith({ offers: ["keys"] }, { ...err.extra, detail: err.extra.detail ?? err.message });
      throw err;
    }
  }

  private async run(request: SendRequest, record: SendRecord, target: SendTarget): Promise<SendAnswer> {
    const match = await this.deps.profile(target.harness);
    const state = this.bareState(request, record, target, match);
    const { locks } = this.deps;
    if (!locks.acquire(state.lockKey, record.id, state.deadline, this.now())) {
      return this.settle(state, new Ended("refused", "busy", { detail: "Another send on this pane is still running." }));
    }
    try {
      await this.steps(state);
      const note: EndNote = { framed: true };
      if (state.heldOther && record.mode === "submit") note.detail = HELD_OTHER;
      return this.settle(state, new Ended(record.mode === "discard" ? "discarded" : "sent", undefined, note));
    } catch (err) {
      if (err instanceof Ended) return this.settle(state, err);
      throw err;
    } finally {
      locks.release(state.lockKey, record.id);
    }
  }

  private settle(state: RunState, end: Ended): SendAnswer {
    const receipt = this.receiptOf(state, end.outcome, end.reason, end.extra.cap);
    this.deps.store.settle(state.record.id, receipt);
    this.count(state, receipt);
    const framed = end.extra.framed ?? (state.marks.s0?.frame ?? null) !== null;
    return answerWith({ receipt, offers: end.extra.offers ?? offersFor(end.outcome, end.reason, framed) }, end.extra);
  }

  /** The counters key of a request: harness, binary version, profile id and status, `-` where there is none. */
  private keyOf(state: RunState): CounterKey {
    const { target, match } = state;
    return { harness: target.harness === "" ? "-" : target.harness, version: match?.version ?? "-", profileId: match?.profile.id ?? "-", status: match?.status ?? "-" };
  }

  /**
   * One settled request into the counters, and a probed send that went out into the examples folder.
   * Never throws and never waits on anything: a counter is not a verdict.
   */
  private count(state: RunState, receipt: SendReceipt): void {
    const { ledger } = this.deps;
    if (ledger === undefined) return;
    try {
      const key = this.keyOf(state);
      const probed = receipt.keys.includes("probe");
      ledger.send(key, { outcome: receipt.outcome, reason: receipt.reason, probed });
      const s0 = state.marks.s0;
      if (probed && s0 !== null && (receipt.outcome === "sent" || receipt.outcome === "effective")) {
        const win = bottomWindow(s0.plainRaw);
        ledger.example({
          requestId: receipt.requestId,
          ...key,
          outcome: receipt.outcome,
          cluster: s0.plainRaw.slice(win.first, win.end),
          frame: s0.rowsHash,
          textLength: receipt.textLength,
        });
      }
    } catch (err) {
      console.warn(`[surface] counters failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── The steps ──

  private async steps(state: RunState): Promise<void> {
    const { request, match } = state;
    const profile = match?.profile ?? null;
    const lines = sendLines(request.text);
    const leads = profile?.reservedLeads ?? GENERIC_LEADS;
    const writes = request.mode === "send" || request.mode === "command" || request.mode === "append" || request.mode === "replace";

    if (writes) {
      const lead = request.mode === "command" ? null : reservedLead(lines[0] ?? "", leads);
      if (lead !== null) throw new Ended("refused", "reserved_lead", { detail: LEAD_ROUTES.get(lead) ?? `A text that starts with ${lead} has its own route.` });
      if (lines.length > 1 && profile === null) {
        throw new Ended("refused", "multiline", { detail: "This harness has no profile, so its newline key is unknown; send one line at a time." });
      }
    }
    // Submit and Discard name the text the box holds: a command's text may stand there with its lead read as a mode marker.
    if ((request.mode === "submit" || request.mode === "discard") && reservedLead(lines[0] ?? "", leads) !== null) state.command = true;
    const holds = (box: string): boolean => (state.command ? commandBoxMatches : boxMatches)(box, "", lines, collapseOf(match));

    this.begin(state);
    let s0 = await this.stableRead(state, "s0");
    state.marks.s0 = s0;
    state.manual = takesManualSend(s0.surface);
    this.checkGeneration(state, "refused");

    switch (request.mode) {
      case "submit": {
        const located = this.typedBox(state, s0, holds, lines);
        this.lap(state, "s0");
        state.marks.s1 = s0;
        await this.commit(state, s0);
        this.lap(state, "commit");
        if (s0.frame !== null) await this.awaitSent(state, s0, null, lines);
        else await this.awaitBareEmpty(state, located);
        this.lap(state, "s2");
        await this.lateWitness(state, lines);
        return;
      }
      case "discard": {
        const located = this.typedBox(state, s0, holds, lines);
        if (s0.frame === null && located === null) throw new Ended("refused", "not_free", { surface: s0.surface, detail: "The box no longer holds this text." });
        this.lap(state, "s0");
        if (located === null) await this.clear(state, s0);
        else await this.clearBare(state, located);
        this.lap(state, "clear");
        return;
      }
      case "replace": {
        const frame = this.draftFrame(state, s0);
        // S0 ends with its two reads; emptying the box is its own step with its own bound.
        this.lap(state, "s0");
        if (boxText(frame).length > 0) {
          s0 = await this.clear(state, s0);
          state.marks.s0 = s0;
          this.lap(state, "clear");
        }
        break;
      }
      case "append":
        this.draftFrame(state, s0);
        break;
      case "send":
      case "command":
        this.gateSend(state, s0);
        break;
      case "prepare":
        return;
    }
    if (request.mode !== "replace") this.lap(state, "s0");

    const prefix = request.mode === "append" && s0.frame !== null ? boxText(s0.frame) : "";
    const text = lines.join("");
    // A manual send (the person confirmed a screen that is not free) is always probed, and so is any
    // send into a running turn (a send, Add to it, Replace): a dialog can open at any moment of a turn.
    state.probed =
      state.queued ||
      s0.frame === null ||
      match === null ||
      match.status !== "verified" ||
      (!isFree(s0.surface) && request.mode !== "append" && request.mode !== "replace") ||
      ([...text].length >= 1 && [...text].length <= SHORT_TEXT);
    let landing: Landing | null = null;
    if (state.probed) landing = await this.probe(state, s0, prefix);
    this.lap(state, "probe");

    await this.write(state, lines);
    this.lap(state, "write");

    const s1 = await this.awaitTyped(state, s0, landing, prefix, lines);
    state.marks.s1 = s1;
    this.lap(state, "s1");
    this.checkGeneration(state, "typed_not_submitted");

    await this.commit(state, s1);
    this.lap(state, "commit");
    await this.awaitSent(state, s0, landing, lines);
    this.lap(state, "s2");
    await this.lateWitness(state, lines);
  }

  /**
   * The S0 rule for a plain send: free goes ahead; a draft is refused with the offers; unknown(no-match)
   * needs the person's rows hash. A running turn with no modal over a found box: an empty box goes
   * ahead when the harness queues (the receipt says `queued`), a draft is refused with its offers, and
   * a harness that does not queue, or a command, is refused `turn_running`.
   */
  private gateSend(state: RunState, s0: Snap): void {
    const { surface } = s0;
    if (isFree(surface)) return;
    if (surface.turn === "running" && surface.modal === "none" && s0.frame !== null && (surface.composer === "empty" || surface.composer === "draft")) {
      this.gateTurn(state, s0, s0.frame);
      if (surface.composer === "draft") {
        state.queued = false;
        throw new Ended("refused", "draft_present", { surface, framed: true, detail: "The box already holds a draft." });
      }
      return;
    }
    if (surface.turn === "idle" && surface.modal === "none" && surface.composer === "draft") {
      throw new Ended("refused", "draft_present", { surface, framed: s0.frame !== null, detail: "The box already holds a draft." });
    }
    if (takesManualSend(surface)) {
      if (state.request.rowsHash === undefined) {
        throw new Ended("refused", "unconfirmed", { surface, rowsHash: s0.rowsHash, detail: "Collie cannot read this screen. Check the pane, then tap Type here." });
      }
      if (state.request.rowsHash !== s0.rowsHash) {
        throw new Ended("refused", "stale_surface", { surface, rowsHash: s0.rowsHash, detail: "The screen moved since you looked." });
      }
      this.gateCap(state, s0);
      return;
    }
    throw new Ended("refused", "not_free", { surface, detail: "The input box is not free." });
  }

  /**
   * The cap (M56 spec 09): after N manual sends on one harness and version inside 24 hours, the manual
   * Send takes one more confirm. The refusal names the count and the version, files the frame hash for
   * the lab, and offers the commit again; the next commit carries `capAck`. It only adds a tap: the
   * manual Send and the key pad stay, and the counters never change a verdict.
   */
  private gateCap(state: RunState, s0: Snap): void {
    const { ledger } = this.deps;
    if (ledger === undefined) return;
    const key = this.keyOf(state);
    try {
      const cap = ledger.capState(key.harness, key.version);
      if (cap.reached && state.request.capAck !== true) {
        ledger.inbox({ harness: key.harness, version: key.version, profileId: key.profileId, status: key.status, frame: s0.rowsHash, count: cap.count });
        throw new Ended("refused", "unconfirmed", {
          surface: s0.surface,
          rowsHash: s0.rowsHash,
          cap: { count: cap.count, limit: cap.limit, harness: key.harness, version: key.version },
          detail: `You typed past a screen Collie cannot read ${String(cap.count)} times on ${key.version === "-" ? key.harness : `${key.harness} ${key.version}`} in the last day. Check the screen, then confirm once more to type.`,
        });
      }
      ledger.noteManual(key);
    } catch (err) {
      if (err instanceof Ended) throw err;
      console.warn(`[surface] cap failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Submit and Discard after `typed_not_submitted`: the box the text went into. A framed box that holds
   * the text goes ahead as it always did. Anything else (a framed box that shows other text, or a pane
   * with no frame) goes ahead on the rows hash the person saw with that answer, and only while the rows
   * still hash the same: the person read the screen and chose. With no frame the text is looked up in
   * the bottom window, so S2 and the clear know the box; null when it stands nowhere there, or with a
   * frame.
   */
  private typedBox(state: RunState, s0: Snap, holds: (box: string) => boolean, lines: readonly string[]): Located | null {
    const { surface, frame } = s0;
    if (frame !== null) {
      if (holds(boxText(this.draftFrame(state, s0)))) return null;
      state.heldOther = true;
    }
    if (frame === null && !takesManualSend(surface) && !isFree(surface)) throw new Ended("refused", "not_free", { surface, detail: "The input box is not free." });
    const hash = state.request.rowsHash;
    if (hash === undefined) throw new Ended("refused", "not_free", { surface, detail: "The box no longer holds this text." });
    if (hash !== s0.rowsHash) {
      throw new Ended("refused", "stale_surface", { surface, rowsHash: s0.rowsHash, offers: ["submit", "discard", "keys"], detail: "The screen moved since you looked. Check it, then tap Submit or Discard again." });
    }
    if (frame !== null) return null;
    const found = locateText(s0.plain, lines.join(""), true) ?? (state.command ? locateText(s0.plain, withoutLead(lines).join(""), true) : null);
    if (found?.partial === true) state.heldOther = true;
    return found;
  }

  /**
   * The frame of a box that may hold a draft (append, replace, submit, discard), or a refusal. While
   * the turn runs the box is open on a harness that queues (what goes in waits for the turn's end);
   * on one that does not, the turn is the refusal.
   */
  private draftFrame(state: RunState, s0: Snap): Frame {
    const { surface, frame } = s0;
    if (frame === null || surface.turn === "unknown" || surface.modal !== "none" || (surface.composer !== "draft" && surface.composer !== "empty")) {
      throw new Ended("refused", "not_free", { surface, detail: "The input box is not free." });
    }
    if (surface.turn === "running") this.gateTurn(state, s0, frame);
    return frame;
  }

  /** Anything that goes into a turn S0 read as running (a send, Add to it, Replace, Submit, Discard) meets {@link turnRefusal}, then is queued. */
  private gateTurn(state: RunState, s0: Snap, frame: Frame): void {
    const refusal = turnRefusal(state, s0, frame);
    if (refusal !== null) throw refusal;
    state.queued = true;
  }

  /**
   * The amended rule of S1 (ARCHITECTURE.md, Send Protocol, 2026-10-16): on a harness whose Enter
   * queues, a send that is not a command may see the rows ABOVE the box move while Collie types. All
   * else must hold: the frame is there, the rows under the box keep their count, the cue read inside
   * the frame is the same, and the Surface claims no modal. When the rows above moved under these
   * terms, the send takes the queued path from there and this returns true. Movement under the box, a
   * changed cue inside the frame, a missing frame or a modal claim return false, and the caller
   * refuses or ends as before.
   */
  private aboveMovedInTurn(state: RunState, s0: Snap, snap: Snap): boolean {
    if (state.queued || state.manual || state.command) return false;
    const { mode } = state.request;
    if (mode !== "send" && mode !== "append" && mode !== "replace") return false;
    if (s0.frame === null || snap.frame === null || aboveUnchanged(s0, snap)) return false;
    if (snap.cueStrength !== s0.cueStrength || rowsBelow(s0, s0.frame) !== rowsBelow(snap, snap.frame) || modalAtBox(snap)) return false;
    if (turnRefusal(state, s0, s0.frame) !== null) return false;
    state.streamed = true;
    return true;
  }

  private checkGeneration(state: RunState, outcome: "refused" | "typed_not_submitted"): void {
    const now = this.deps.generation(state.target.paneId);
    if (now === state.record.paneGeneration) return;
    throw new Ended(outcome, outcome === "refused" ? "pane_gone" : "changed", { detail: "The pane holds another program now." });
  }

  private begin(state: RunState): void {
    state.stepStart = this.now();
  }

  private lap(state: RunState, step: SendStep): void {
    const now = this.now();
    state.gaps[step] = now - state.stepStart;
    state.stepStart = now;
  }

  /** Ends the request when its bound passed or another request took the lock after it. */
  private guard(state: RunState): void {
    const now = this.now();
    if (now > state.deadline) throw new Ended("unknown", "bound", { detail: "The send ran past its bound." });
    if (!this.deps.locks.owns(state.lockKey, state.record.id, now) && state.record.id !== "prepare") {
      throw new Ended("unknown", "lost_lock", { detail: "The send lost its lock." });
    }
  }

  /**
   * A promise that loses to the request's deadline, or to a step's own end (`until`) when that comes
   * first. The request's deadline ends the request `unknown`; a step's end throws StepLate for the step.
   */
  private async within<T>(state: RunState, work: Promise<T>, until = state.deadline): Promise<T> {
    const end = Math.min(until, state.deadline);
    // The request's bound wins when both have passed: the request ends, not just the step.
    const lateError = (): Error =>
      this.now() < state.deadline && until < state.deadline ? new StepLate() : new Ended("unknown", "bound", { detail: "The multiplexer did not answer inside the bound." });
    const left = end - this.now();
    if (left <= 0) throw lateError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(lateError()), left);
    });
    try {
      return await Promise.race([work, late]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** One read, cut at the step's end (`until`) or the request's bound, whichever comes first. */
  private async read(state: RunState, step: string, until = state.deadline): Promise<Snap | null> {
    this.guard(state);
    return this.readNow(state, step, until);
  }

  /** A read without the lock check, for a look after a crash. */
  private async readNow(state: RunState, step: string, until = state.deadline): Promise<Snap | null> {
    const { paneId, harness } = state.target;
    const grid = await this.within(state, this.deps.mux.readGrid(paneId, { scope: "viewport", lines: SEND_READ_LINES, styling: "preserve" }), until);
    const gateRevision = this.deps.gate.noteRead(paneId);
    if (!grid.ok) return null;
    const rows = splitLines(parseAnsi(grid.value.text));
    const idle = state.match?.profile.idle ?? null;
    const frame = idle === null ? null : findInputFrame(rows, idle);
    const blocks = readerBlocks(rows, harness);
    const ask =
      this.deps.asks === undefined
        ? liftAsk(blocks, grid.value.revision)
        : this.deps.asks.publish(paneId, this.deps.generation(paneId) ?? "gone", liftDialog(blocks), askLifetimeOf(state.match));
    const { surface } = surfaceOfScreen({ seq: 0, source: "screen", at: this.now(), revision: grid.value.revision, rows, ask }, idle);
    const texts = rows.map((row) => rowText(row).trimEnd());
    const plainRaw = rows.map(plainOf);
    const plain = plainRaw.map(steadyRow);
    const win = bottomWindow(texts);
    this.deps.ring.push({ requestId: state.record.id, step, at: this.now(), rows: texts });
    return {
      revision: grid.value.revision,
      gateRevision,
      rows,
      texts,
      plain,
      plainRaw,
      frame,
      surface,
      cueStrength: readCues(rows, frame).strength,
      // The box's own rows are cut out first: they hold the person's text, which may look like a list.
      bareCues: readCues(frame === null ? rows : [...rows.slice(0, frame.interior.first), ...rows.slice(frame.interior.last + 1)], null).strength,
      hash: shortHash(texts.join("\n")),
      // A running row's timer is masked (steadyRow): a ticking timer is not a screen the person did not see.
      rowsHash: shortHash(plain.slice(win.first, win.end).join("\n")),
    };
  }

  /**
   * S0: two reads in separate mux calls inside S0's bound (2 reads, 1200 ms); the box (or the bottom
   * window, with no frame) must be identical. Nothing is written before S0 passes, so a slow S0 is a
   * refusal (`bound`), never an unknown.
   */
  private async stableRead(state: RunState, step: string): Promise<Snap> {
    const until = Math.min(this.now() + BOUNDS.s0.ms, state.deadline);
    const late = (): Ended => new Ended("refused", "bound", { detail: `The screen did not read twice inside ${String(BOUNDS.s0.ms)} ms.` });
    const readInBound = async (): Promise<Snap | null> => {
      try {
        const snap = await this.read(state, step, until);
        if (this.now() > until) throw late();
        return snap;
      } catch (err) {
        if (err instanceof StepLate) throw late();
        throw err;
      }
    };
    const first = await readInBound();
    if (this.now() + S0_GAP_MS > until) throw late();
    await this.sleep(S0_GAP_MS);
    const second = await readInBound();
    if (first === null || second === null) throw new Ended("refused", "pane_gone", { detail: "The pane could not be read." });
    // With a frame only the box is compared: the volatile rows around it (a spinner, a timer, a token
    // count, a statusline) move on their own while a turn runs. The box is compared with its faint
    // runs dropped: a placeholder that changes on an empty box (Claude Code's "Press up to edit
    // queued messages" going as the queue is taken) is not a moved box. With no frame the bottom
    // window is compared with its running rows masked, for the same reason.
    const key = (snap: Snap): string => {
      if (snap.frame !== null) return snap.plain.slice(snap.frame.top, snap.frame.bottom + 1).join("\n");
      const win = bottomWindow(snap.plain);
      return snap.plain.slice(win.first, win.end).join("\n");
    };
    if ((first.frame === null) !== (second.frame === null) || key(first) !== key(second)) {
      throw new Ended("refused", "not_free", { surface: second.surface, detail: "The input box moved between two reads." });
    }
    return second;
  }

  /** Reads until the test passes or fails, inside the step's (reads, ms) bound. Null when the bound ran out. */
  private async poll(
    state: RunState,
    step: string,
    bound: { reads: number; ms: number },
    test: (snap: Snap) => Verdict,
  ): Promise<{ snap: Snap | null; verdict: Verdict; reads: number }> {
    const until = Math.min(this.now() + bound.ms, state.deadline);
    let gap = FIRST_GAP_MS;
    let last: Snap | null = null;
    let reads = 0;
    while (reads < bound.reads) {
      const left = until - this.now();
      if (left <= 0) break;
      await this.sleep(Math.min(gap, left));
      gap *= 2;
      reads++;
      let snap: Snap | null;
      try {
        snap = await this.read(state, step, until);
      } catch (err) {
        // The step's own bound cut the read short: the step ran out, like a read that came back late.
        if (err instanceof StepLate) break;
        throw err;
      }
      if (snap === null) continue;
      last = snap;
      const verdict = test(snap);
      if (verdict !== "wait") return { snap, verdict, reads };
    }
    return { snap: last, verdict: "wait", reads };
  }

  /** Writes text into the pane: a bracketed paste where both sides allow it, else typed. Noted on the gate. */
  private async writeText(state: RunState, text: string, allowPaste: boolean): Promise<void> {
    this.guard(state);
    const { mux } = this.deps;
    const paste = allowPaste && state.match?.profile.paste?.bracketed === true && mux.pasteText !== undefined;
    const ack = await this.within(state, paste ? mux.pasteText!(state.target.paneId, text) : mux.typeText(state.target.paneId, text));
    this.deps.gate.noteWrite(state.target.paneId);
    if (!ack.ok) throw new Ended("refused", "write_failed", { detail: ack.detail });
  }

  /** Keys through the gate on the newest revision. `outcome` is what a refusal turns into. */
  private async keysThroughGate(state: RunState, keys: readonly string[], outcome: "typed_not_submitted" | "refused" | "unknown"): Promise<void> {
    this.guard(state);
    const { gate } = this.deps;
    const token = gate.mint(state.target.paneId, keys, gate.revision(state.target.paneId));
    const result = await this.within(state, gate.commit(token));
    if (result.ok) {
      state.keys.push(...keys);
      return;
    }
    const reason: SendReason = result.reason === "mux" ? (outcome === "refused" ? "write_failed" : "submit_failed") : result.reason;
    throw new Ended(outcome === "refused" ? "refused" : outcome, outcome === "unknown" ? "no_evidence" : reason, {
      detail: result.reason === "mux" ? result.refusal.detail : result.detail,
    });
  }

  /**
   * The probe: the character, then Backspace; the box must take exactly it and give it back. A manual
   * send lets the rows under the box and the rest of the box change (see the header).
   */
  private async probe(state: RunState, s0: Snap, prefix: string): Promise<Landing | null> {
    const probe = state.match?.profile.probe.char ?? GENERIC_PROBE;
    const failed = (detail: string, snap: Snap | null): Ended => new Ended("refused", "probe_failed", sawNote(snap, { detail, framed: s0.frame !== null }));
    // Reads are shared across the two halves: the character may take two, Backspace gets the rest.
    const budget = { reads: BOUNDS.probe.reads, ms: BOUNDS.probe.ms };
    const started = this.now();

    await this.writeText(state, probe, false);
    state.keys.push("probe");
    let landing: Landing | null = null;
    let frameless = 0;
    const typed = await this.poll(state, "probe", { reads: budget.reads - 1, ms: budget.ms }, (snap) => {
      if (s0.frame !== null) {
        // Queued: the Surface's claim of a modal over a found box fails, and so do two reads in a row
        // with no box. One read with no box may be torn, and its Surface claims nothing to trust.
        frameless = snap.frame === null ? frameless + 1 : 0;
        const inTurn = state.queued || state.streamed;
        if (inTurn && (frameless >= FRAMELESS_READS || modalAtBox(snap))) return "fail";
        if (snap.frame === null) return "wait";
        if (boxText(snap.frame) === boxText(s0.frame)) return "wait";
        const outside = inTurn
          ? turnOutsideUnchanged(s0, snap)
          : state.manual
            ? manualOutsideUnchanged(s0, snap)
            : outsideUnchanged(s0, snap) || this.aboveMovedInTurn(state, s0, snap);
        return wsFree(boxText(snap.frame)) === wsFree(prefix) + probe && outside ? "pass" : "fail";
      }
      if (snap.plain.join("\n") === s0.plain.join("\n")) return "wait";
      landing = probeLanding(s0.plain, snap.plain, probe, { freeBelow: state.manual });
      return landing !== null && !cueAppeared(s0, snap) ? "pass" : "fail";
    });
    if (typed.verdict !== "pass") {
      throw await this.probeCleanup(state, s0, typed.snap, probe, typed.verdict === "wait" ? "The probe character did not show in the box." : "The probe character changed more than the box.");
    }

    try {
      await this.keysThroughGate(state, ["Backspace"], "refused");
    } catch (err) {
      // The probe character is in the box and its Backspace was refused: no other key follows.
      if (err instanceof Ended && err.outcome === "refused") throw failed(`Backspace after the probe was refused: ${err.extra.detail ?? err.message}`, typed.snap);
      throw err;
    }
    const readsLeft = Math.max(1, budget.reads - typed.reads);
    const back = await this.poll(state, "probe", { reads: readsLeft, ms: Math.max(FIRST_GAP_MS, budget.ms - (this.now() - started)) }, (snap) => {
      if (s0.frame !== null) {
        if (snap.frame === null) return "wait";
        return boxText(snap.frame) === boxText(s0.frame) ? "pass" : "wait";
      }
      return snap.plain.join("\n") === s0.plain.join("\n") ? "pass" : "wait";
    });
    if (back.verdict !== "pass") throw failed("Backspace did not give the box back as it was.", back.snap);
    return landing;
  }

  /**
   * After a failed probe: when the read shows the probe character exactly once and it stands in the
   * box (the frame's interior, or with no frame a row that reads as at S0 once the character is cut),
   * one Backspace goes through the gate and one more read says whether the box is clean again. Any
   * other screen gets no key at all. The reason stays `probe_failed` either way; the detail says
   * what is true now.
   */
  private async probeCleanup(state: RunState, s0: Snap, snap: Snap | null, probe: string, why: string): Promise<Ended> {
    const failed = (detail: string, look: Snap | null): Ended =>
      new Ended("refused", "probe_failed", sawNote(look, { detail: `${why} ${detail}`, framed: s0.frame !== null }));
    if (snap === null || !probeInBox(s0, snap, probe)) return failed(probeMayRemain(probe), snap);
    try {
      await this.keysThroughGate(state, ["Backspace"], "refused");
    } catch (err) {
      if (err instanceof Ended && err.outcome === "refused") return failed(probeMayRemain(probe), snap);
      throw err;
    }
    await this.sleep(FIRST_GAP_MS);
    let look: Snap | null = null;
    try {
      look = await this.read(state, "probe");
    } catch (err) {
      if (!(err instanceof StepLate)) throw err;
    }
    if (look !== null && countIn(look.texts, probe) === countIn(s0.texts, probe)) return failed(PROBE_REMOVED, look);
    return failed(probeMayRemain(probe), look ?? snap);
  }

  /** The write: each line in one write, the profile's newline key between lines. */
  private async write(state: RunState, lines: readonly string[]): Promise<void> {
    const newline = state.match?.profile.keys.newline ?? null;
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) {
        if (newline === null) throw new Ended("typed_not_submitted", "changed");
        await this.keysThroughGate(state, newline, "typed_not_submitted");
      }
      const line = lines[i]!;
      if (line.length === 0) continue;
      try {
        await this.writeText(state, line, true);
      } catch (err) {
        // Nothing of the text is in the box when the first write fails; after that, part of it is.
        if (err instanceof Ended && i > 0) throw new Ended("typed_not_submitted", "changed", err.extra);
        throw err;
      }
    }
  }

  /**
   * S1: the box holds exactly the text, and nothing else moved. A `command` lets the rows under the box
   * move and lets a cue show there (its own popup), and takes the box with the lead cut or read as a
   * mode marker (a shell line's `!` as `! `); the transcript above must still stand still. A manual
   * send lets the rows under the box and the rest of the box move, and the transcript above lose
   * text but not gain any; a cue that grows still fails it.
   */
  private async awaitTyped(state: RunState, s0: Snap, landing: Landing | null, prefix: string, lines: readonly string[]): Promise<Snap> {
    const collapse = collapseOf(state.match);
    const { command, manual } = state;
    let why: SendReason = "mismatch";
    const result = await this.poll(state, "s1", BOUNDS.s1, (snap) => {
      // In a turn: the cue read inside the frame and the Surface's claim only (framedCueGrew says why).
      // A frameless cue that grew while the rows above moved is the turn's own list (aboveMovedInTurn).
      const cueGrew = state.queued || state.streamed ? framedCueGrew(s0, snap) || modalAtBox(snap) : cueAppeared(s0, snap) && !this.aboveMovedInTurn(state, s0, snap);
      if (!command && cueGrew) {
        why = "modal_cue";
        return "fail";
      }
      if (s0.frame !== null) {
        if (snap.frame === null) return "wait";
        if (!(command ? commandBoxMatches : boxMatches)(boxText(snap.frame), prefix, lines, collapse)) {
          why = "mismatch";
          return "wait";
        }
        const inTurn = state.queued || state.streamed;
        const outside = inTurn
          ? turnOutsideUnchanged(s0, snap)
          : manual
            ? aboveLostOnly(s0, snap)
            : command
              ? aboveUnchanged(s0, snap)
              : outsideUnchanged(s0, snap) || this.aboveMovedInTurn(state, s0, snap);
        if (!outside) {
          why = "changed";
          return "wait";
        }
        return "pass";
      }
      if (landing === null) return "fail";
      if (command) {
        // No frame: the landing row with the text in it stands in the read; a popup may move the rest.
        if (flat(snap.plain).includes(flat([landing.probed.slice(0, landing.index) + lines.join("") + afterProbe(landing)]))) return "pass";
        why = "mismatch";
        return "wait";
      }
      if (manual) {
        if (typedOnLanding(s0.plain, snap.plain, landing, lines.join(""))) return "pass";
        why = "mismatch";
        return "wait";
      }
      const predicted = flat(predictedRows(s0.plain, landing, lines.join("")));
      const actual = flat(snap.plain);
      const typedTail = flat([lines.join(""), afterProbe(landing), ...s0.plain.slice(landing.row + 1)]);
      if (predicted.endsWith(actual) && actual.length >= typedTail.length) return "pass";
      why = "mismatch";
      return "wait";
    });
    if (result.verdict === "pass" && result.snap !== null) return result.snap;
    state.marks.s1 = result.snap;
    // The rows hash binds a later Submit or Discard to the screen this answer saw.
    const note: EndNote = { framed: s0.frame !== null };
    if (result.snap !== null) note.rowsHash = result.snap.rowsHash;
    throw new Ended("typed_not_submitted", why, sawNote(result.snap, note));
  }

  /** Commit: `submit-sent` on disk, then the submit keys through the gate on S1's revision. */
  private async commit(state: RunState, s1: Snap): Promise<void> {
    this.guard(state);
    const keys = state.match?.profile.keys.submit ?? GENERIC_SUBMIT;
    const { gate, store } = this.deps;
    const token = gate.mint(state.target.paneId, keys, s1.gateRevision);
    store.markSubmitSent(state.record.id);
    const result = await this.within(state, gate.commit(token));
    if (!result.ok) {
      const reason: SendReason = result.reason === "mux" ? "submit_failed" : result.reason;
      throw new Ended("typed_not_submitted", reason, { framed: s1.frame !== null, rowsHash: s1.rowsHash, detail: result.reason === "mux" ? result.refusal.detail : result.detail });
    }
    state.keys.push(...keys);
  }

  /**
   * S2: the box emptied or a running sign showed. Anything else after the bound is `unknown`. A
   * `command` also passes when the box went away or no longer holds the text: a command may open its
   * own screen (a picker, a panel) in the box's place.
   */
  private async awaitSent(state: RunState, s0: Snap, landing: Landing | null, lines: readonly string[]): Promise<void> {
    const { command, manual } = state;
    // The queued path: S0 read the turn running, or the rows above moved while Collie typed.
    const queued = state.queued || state.streamed;
    let dialog = false;
    let frameless = 0;
    // A send that S0 read as idle may still have gone into a turn (its first second reads idle): the
    // harness's own queued row with the text is the witness, and the receipt then says `queued`.
    const s1Frame = state.marks.s1?.frame ?? null;
    const sentText = s1Frame === null ? lines.join("") : boxText(s1Frame);
    let witnessed = false;
    const result = await this.poll(state, "s2", BOUNDS.s2, (snap) => {
      if (!state.queued && !command && !witnessed) witnessed = showsQueued(snap, state.match?.profile.keys.queuedRow, sentText);
      if (s0.frame !== null) {
        // Queued behind a running turn: a dialog that opened as the Enter went out may have taken it.
        // The Surface claiming a modal, or two reads in a row with no box, end the request on their
        // own. A grown cue does not: the queued row itself reads as one (framedCueGrew says why).
        frameless = snap.frame === null ? frameless + 1 : 0;
        if (queued && (frameless >= FRAMELESS_READS || modalAtBox(snap))) {
          dialog = true;
          return "fail";
        }
        if (snap.frame === null) return command ? "pass" : "wait";
        // Queued: the running sign showed before Enter, so only the box letting go of the text is
        // evidence that the harness took it.
        if (queued) return boxText(snap.frame).length === 0 ? "pass" : "wait";
        if (command && !wsFree(boxText(snap.frame)).includes(wsFree(withoutLead(lines).join("")))) return "pass";
        return boxText(snap.frame).length === 0 || runningSign(snap.rows, snap.frame) ? "pass" : "wait";
      }
      if (landing === null) return "wait";
      if (command) return flat(snap.plain).includes(flat([landing.probed.slice(0, landing.index) + lines.join("") + afterProbe(landing)])) ? "wait" : "pass";
      // No frame: the landing row, found at its S0 distance from the last non-blank row, reads as it
      // did at S0 again, and the typed text no longer stands there. The rows under it may change (a
      // status row counting tokens does, live on pi 0.87.1); a popup that moves the rows does not pass.
      const actual = flat(snap.plain);
      const typedTail = flat([lines.join(""), afterProbe(landing), ...s0.plain.slice(landing.row + 1)]);
      const row = lastFilled(snap.plain) - (lastFilled(s0.plain) - landing.row);
      const boxBack = row >= 0 && wsFree(snap.plain[row] ?? "") === wsFree(s0.plain[landing.row] ?? "");
      if (!actual.endsWith(typedTail) && boxBack) return "pass";
      // A manual send: the rows under the box may differ from S0's (a hint row that came back, a
      // running row), so the empty box is looked for by what it read at S0, not by its distance.
      return manual && emptyBoxBack(s0.plain, snap.plain, landing, lines.join("")) ? "pass" : "wait";
    });
    state.marks.s2 = result.snap;
    if (witnessed && result.verdict === "pass") state.queued = true;
    if (dialog) throw new Ended("unknown", "dialog_after_enter", sawNote(result.snap, { offers: ["keys"], detail: DIALOG_AFTER_ENTER }));
    if (result.verdict !== "pass") throw new Ended("unknown", "no_evidence", { detail: "The submit key went out, but the box did not show it was taken." });
  }

  /**
   * The late witness: a send that went in on a harness that queues, whose receipt would not say
   * `queued`, gets one more read {@link LATE_WITNESS_MS} after S2, outside S2's timing. The harness's
   * queued row with the text there makes the receipt say `queued`. Nothing else on that read counts:
   * a dialog, a read that fails or comes too late, or the request's bound changes no outcome; only the
   * label stays off. A command, a pane with no box at S2 and a receipt that says `queued` already skip it.
   */
  private async lateWitness(state: RunState, lines: readonly string[]): Promise<void> {
    const queuedRow = state.match?.profile.keys.queuedRow;
    if (queuedRow === undefined || !queuesInTurn(state.match) || state.queued || state.command) return;
    if ((state.marks.s2?.frame ?? null) === null) return;
    const s1Frame = state.marks.s1?.frame ?? null;
    const sentText = s1Frame === null ? lines.join("") : boxText(s1Frame);
    if (state.deadline - this.now() <= LATE_WITNESS_MS * 2) return;
    try {
      await this.sleep(LATE_WITNESS_MS);
      const snap = await this.readNow(state, "witness");
      if (snap !== null && showsQueued(snap, queuedRow, sentText)) state.queued = true;
    } catch {
      // A late read that fails is only a missing witness: the send already went in.
    }
  }

  /**
   * S2 of a Submit on a pane with no frame: the box found at S0 reads empty again (its head alone) and
   * nothing from there down holds the text. With no box found there is no evidence: `unknown`.
   */
  private async awaitBareEmpty(state: RunState, located: Located | null): Promise<void> {
    const result = located === null ? null : await this.poll(state, "s2", BOUNDS.s2, (snap) => (emptiedTo(located.head, snap.plain, located.text) ? "pass" : "wait"));
    state.marks.s2 = result?.snap ?? null;
    if (result?.verdict !== "pass") throw new Ended("unknown", "no_evidence", { detail: "The submit key went out, but the box did not show it was taken." });
  }

  /**
   * Discard on a pane with no frame: the clear key as many times as the text has characters plus the
   * profile's slack, in one batch through the gate, then reads until the box found at S0 reads empty.
   */
  private async clearBare(state: RunState, located: Located): Promise<void> {
    const clearKey = state.match?.profile.keys.clear ?? GENERIC_CLEAR;
    const count = Math.min(CLEAR_BATCH, [...located.text].length + clearKey.slack);
    await this.keysThroughGate(state, Array.from({ length: count }, () => clearKey.key), "unknown");
    const result = await this.poll(state, "clear", CLEAR_BOUND, (snap) => (emptiedTo(located.head, snap.plain, located.text) ? "pass" : "wait"));
    if (result.verdict !== "pass") throw new Ended("unknown", "no_evidence", { detail: "The box did not empty inside the bound." });
  }

  /** Empties a framed box with the profile's clear key, in batches with a read between. Never Escape. */
  private async clear(state: RunState, from: Snap): Promise<Snap> {
    const clearKey = state.match?.profile.keys.clear ?? GENERIC_CLEAR;
    const until = Math.min(this.now() + CLEAR_BOUND.ms, state.deadline);
    const late = (): Ended => new Ended("unknown", "no_evidence", { detail: "The box did not empty inside the bound." });
    let snap = from;
    for (let round = 0; round < CLEAR_BOUND.reads; round++) {
      if (this.now() > until) throw late();
      if (snap.frame === null || snap.cueStrength !== "none") throw new Ended("unknown", "no_evidence", { detail: "The box went away while it was being emptied." });
      const left = [...boxText(snap.frame)].length;
      if (left === 0) return snap;
      const count = Math.min(CLEAR_BATCH, left + clearKey.slack);
      await this.keysThroughGate(state, Array.from({ length: count }, () => clearKey.key), "unknown");
      await this.sleep(FIRST_GAP_MS);
      let next: Snap | null;
      try {
        next = await this.read(state, "clear", until);
      } catch (err) {
        if (err instanceof StepLate) throw late();
        throw err;
      }
      if (next === null) throw new Ended("unknown", "no_evidence", { detail: "The pane could not be read while it was being emptied." });
      snap = next;
    }
    if (snap.frame !== null && boxText(snap.frame).length === 0) return snap;
    throw new Ended("unknown", "no_evidence", { detail: "The box did not empty inside the bound." });
  }
}

/**
 * What a `prepare` offers, by the shared rules: nothing on a free screen (the next tap is a plain
 * send), the commit tap where the manual Send is open, the draft's three offers on a framed draft, and
 * the key pad everywhere else.
 */
function prepareOffers(snap: Snap): SendOffer[] {
  const { surface } = snap;
  if (isFree(surface)) return [];
  if (takesManualSend(surface)) return ["commit", "keys"];
  if (surface.turn === "idle" && surface.modal === "none" && surface.composer === "draft") return offersFor("refused", "draft_present", snap.frame !== null);
  return ["keys"];
}

function collapseOf(match: ProfileMatch | null): RegExp | null {
  return match === null ? null : new RegExp(match.profile.collapse.pattern, "uy");
}

function prepareRecord(target: SendTarget, at: number): SendRecord {
  return {
    id: "prepare",
    session: target.session,
    paneId: target.paneId,
    paneGeneration: "-",
    surfaceRevision: 0,
    mode: "prepare",
    textHash: "-",
    textLength: 0,
    acceptedAt: at,
    phase: "accepted",
  };
}
