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
//           form) and nothing else moved; else `typed_not_submitted`. A turn that started after an
//           idle S0 meets S0's turn rule on that read; a send it refuses or holds ends the same way
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
// A harness whose Enter steers the running turn (`keys.enterWhileRunning: "steers"`) takes the same
// queued path only when its profile names a queue key (`keys.queueKey`). The commit then presses that
// key instead of the submit keys. Enter never goes into such a turn: any send on the queued path
// (S0 read a turn, or the rows above moved) presses the queue key, never Enter (commitKeys). Without a
// queue key the send is refused `turn_running`. Such a profile may name the queue key as its submit
// key too (Codex: Tab sends on an idle box and queues in a turn), and a command then takes
// `keys.commandSubmit`. On such a harness the receipt says `queued` only when S2 or the late read
// sees the harness's queued row with the text (`keys.queuedRow`); otherwise it says sent.
//
// A turn the screen does not mark: Claude Code 2.1.301 draws no spinner while the answer streams, so
// S0 reads idle. On a harness that queues, a send that is not a command may see the rows above the
// box move while Collie types, if the frame stays, the rows under the box keep their count, the cue
// inside the frame stays and the Surface claims no modal (aboveMovedInTurn). The rows above may only
// scroll and grow: each read shares two rows in order with the read before it (aboveScrolled), so a
// screen that replaced the conversation fails. From there it takes the queued path; the receipt says
// `queued` only on S0's running read or a witness (in S2, or one late read where a turn may run). A
// harness whose queue key is its submit key takes this path too: its submit key is right either way. An
// S2 that ends with the text still in the box ends `unknown(dialog_after_enter)`: a dialog that drew
// before Enter took it and closed.
//
// A pane whose harness has a profile is read through its input frame. A pane with no profile (a bare
// shell, a program, an agent Collie has no profile for) has no input box to prove free, so a send or
// a command on it is typed and Entered blind, as before the protocol: no probe, no S1, no S2, never
// held. Its one S0 read only looks for a password prompt on the last rows, which refuses the send
// before any key (#103). Its receipt says `sent` once Enter went out, and its `saw` says `no-profile`. A pane that
// has a profile but whose frame S0 cannot find reads unknown(no-match): every send on it is probed,
// and the probe's own landing spot (the row and column where the probe character appeared) is what S1
// and S2 compare against.
//
// A manual send (the screen takes the two-tap Send: no frame found, an unreadable overlay, a weak cue)
// compares less than a free one: the rows under the box (hints, footers, status rows) and the rest
// of the box may change while the probe and the text go in, as a `command` lets them. The rows
// above the box may lose text (go blank, or move because rows vanished) but never gain any, and a
// modal cue that shows still fails.
//
// A command in a running turn (M56 spec 15): a profile whose harness queues a command entered during
// a turn (`keys.commandWhileRunning: "queues"`, measured in the lab) sends it on the queued path like a
// message. Its popup may fill the rows under the box, so S1 asks only that the rows above scrolled.
//
// A command the harness runs at once in a turn (`keys.commandsRunInTurn`, measured in the lab: OMP's
// `/goal`) is neither queued nor held. It goes on the same probed path into the turn, but the commit
// presses the command keys, because the harness takes the command before the turn sees any text. The
// receipt says `sent`, never `queued`. It needs the trust a queued send needs (turnTrusted); on an
// unread version or a revoked range the command is held as before. It does not wait behind the pane's
// held sends either: it acts on the session now, so a chain of turns cannot keep it out.
//
// The held send (M56 spec 15): a send that would be refused `turn_running` (a harness that does not
// take it during a turn) is held instead when the protocol has a hold queue (holds.ts). The receipt says
// `held`; the poll releases the oldest held request of a pane the first time its Surface reads free, as
// a fresh run of these steps under the same request id. A later send or command on that pane joins the
// end of the queue. A hold lasts 30 minutes, then ends `expired` with its text kept for a Resend; the
// person may cancel it while it waits.
//
// Rows live only in the short memory ring below; the receipt and the request file hold hashes.
// No harness name lives here (no-harness-names.test.ts scans this folder).

import type { MuxAck, MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { noEchoPromptIn } from "../../web/src/lib/no-echo.ts";
import { pointsAt } from "../../web/src/lib/surface/command-list.ts";
import { commandListAt, isRunningRow, noticeOver, ownCommandList, readCues, readCuesFor, runningSign, withoutCommandList, type CommandListRead, type Cue } from "../../web/src/lib/surface/cues.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { findInputFrame, rowText, type Frame, type FrameRow } from "../../web/src/lib/surface/frame.ts";
import { liftAsk, liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { AboveNotice } from "../../web/src/lib/surface/notice.ts";
import type { CommandListRows, OtherScreenRow, ProfileMatch, QueuedRow } from "../../web/src/lib/surface/profile.ts";
import {
  offersFor,
  RECEIPT_DETAIL_MAX,
  reservedLead,
  sendLines,
  surfaceWords,
  takesManualSend,
  wsFree,
  type ReadMark,
  type SendAnswer,
  type SendCap,
  type SendCause,
  type SendMode,
  type SendOffer,
  type SendOutcome,
  type SendReason,
  type SendReceipt,
  type SendReceiptRow,
  type SendStep,
  type SurfaceWords,
  type HeldCancelAnswer,
  type HeldRow,
} from "../../web/src/lib/surface/send.ts";
import { isFree, shortHash, type Surface } from "../../web/src/lib/surface/surface.ts";
import { closingReceipt, normalizePrompt, receiptWindowMs, type OpenReceipt } from "../../web/src/lib/surface/edges.ts";
import type { CapState, CounterKey, ExampleEntry, InboxEntry } from "./counters.ts";
import { askLifetimeOf, type AskBook } from "./ask.ts";
import type { KeyGate } from "./key-gate.ts";
import type { RequestStore, SendRecord } from "./requests.ts";
import { HOLD_BRIDGE_MAX, HOLD_PANE_MAX, heldRow, type HeldEntry, type HoldStore } from "./holds.ts";

/** The step bounds, written as (max reads, max ms). */
export const BOUNDS = {
  s0: { reads: 2, ms: 1200 },
  probe: { reads: 3, ms: 900 },
  s1: { reads: 6, ms: 2500 },
  s2: { reads: 6, ms: 3000 },
  /** A notice's digit, written with no submit key: the notice gone and the box empty (it takes S1's and S2's place). */
  notice: { reads: 6, ms: 2000 },
} as const;

/** The session lock's bound: the sum of the step bounds a send can take (the notice wait stands in for S1 and S2). A request past it ends `unknown`. */
export const LOCK_BOUND_MS = BOUNDS.s0.ms + BOUNDS.probe.ms + BOUNDS.s1.ms + BOUNDS.s2.ms;

/** The probe character on a pane with no profile: the slice 0 lab found it inert in every hotkey dialog. */
export const GENERIC_PROBE = "⌁";
/** The submit key on a pane with no profile. */
const GENERIC_SUBMIT = ["Enter"] as const;
/** The clear key on a pane with no profile. Never Escape. */
const GENERIC_CLEAR = { key: "Backspace", slack: 16 } as const;
/** The reserved leads on a pane with no profile: a slash command, a shell line, a file mention. */
const GENERIC_LEADS = ["/", "!", "@"] as const;
/** The pause between the text and Enter on a pane with no profile: the 350 ms the reply route waited before the protocol. */
export const BLIND_SETTLE_MS = 350;
/** What a blind send's receipt says it saw: nothing was read, because the pane has no profile to read it by. */
const BLIND_SAW: SurfaceWords = { turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-profile" };
/** The refusal of a blind send at a password prompt. Never the prompt's row: it may name a user or a key file. */
const NO_ECHO_REFUSAL = "A password prompt is waiting on the last row. Collie does not type into it from the text box. Use Type to answer it.";

/** The detail after a failed probe whose one Backspace took the character out again. */
const PROBE_REMOVED = "One Backspace removed the probe character, so the box is clean again.";
/** The detail after a failed probe that left its character where Collie cannot take it out. */
function probeMayRemain(probe: string): string {
  return `A probe character (${probe}) may remain in the box. Check the pane before you type.`;
}

/**
 * The receipt's detail of a refusal `write_failed`. The multiplexer's own words (tmux or zellij
 * stderr) stay in the bridge log: a receipt lives seven days and its list is returned to the phone.
 */
const WRITE_FAILED = "Collie could not type into the pane.";

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
  /** `released` marks the run of a held request (M56 spec 15): its `sent` or `effective` also counts as `held_sent`. */
  send(key: CounterKey, end: { readonly outcome: string; readonly reason?: string | undefined; readonly probed: boolean; readonly released?: boolean }): void;
  noteManual(key: CounterKey): void;
  capState(harness: string, version: string): CapState;
  inbox(entry: InboxEntry): void;
  example(entry: ExampleEntry): void;
  /** A settled send a prompt edge confirmed (M56 spec 11). Optional, so an older ledger still fits. */
  confirmEffective?(key: CounterKey, from: "sent" | "unknown"): void;
}

/** A receipt a prompt edge may still close (M56 spec 11): open from the submit key until the window ends. */
interface OpenSend extends OpenReceipt {
  /** Set at the submit key, or at settle when a witness after Enter saw the send queue (S2, late). */
  queued?: boolean;
  readonly key: CounterKey;
  /** Settled already, as `sent` or `unknown`: a match writes the record again. */
  settled: boolean;
  /** Matched while the request still ran: its `sent` settles as `effective`. */
  effective: boolean;
}

/** The most open receipts one protocol keeps. The oldest go first. */
const OPEN_SENDS_MAX = 64;

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
  /**
   * The hold queue (M56 spec 15), shared by the bridge's sessions. With it, a send the harness cannot
   * take during its turn is held and sent once the pane reads free; without it, that send is refused
   * `turn_running`.
   */
  readonly holds?: HoldStore;
  /**
   * A blind send went out (M61, ADR 0107): on a pane with no profile, the text was typed and Enter
   * went through the gate, and the receipt says `sent`. Called once, after the receipt is settled and
   * inside a try, never for a refusal, a replay or a send that did not submit. What the caller keeps
   * of it is the caller's business: the bridge keeps the line only for a shell pane (bridge/sent.ts).
   */
  readonly blindSent?: (sent: { readonly session: string; readonly paneId: string; readonly text: string }) => void;
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
  /** The cues of the framed read behind {@link cueStrength}, for a refusal's example. */
  readonly cues: readonly Cue[];
  /** The generic cues of the bottom cluster read as if no frame were found: a popup under the box
   *  that walks like a status row escapes the framed read, never this one. Compared with S0's. */
  readonly bareCues: "none" | "weak" | "strong";
  /** The generic cues of the rows under the frame's bottom edge, read as if no frame were found: a
   *  pointer list that takes the place of status rows there. "none" with no frame. */
  readonly belowCues: "none" | "weak" | "strong";
  /** The framed cue read found cues, and every one stands under the frame's bottom edge. */
  readonly cuesUnderBox: boolean;
  /** The notice the profile names over the frame ({@link noticeOver}), left out of every cue read; null with none. */
  readonly notice: AboveNotice | null;
  /** The rows under the frame that count, the profile's hint rows left out ({@link countBelow}); 0 with no frame. */
  readonly below: number;
  /** The name of the other screen whose own row stands under the frame ({@link otherScreenOf}); null with no frame. */
  readonly otherScreen: string | null;
  /** The profile's command list at the frame and the command its pointer rests on ({@link commandListAt}); null with none. */
  readonly commandList: CommandListRead | null;
  /** That list when it is the typeahead of the command the box holds ({@link ownCommandList}); null otherwise. */
  readonly ownList: CommandListRead | null;
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

/** The rows with each row the profile names as a footer row (`frame.volatile.named`) read as blank. */
function withoutNamedRows(rows: readonly FrameRow[], frame: Frame | null): readonly FrameRow[] {
  if (frame === null || frame.volatile.named.length === 0) return rows;
  const named = new Set(frame.volatile.named.map((hit) => hit.row));
  return rows.map((row, i) => (named.has(i) ? { segments: [] } : row));
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
 * are not a moved screen, a probe that changed two rows, or a row that gained text. A row that the
 * profile names as a running row (`signs`) shows its braille spinner glyph and its digits as fixed marks. Every other
 * character of the row still counts: a row such as "2. No, tell Claude... (3m)" that changes its
 * words, or stops being a running row, still changes every compare.
 */
export function steadyRow(row: string, signs: readonly RegExp[] = []): string {
  // A row the profile names as a running row (idle.runningRows) shows its spinner glyph as a fixed mark.
  if (signs.some((sign) => sign.test(row.trimEnd()))) return row.replace(/[\u2800-\u28ff]/gu, "*").replace(/\d+/gu, "0");
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
 * The cue check of a send into a running turn: the cue read with the frame found, and the frameless
 * cue read of the rows UNDER the frame, may not grow. The frameless read of the rows above is left
 * out, because a turn draws what it reads as a cue there: Claude Code's queued row (a pointer row
 * with the text, over a "ctrl+enter to send now" hint) and a numbered list streamed above the box.
 * Nothing of a turn draws under the box, so a pointer list that takes the place of status rows there
 * still counts. A real dialog over the box takes the box away or makes the Surface claim a modal.
 */
function framedCueGrew(before: Snap, after: Snap): boolean {
  return CUE_RANK[after.cueStrength] > CUE_RANK[before.cueStrength] || CUE_RANK[after.belowCues] > CUE_RANK[before.belowCues];
}

/**
 * The cue check of a `command`, in a turn or not. Its popup fills the rows under the box and reads as a
 * pointer list there (the generic cues of the rows under the frame and of the bare cluster), while the
 * Surface claims no modal and the cue read with the frame stays put (lab fixtures
 * claude--autocomplete-slash-short, claude-lab--working-popup-open--w82). So only those rows are
 * excused: the Surface's claim of a modal over a found box, and a cue that grew inside the frame, still
 * fail. A dialog drawn under the box makes the Surface claim it.
 */
function commandCueGrew(before: Snap, after: Snap): boolean {
  if (commandPopup(after)) return false;
  return modalAtBox(after) || CUE_RANK[after.cueStrength] > CUE_RANK[before.cueStrength];
}

/**
 * Whether a read shows a screen drawn where the box stands, on a harness that draws its dialogs there
 * (`idle.dialogsInBox`): the frame walk still finds two rules, but a strong cue reads between them, so
 * the Surface reads no box. pi 0.87.1 and 1.3.0 open the `/model` selector so (lab, 2026-10-17), and the
 * selector's own rows hold the word `model`, so the box's text alone cannot tell that the command went.
 */
function screenInBox(snap: Snap, state: RunState): boolean {
  return snap.frame !== null && state.match?.profile.idle.dialogsInBox === true && snap.cueStrength === "strong";
}

/**
 * The command's own popup as the framed read sees it: a weak cue, all of it under the box, and a Surface
 * that claims only `unknown`, never an ask or an unreadable dialog. Claude Code's full slash list, open
 * while the box holds `/`, reads so (claude-lab--popup-slash-all--w82, review of spec 15, L1).
 */
function commandPopup(snap: Snap): boolean {
  return snap.frame !== null && snap.surface.modal === "unknown" && snap.cueStrength === "weak" && snap.cuesUnderBox;
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

/**
 * The S1 rule of a message into a framed box (2026-10-17 decision, after two live sends near the end of
 * a turn were left typed): once the text is typed, only the box and what is under it decide. Enter may
 * go out when the frame is still there, its interior holds exactly the typed text, the rows under it
 * keep their count and read no stronger cue than at S0, and the Surface claims no dialog. The rows
 * above the box may move or finish freely, in a running turn or an idle one: the answer streaming,
 * ending, or printing a list, a menu or a "(y/n)" line there is the agent's text, not a dialog.
 *
 * The screen-replaced guard is "the frame with our text is gone": no frame, a frame whose interior
 * does not hold the text, or a frame with another count of rows under it. A read like that waits; when
 * no read passes, the send ends `typed_not_submitted` with the text in the box. A dialog that appeared
 * ends it at once (`modal_cue`).
 *
 * The rows above no longer tell a replaced screen apart, so the box's own identity does: a box with a
 * row under it that the profile names as another screen's (`idle.volatile.below.otherScreens`) is not
 * the conversation's box, and the send ends at once (`other_screen`, reported as `changed`). Claude
 * Code's agents screen draws a box of its own with a one-row key-hint footer, the same count as a
 * conversation with the statusline off, and Enter there starts a new background session with the text.
 */
function typedBoxVerdict(s0: Snap, snap: Snap, prefix: string, lines: readonly string[], collapse: RegExp | null): "pass" | "wait" | "modal_cue" | "mismatch" | "changed" | "other_screen" {
  if (modalAtBox(snap) || framedCueGrew(s0, snap)) return "modal_cue";
  if (s0.frame === null || snap.frame === null) return "changed";
  if (snap.otherScreen !== null) return "other_screen";
  if (!boxMatches(boxText(snap.frame), prefix, lines, collapse)) return "mismatch";
  if (rowsBelow(s0, s0.frame) !== rowsBelow(snap, snap.frame)) return "changed";
  return "pass";
}

/**
 * The probe's half of the box-only rule ({@link typedBoxVerdict}): the frame is there, its interior
 * holds exactly what it held plus the probe character, the rows under it keep their count and read no
 * stronger cue than at S0, the box is not another screen's ({@link otherScreenOf}), and the Surface
 * claims no dialog. The rows above may move: an answer that streams there, a row still growing above
 * queued messages, or the turn ending, is not the box.
 */
function probeBoxPasses(s0: Snap, snap: Snap, prefix: string, probe: string): boolean {
  if (s0.frame === null || snap.frame === null) return false;
  if (snap.otherScreen !== null) return false;
  if (modalAtBox(snap) || framedCueGrew(s0, snap)) return false;
  if (rowsBelow(s0, s0.frame) !== rowsBelow(snap, snap.frame)) return false;
  return wsFree(boxText(snap.frame)) === wsFree(prefix) + probe;
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
  void frame;
  return snap.below;
}

/**
 * The non-blank rows under a frame's bottom edge, the profile's hint rows left out
 * (`idle.volatile.below.hints`): a harness may hide or swap a hint there once the box holds text
 * (Codex 0.163.0 drops "← for agents · ? for shortcuts" at the first character), which is not a
 * moved screen.
 */
function countBelow(texts: readonly string[], frame: Frame | null, hints: readonly RegExp[]): number {
  if (frame === null) return 0;
  let n = 0;
  for (let i = frame.bottom + 1; i < texts.length; i++) {
    const text = texts[i]!.trimEnd();
    if (text.trim().length > 0 && !hints.some((hint) => hint.test(text))) n++;
  }
  return n;
}

/**
 * The name of the other screen that owns the box, when a row under the frame matches one of the
 * profile's `idle.volatile.below.otherScreens`: Claude Code's agents screen draws a box of its own
 * ("describe a task for a new session") with its key-hint row under it, and Enter there starts a new
 * background session with the text. Null with no frame or no such row.
 */
function otherScreenOf(texts: readonly string[], frame: Frame | null, screens: readonly OtherScreenRow[]): string | null {
  if (frame === null || screens.length === 0) return null;
  const compiled = screens.map((screen) => ({ name: screen.name, pattern: new RegExp(screen.pattern, "u") }));
  for (let i = frame.bottom + 1; i < texts.length; i++) {
    const text = texts[i]!.trimEnd();
    const hit = compiled.find((screen) => screen.pattern.test(text));
    if (hit !== undefined) return hit.name;
  }
  return null;
}

/**
 * The rows above a frame, the volatile band over the top edge left out, trailing blanks cut. The typed
 * command's own list over the box ({@link ownCommandList}) is no transcript either: a tall pane draws
 * it there once the command is typed, and it may reach past the band.
 */
function transcriptAbove(snap: Snap, frame: Frame): string[] {
  const band = frame.volatile.above === null ? frame.top : frame.volatile.above.first;
  const end = snap.ownList?.side === "above" ? Math.min(band, snap.ownList.first) : band;
  const rows = snap.texts.slice(0, end).map((t) => t.trimEnd());
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  return rows;
}

/**
 * Whether everything outside the box stayed put between two reads of a framed pane: the transcript
 * above (it may scroll up by as many rows as the box grew, plus one), the same count of rows under
 * the box (a popup adds rows there), and no modal cue. The volatile band over the box may change.
 */
function outsideUnchanged(before: Snap, after: Snap, losesText = false): boolean {
  if (before.frame === null || after.frame === null) return false;
  if (cueAppeared(before, after)) return false;
  if (rowsBelow(before, before.frame) !== rowsBelow(after, after.frame)) return false;
  if (aboveUnchanged(before, after)) return true;
  return losesText && lostTextOnly(transcriptAbove(before, before.frame), transcriptAbove(after, after.frame), SCROLLBACK_SLACK);
}

/**
 * Whether the profile says the rows above its box may lose text once the box holds a character
 * (`idle.volatile.above.losesText`): Codex 0.163.0 hides its welcome picture and its tip row then,
 * and the screen moves down, so up to three rows at the very top may come back from the scrollback.
 * Rows that only lose text still never gain any lower down, so a dialog or a line of output near the
 * box still fails.
 */
function aboveLosesText(state: RunState): boolean {
  return state.match?.profile.idle.volatile.above.losesText === true;
}

/**
 * Whether the rows of `after` only lost text against `before`: each non-blank row of `after` stands,
 * in the same order, among the non-blank rows of `before`. A row that went blank, rows that vanished
 * and moved the rest, rows scrolled off the top all pass; a row with new text (a dialog, a line of
 * output, a timer that ticked) fails. A manual send allows this above the box.
 */
function lostTextOnly(before: readonly string[], after: readonly string[], topSlack = 0): boolean {
  const kept = before.map((row) => row.trimEnd()).filter((row) => row.length > 0);
  let k = 0;
  let seen = 0;
  for (const row of after) {
    const text = row.trimEnd();
    if (text.length === 0) continue;
    seen++;
    let at = k;
    while (at < kept.length && kept[at] !== text) at++;
    if (at === kept.length) {
      // `topSlack`: the first rows of `after` may come back from the scrollback when a row lower down
      // hid and the screen moved down. Only at the very top, never in the rows near the box.
      if (seen <= topSlack) continue;
      return false;
    }
    k = at + 1;
  }
  return true;
}

/** How many rows at the top of the screen may come back from the scrollback on a profile whose rows above lose text. */
const SCROLLBACK_SLACK = 3;

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

/** The non-blank rows above a frame's top edge, as the compares see them (a spinner row steadied). */
function bandAbove(snap: Snap, frame: Frame): string[] {
  return snap.plain.slice(0, frame.top).filter((row) => row.trim().length > 0);
}

/**
 * Whether the rows above the box only scrolled and grew from one read to the next: the first two
 * non-blank rows of `after` stand, in order and next to each other, among the rows of `before`, the
 * last row of `before` left out (it grows while an answer streams). A screen that replaced the
 * conversation (Claude Code's background agents screen, which has a prompt-shaped box of its own)
 * shares no such pair and fails.
 */
/** Whether `first` and `second` stand next to each other, in that order, among `rows`. */
function pairIn(rows: readonly string[], first: string, second: string): boolean {
  for (let k = 0; k + 1 < rows.length; k++) if (rows[k] === first && rows[k + 1] === second) return true;
  return false;
}

function aboveScrolled(before: Snap, after: Snap): boolean {
  if (before.frame === null || after.frame === null) return false;
  const was = bandAbove(before, before.frame).slice(0, -1);
  const now = bandAbove(after, after.frame);
  if (now.length < 2) return false;
  // One pinned row: the screen's first row may stay where it is while the rows under it scroll, and
  // then those rows carry the check (Codex 0.163.0 keeps the turn's prompt row at the top while its
  // answer streams under it; lab, 2026-10-16). The rest of the rule holds for them.
  const pinned = now.length >= 3 && was.length > 1 && now[0] === was[0] && pairIn(was.slice(1), now[1]!, now[2]!);
  return (pairIn(was, now[0]!, now[1]!) || pinned) && bottomHeld(before, now);
}

/**
 * The bottom anchor of {@link aboveScrolled}. Scrolling takes rows away at the top, never at the
 * bottom, so the last rows of `before` stay in `after`, in order, even where a replaced screen kept
 * the same header on top. The anchor is the last two settled rows of `before` (above the volatile
 * band over the box, where a spinner, a tip and a queued row come and go). A short screen with fewer
 * settled rows is anchored by its band's last two rows: the second to last as it was, the last one
 * as it was, grown, or cut at a wrapped word (one row is a prefix of the other). Rows may stand
 * between the two in `after`: a turn prints above its spinner.
 */
function bottomHeld(before: Snap, now: readonly string[]): boolean {
  if (before.frame === null) return false;
  const end = before.frame.volatile.above === null ? before.frame.top : before.frame.volatile.above.first;
  const settled = before.plain.slice(0, end).filter((row) => row.trim().length > 0);
  const band = bandAbove(before, before.frame);
  const pair = settled.length >= 2 ? settled.slice(-2) : band.slice(-2);
  const first = pair[0];
  const last = pair[1];
  if (first === undefined || last === undefined) return false;
  // The last row grew, or lost a word to the next row; a row cut to less than half is another row.
  const holdsLast = (row: string): boolean => (settled.length >= 2 ? row === last : row.startsWith(last) || (row.length * 2 >= last.length && last.startsWith(row)));
  return now.some((row, i) => row === first && now.slice(i + 1).some(holdsLast));
}

/** A row above the box that shows a spinner by its words, with or without its timer. */
function spinnerAbove(snap: Snap | null): boolean {
  if (snap === null || snap.frame === null) return false;
  return snap.texts.slice(0, snap.frame.top).some((row) => SPINNER_VERB_ROW.test(row) || isRunningRow(row));
}

/** The rows under the box as read, nothing masked: a ticking subagent timer there changes them. */
function belowRows(snap: Snap): string | null {
  return snap.frame === null ? null : snap.plain.slice(snap.frame.bottom + 1).join("\n");
}

/** Whether a row under the box shows a running sign or a spinner by its words. */
function runningBelow(snap: Snap | null): boolean {
  if (snap === null || snap.frame === null) return false;
  return snap.texts.slice(snap.frame.bottom + 1).some((row) => SPINNER_VERB_ROW.test(row) || isRunningRow(row));
}

/**
 * Whether the rows under the box changed between two reads whose box holds the same text. Only such
 * a pair says something moved there on its own: Claude Code's footer follows the box (a hint for an
 * empty box, "ctrl+g to edit in nano" once it holds text), so S0 against S1 always differs.
 */
function belowMovedAlone(before: Snap | null, after: Snap): boolean {
  if (before === null || before.frame === null || after.frame === null) return false;
  if (boxText(before.frame) !== boxText(after.frame)) return false;
  return belowRows(before) !== belowRows(after);
}

/** Whether the profile may be trusted with a running turn: a version the binary reported, on a range that is not revoked. */
function turnTrusted(match: ProfileMatch | null): match is ProfileMatch {
  return match !== null && match.version !== null && match.status !== "revoked" && match.range?.status !== "revoked";
}

/**
 * Whether the harness's Enter itself queues while a turn runs (`keys.enterWhileRunning: "queues"`).
 * Only then may a send that S0 read as idle take the queued path when the rows above move, and only
 * then is the harness's queued row a witness after an Enter.
 */
function enterQueues(match: ProfileMatch | null): boolean {
  return turnTrusted(match) && match.profile.keys.enterWhileRunning === "queues";
}

/**
 * Whether the harness takes a message while its turn runs: its Enter queues, or its profile names a
 * queue key (`keys.queueKey`) for a harness whose Enter does something else in a turn (steers it).
 * Both need a version the binary reported, on a range that is not revoked. A provisional version
 * counts, unless the nearest older range it borrows is revoked. Every send into a turn is probed,
 * whatever the status: a dialog can open at any moment of a turn.
 */
function queuesInTurn(match: ProfileMatch | null): boolean {
  return enterQueues(match) || (turnTrusted(match) && match.profile.keys.queueKey !== undefined);
}

/**
 * Whether a released command's keys can never steer a turn: a version the binary reported, and an Enter
 * that queues in a turn or no Enter among the command's keys. Else a held command waits for a turn a
 * poll read before it goes (review of spec 15, Q1): pi and OMP send a command with an Enter that steers.
 */
function commandCannotSteer(match: ProfileMatch | null): boolean {
  if (!turnTrusted(match)) return false;
  const keys = match.profile.keys;
  return keys.enterWhileRunning === "queues" || !(keys.commandSubmit ?? keys.submit).includes("Enter");
}

/**
 * Whether the harness also queues a command entered while its turn runs (`keys.commandWhileRunning:
 * "queues"`, measured in the lab, M56 spec 15). Only then does a command take the queued path; on
 * every other harness a command in a turn is held by Collie (or refused, with no hold queue).
 */
function commandQueues(match: ProfileMatch | null): boolean {
  return queuesInTurn(match) && match?.profile.keys.commandWhileRunning === "queues";
}

/**
 * The keys that commit a send: the profile's submit keys, or its queue key for a send that goes into
 * a running turn on a harness whose Enter does not queue, so Enter never steers such a turn. A command
 * the harness runs at once in a turn ({@link runsInTurnEntry}) steers nothing: the turn gate marks it,
 * and it takes the command keys, as on an idle box.
 */
function commitKeys(state: RunState): readonly string[] {
  const keys = state.match?.profile.keys;
  if (keys === undefined) return GENERIC_SUBMIT;
  if (state.runsInTurn) return keys.commandSubmit ?? keys.submit;
  // The queued path on a harness whose Enter does not queue: S0 read a turn, or the rows above moved
  // while Collie typed. Only the queue key goes in; no other rule routes the submit keys there.
  if ((state.queued || state.streamed) && keys.enterWhileRunning !== "queues") {
    if (keys.queueKey === undefined) throw new Ended("typed_not_submitted", "changed", { detail: TURN_RUNNING });
    return [keys.queueKey];
  }
  if (state.command || state.request.mode === "command") return keys.commandSubmit ?? keys.submit;
  return keys.submit;
}

/** Whether the box answers a question the agent asked: the profile's `idle.answerPrompt` on the frame's prompt row. */
function answersQuestion(match: ProfileMatch | null, snap: Snap): boolean {
  const source = match?.profile.idle.answerPrompt;
  if (source === undefined || snap.frame === null) return false;
  const row = snap.texts[snap.frame.interior.prompt];
  return row !== undefined && new RegExp(source, "u").test(row);
}

/**
 * Whether the receipt's `queued` comes only from a witness: a harness whose Enter does not queue but
 * that takes a message in a turn through its queue key. Its queue key may be its submit key too, so a
 * send S0 read as idle may still queue, and one S0 read as running may meet the turn's end. Only the
 * harness's queued row with the text, seen in S2 or the late read, says queued.
 */
function labelFromWitness(match: ProfileMatch | null): boolean {
  return queuesInTurn(match) && !enterQueues(match);
}

/**
 * Why a request may not go into a running turn, or null when it may: a command the profile never lets
 * wait (`keys.neverHeld`) is refused first, on any harness, so that no later refusal can turn it into a
 * held send; the harness must queue, unless the command is one it runs at once in a turn
 * ({@link runsInTurnEntry}); nothing may be open at the box (a popup above or under it that the frame
 * walks past, read by the frameless cues); and what the box would hold once Enter goes out must not be
 * a command (a request in mode command, or a box text plus the new text that starts with a reserved
 * lead) unless the harness queues commands or runs that one at once. Discard always may, and is never
 * a never-held command. A command the harness runs at once is marked on the state (`runsInTurn`): the
 * commit then presses the command keys.
 *
 * `cues` says which frameless read stands for "open at the box". At S0 it is the whole screen
 * (`bareCues`). After the text is typed it is the rows under the box only (`belowCues`): the turn's
 * own answer above the box may be a numbered list or a menu, and on Claude Code 2.1.302 a list that
 * streamed in while Collie typed made the whole-screen read strong, so the send ended
 * `typed_not_submitted(changed)` with the text left in the box (live, 2026-10-17).
 */
function turnRefusal(state: RunState, s0: Snap, frame: Frame, cues: "screen" | "below" = "screen"): Ended | null {
  const { surface } = s0;
  const { request } = state;
  const text = sendLines(request.text).join("");
  const box = boxText(frame);
  const goesOut = request.mode === "append" ? box + text : request.mode === "submit" ? box : text;
  const leads = state.match?.profile.reservedLeads ?? GENERIC_LEADS;
  const isCommand = request.mode === "command" || state.command || reservedLead(goesOut, leads) !== null || (request.mode === "submit" && reservedLead(text, leads) !== null);
  // A command the profile never lets wait is refused before anything else, so that the refusal that
  // follows on a harness that takes nothing in a turn cannot turn it into a held send.
  if (request.mode !== "discard" && isCommand && neverHeldEntry(goesOut, state.match) !== null) {
    state.neverHold = true;
    return new Ended("refused", "turn_running", { surface, detail: NEVER_HELD });
  }
  const atOnce = request.mode !== "discard" && isCommand && runsInTurnEntry(goesOut, state.match) !== null;
  if (!atOnce && !queuesInTurn(state.match)) return new Ended("refused", "turn_running", { surface, detail: TURN_RUNNING });
  if ((cues === "screen" ? s0.bareCues : s0.belowCues) === "strong") return new Ended("refused", "not_free", { surface, detail: OPEN_AT_BOX });
  if (request.mode === "discard") return null;
  if (atOnce) {
    state.runsInTurn = true;
    return null;
  }
  if (isCommand && !commandQueues(state.match)) return new Ended("refused", "turn_running", { surface, detail: COMMAND_IN_TURN });
  return null;
}

/**
 * The turn rule of a manual send on a harness whose Enter does not queue (it steers the turn, or no lab
 * run measured it): no box was found to read the turn from, so any running sign on the screen counts.
 * Then a command the profile never lets wait is refused first, a command the harness runs at once in a
 * turn ({@link runsInTurnEntry}) goes ahead marked `runsInTurn` (the command keys), and otherwise the
 * send takes the queue key (`"queue"`), or is refused when the profile names none (or the turn holds a
 * command). Null when the rule does not apply or no running sign shows. Enter never steers a turn by
 * accident.
 */
function steeringTurn(state: RunState, snap: Snap): Ended | "queue" | null {
  const profile = state.match?.profile;
  if (profile === undefined || profile.keys.enterWhileRunning === "queues" || state.request.mode === "discard") return null;
  const signs = (profile.idle.runningRows ?? []).map((source) => new RegExp(source, "u"));
  const runs = snap.texts.some((row) => isRunningRow(row) || signs.some((sign) => sign.test(row.trimEnd())));
  if (!runs) return null;
  const leads = profile.reservedLeads;
  const isCommand = state.request.mode === "command" || state.command || reservedLead(state.request.text, leads) !== null;
  // The never-held check comes first, as in turnRefusal: the refusal after it would be held.
  if (isCommand && neverHeldEntry(state.request.text, state.match) !== null) {
    state.neverHold = true;
    return new Ended("refused", "turn_running", { surface: snap.surface, detail: NEVER_HELD });
  }
  if (isCommand && runsInTurnEntry(state.request.text, state.match) !== null) {
    state.runsInTurn = true;
    return "queue";
  }
  if (!queuesInTurn(state.match)) return new Ended("refused", "turn_running", { surface: snap.surface, detail: TURN_RUNNING });
  if (isCommand && !commandQueues(state.match)) return new Ended("refused", "turn_running", { surface: snap.surface, detail: COMMAND_IN_TURN });
  return "queue";
}

/** The detail of a send in a turn whose submit key left the text in the box: a dialog may have taken it. */
const ENTER_MISSED_BOX = "The submit key did not reach the box. A dialog may have taken it. Check the transcript.";

/** The detail of a held send that met a box answering the agent's question: it waits for an ordinary box. */
const ANSWER_BOX = "The input box answers a question the agent asked. A held message waits for the question to close.";
/** The detail of a send refused because the turn runs. */
const TURN_RUNNING = "The agent is working, and this harness does not take a message during a turn.";
/** The `unconfirmed` detail of a send whose whole text is one of the keys a notice above the box printed. */
const NOTICE_KEY_DETAIL = "That digit would answer the notice above the box. Check the pane, then tap Type here.";
/** The detail of a notice digit refused where no commit can go ahead (a running turn, a Replace). */
const NOTICE_KEY_HELD_DETAIL = "That digit would answer the notice above the box. Answer it on its card, or send the digit once the turn has ended.";
/** The detail of a notice's digit that still stands in the box when the notice wait ends. */
const NOTICE_DIGIT_LEFT = "The number is still in the box: the notice did not take it. Check the pane.";
/** The detail of a notice's digit gone from the box while the notice still stands. */
const NOTICE_NOT_TAKEN = "The notice did not take the number. Check the pane.";
/** The {@link SendAnswer.cause} of every send the notice digit rule decides. */
const NOTICE_KEY: SendCause = "notice_key";

/**
 * The refusal of a send whose box would hold one of a notice's digits alone where no commit can go
 * ahead (a running turn, a Replace): the person answers the notice on its card or in the pane.
 */
function noticeRefusal(s0: Snap): Ended {
  return new Ended("refused", "unconfirmed", { surface: s0.surface, offers: ["keys"], detail: NOTICE_KEY_HELD_DETAIL, cause: NOTICE_KEY });
}
/** The detail of a command refused because the turn runs. */
const COMMAND_IN_TURN = "A command waits until the turn ends.";
/** The detail of a command the profile never lets wait in a turn (`keys.neverHeld`). */
const NEVER_HELD = "Collie does not queue this command during a turn. Send it when the turn ends.";

/**
 * The profile's entry in `keys.neverHeld` that a text matches, or null. A one-character entry (`!`)
 * matches every line that starts with it; a longer one matches the command word alone or followed by
 * a space (`/clear`, `/clear all`, never `/clearly`).
 */
export function neverHeldEntry(text: string, match: ProfileMatch | null): string | null {
  const list = match?.profile.keys.neverHeld ?? [];
  const t = text.trim();
  for (const entry of list) {
    if (entry.length === 1 ? t.startsWith(entry) : t === entry || (t.startsWith(entry) && /\s/u.test(t.charAt(entry.length)))) return entry;
  }
  return null;
}

/**
 * The profile's entry in `keys.commandsRunInTurn` that a command matches, or null: the command word
 * alone or followed by white space (`/goal`, `/goal pause`, never `/goals`). Only where the profile may
 * be trusted with a running turn at all ({@link turnTrusted}): a version the binary reported, on a range
 * that is not revoked. A provisional version borrows the list as it borrows the queue key; an unread
 * version or a revoked range matches nothing, so such a command is held as before.
 */
export function runsInTurnEntry(text: string, match: ProfileMatch | null): string | null {
  if (!turnTrusted(match)) return null;
  const t = text.trim();
  for (const entry of match.profile.keys.commandsRunInTurn ?? []) {
    if (t === entry || (t.startsWith(entry) && /\s/u.test(t.charAt(entry.length)))) return entry;
  }
  return null;
}
/** The detail of a held send (M56 spec 15): the harness cannot take it during the turn, so Collie keeps it. */
const HELD = "The agent is working. Collie keeps this and sends it when the turn ends.";
/** The detail of a send held because the box was not free or would not hold still: no turn was read. */
const HELD_BOX = "The input box is not free. Collie keeps this and sends it when the box is free.";
/** The line of a held send that ended because its pane closed. */
const HELD_PANE_GONE = "The pane closed before the held text could go out.";
/** The detail a held answer carries, by what it was held for. */
function heldDetail(end: Ended): string {
  if (end.extra.detail === HELD_BEHIND) return HELD_BEHIND;
  return end.reason === "turn_running" ? HELD : HELD_BOX;
}
/**
 * Whether an end is a failed probe that left nothing behind (2026-10-17): the only keys were the probe
 * character and the one Backspace of its cleanup, and a read after that Backspace showed the box as at
 * S0. Nothing of the text went in, so the hold queue may take it like a box that was not free.
 */
function cleanProbe(state: RunState, end: Ended): boolean {
  return end.reason === "probe_failed" && end.extra.probeClean === true && state.keys.length === 2 && state.keys[0] === "probe" && state.keys[1] === "Backspace";
}
/**
 * The receipt's line for a send left typed in the box at S1 (2026-10-17): which rule kept Enter back.
 * Only the receipt carries it; the phone's own sentence for `typed_not_submitted` stays.
 */
function typedDetail(reason: SendReason): string | undefined {
  switch (reason) {
    case "changed":
      return "The frame with the typed text was gone, or the rows under the box changed, so Enter was not pressed.";
    case "mismatch":
      return "The box did not hold exactly the typed text, so Enter was not pressed.";
    case "modal_cue":
      return "Something opened at the box after the text was typed, so Enter was not pressed.";
    default:
      return undefined;
  }
}
/** The detail of a typed command whose list over or under the box pointed at another command: Enter would have run that one. */
const LIST_ELSEWHERE = "The command list at the box pointed at another command, so Enter was not pressed.";
/** The detail of a send whose S1 read showed a turn that started after S0, one the turn rule would refuse or hold (PR 491). */
const TURN_STARTED = "A turn started while the text was typed, so Enter was not pressed. The text is in the box. Submit it when the turn ends.";

/**
 * Whether a read shows a command typed into the box while the harness's command list under it points
 * at another command ({@link commandListAt}): Enter picks the highlighted entry, so it would run
 * that one. A list whose pointer rests on the typed command ({@link pointsAt}, the profile's `rows`) is
 * its own typeahead and passes; a list with no pointer is left to the cue read.
 */
function listPointsElsewhere(snap: Snap, prefix: string, lines: readonly string[], collapse: RegExp | null, rows: CommandListRows | undefined): boolean {
  const list = snap.commandList;
  if (list === null || list.pointed === null || snap.frame === null) return false;
  if (!commandBoxMatches(boxText(snap.frame), prefix, lines, collapse)) return false;
  return !pointsAt(list, prefix + lines.join(""), rows);
}

/** The detail of a typed send whose box turned out to be another screen's (the agents screen): Enter was held back. */
function otherScreenDetail(screen: string): string {
  return `The typed text went into the ${screen}'s own box, not the conversation's, so Enter was not pressed.`;
}
/** The first half of a failed probe's detail when its character went into another screen's box. */
function probeOtherScreen(screen: string): string {
  return `The probe character went into the ${screen}'s own box, not the conversation's.`;
}
/** The detail of a send held behind earlier held sends on the same pane: it never jumps the queue. */
const HELD_BEHIND = "Earlier messages wait for this pane. Collie sends this after them.";
/**
 * The modes a hold takes: a new text. Submit and Discard name a box that holds text, which a free pane
 * never has, and Add to it names the draft in the box now, which a later free pane does not hold.
 */
const HOLDABLE: ReadonlySet<SendMode> = new Set<SendMode>(["send", "command", "replace"]);
/** The modes that join the end of a pane's queue: a new message or command the person typed. */
const JOINS: ReadonlySet<SendMode> = new Set<SendMode>(["send", "command"]);
/**
 * The refusals at a release that mean "not yet" rather than "no": the pane read free on the poll but not
 * at S0 (a turn began again, a dialog drew, someone typed at the desk) or another send held the lock.
 * Nothing was typed. The request goes back to its place, at most {@link HOLD_TRIES} times.
 */
const NOT_YET: ReadonlySet<SendReason> = new Set<SendReason>(["turn_running", "busy", "not_free", "draft_present", "bound"]);
/** How often a release may go back to the queue before it ends with the refusal it met. */
const HOLD_TRIES = 5;

/** The detail of a send into a turn refused because something is open at the box (a popup over or under it). */
const OPEN_AT_BOX = "Something is open at the input box.";
/**
 * The detail of a queued send whose Enter met a dialog. Measured on Claude Code 2.1.301 (2026-10-16):
 * an Enter that lands 0, 25, 50, 100 or 200 ms after a permission dialog draws answers it with the
 * dialog's first option, so the person must look at the card before answering it again.
 */
const DIALOG_AFTER_ENTER = "A dialog opened as the message went in. Check the card before you answer it.";

/**
 * How far the typed command's own list may scroll the rows above the box ({@link ownCommandList}): its
 * row count. On a short pane the list drawn under the box pushes the whole screen up, the box and the
 * transcript with it (harness lab, tmux 120 x 40, Claude Code 2.1.302, 2026-10-17: a twelve-row list
 * under the box moved the box up eleven rows). The rows that left at the top went into the scrollback;
 * what stays above must still be the same transcript, in order. 0 with no own list.
 *
 * The list's region is taller than its rows. Claude Code 2.1.302 draws blank rows under the list down
 * to a height the pane sets (12 rows and 8 blank on the lab's 40-row tmux pane, 12 and 5 on a 36-row
 * Herdr pane), and the read leaves them out. On a screen whose rows already reach the bottom, the
 * terminal scrolls for those blank rows too: the box moved up 16 rows where the list's rows plus one
 * allowed 13, so every /model sent from such a screen was left typed (`changed`; fix rig, Herdr
 * 120 x 36, 2026-10-17). Those blank rows count too, as the rows S0 drew at the bottom that are blank
 * after the write, but only when the list stands under the box, nothing is drawn under the list, and
 * at least {@link SCROLL_ANCHOR_ROWS} transcript rows still show above to compare.
 */
function ownListScroll(before: Snap, after: Snap): number {
  const list = after.ownList;
  if (list === null) return 0;
  const rows = list.last - list.first + 1;
  if (list.side !== "under" || after.frame === null || contentEnd(after.texts) !== list.last + 1) return rows;
  if (transcriptAbove(after, after.frame).filter((row) => row.trim().length > 0).length < SCROLL_ANCHOR_ROWS) return rows;
  return rows + Math.max(0, contentEnd(before.texts) - contentEnd(after.texts));
}

/** How many non-blank transcript rows must still show above the box before blank rows under a list may count as scroll. */
const SCROLL_ANCHOR_ROWS = 2;

/** {@link aboveUnchanged} for a manual send: the transcript above the box may lose text, never gain it. */
function aboveLostOnly(before: Snap, after: Snap): boolean {
  if (before.frame === null || after.frame === null) return false;
  return lostTextOnly(transcriptAbove(before, before.frame), transcriptAbove(after, after.frame));
}

/** What a manual send asks of a framed pane: no modal cue grew, and the transcript above the box only lost text. */
function manualOutsideUnchanged(before: Snap, after: Snap): boolean {
  return !cueAppeared(before, after) && aboveLostOnly(before, after);
}

/**
 * {@link outsideUnchanged} for a `command`: the transcript above the box only; its popup may fill the
 * rows under it. The transcript may scroll up by as many rows as the box grew, plus one, plus `scroll`.
 */
function aboveUnchanged(before: Snap, after: Snap, scroll = 0): boolean {
  if (before.frame === null || after.frame === null) return false;
  const a = transcriptAbove(before, before.frame);
  const b = transcriptAbove(after, after.frame);
  const grew = after.frame.bottom - after.frame.top - (before.frame.bottom - before.frame.top);
  for (let shift = 0; shift <= Math.max(0, grew) + 1 + scroll; shift++) {
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
  /** The screen at S0 took the manual Send (no frame found, an unreadable overlay, a weak cue): the probe and S1 compare less. */
  manual: boolean;
  /** The pane has no profile: the text went in blind, with no read ({@link SendProtocol.blindSend}). */
  blind: boolean;
  /** The text is a command: sent as one, or a draft that starts with a reserved lead (Submit and Discard of a command). */
  command: boolean;
  /**
   * The confirmed commit of a digit a notice over the empty box printed ({@link SendProtocol.gateSend}):
   * no probe, the digit alone, no submit key; the notice taking it is the send.
   */
  noticeKey: boolean;
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
  /** Two reads with the same box text saw the rows under the box change (belowMovedAlone): a turn may run. */
  belowMoved: boolean;
  /** S2 or the late read saw the harness's queued row with the text ({@link showsQueued}). */
  witnessed: boolean;
  /**
   * A turn gate let a command through that the harness runs at once in a turn
   * ({@link runsInTurnEntry}). It rides the turn path's reads (`queued` or `streamed` say how it got
   * there), but the commit presses the command keys and the receipt never says `queued`.
   */
  runsInTurn: boolean;
  /** The read before the latest one, for the compares that ask how the screen moved from read to read. */
  previousRead: Snap | null;
  /** The latest read. */
  lastRead: Snap | null;
  stepStart: number;
  /** The run of a held request (M56 spec 15): its `sent` also counts under `held_sent`. */
  released?: boolean;
  /** The turn gate refused a command the profile never lets wait (`keys.neverHeld`): it is not held either. */
  neverHold?: boolean;
  /** A release met a box that answers the agent's question (`idle.answerPrompt`): it waits, and the try does not count. */
  answerWait?: boolean;
}

/** What the hold queue knows of one pane between polls (M56 spec 15 review). */
interface PaneWatch {
  /** A poll read a running turn since the last release (a hold is made from such a read). */
  sawRunning: boolean;
  /** Polls in a row that read the pane free. */
  freeReads: number;
  /** When the first of those free polls came; null while the run is empty. */
  freeSince: number | null;
  /** A poll itself read a running turn since the last release (a hold's own read does not count). */
  pollSawRunning: boolean;
  /** Polls in a row that found no pane. */
  missing: number;
}

/** Polls in a row a pane must read free, after a running turn, before its oldest held request goes. */
const FREE_POLLS = 2;
/**
 * With no running turn read since the last release: the polls in a row, and the time they must span,
 * before the next held request goes anyway. A released command that starts no turn (/help, /status),
 * or a turn shorter than one poll, then never stalls the queue (review of spec 15, V1).
 */
const QUIET_FREE_POLLS = 5;
const QUIET_FREE_MS = 10_000;
/** Polls in a row with no pane before its held requests end `pane_gone`. */
const MISSING_POLLS = 3;

/** The agent part of a pane generation (`<agent>:<session id>`): a session id that resolves or a /clear keeps it. */
function agentOfGeneration(generation: string): string {
  const at = generation.indexOf(":");
  return at < 0 ? generation : generation.slice(0, at);
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
  /** A failed probe whose one Backspace was read back: the box holds what it held at S0 (2026-10-17). */
  probeClean?: boolean;
  /** Which rule decided the end, copied onto the answer ({@link SendAnswer.cause}). */
  cause?: SendCause;
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
  if (note.cause !== undefined) draft.cause = note.cause;
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
  /** The hold queue's view of each pane with held requests, by session and pane (M56 spec 15 review). */
  private readonly watches = new Map<string, PaneWatch>();
  /** Receipts a prompt edge may close as `effective` (M56 spec 11), oldest first. */
  private readonly openSends: OpenSend[] = [];

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
      // A refusal's line and the Surface words are stored to be read later: the list carries them.
      if (receipt.detail !== undefined) row.detail = receipt.detail;
      if (receipt.saw !== undefined) row.saw = receipt.saw;
      rows.push(row);
    }
    return rows;
  }

  /**
   * A prompt edge on a pane (M56 spec 11): the harness took a prompt whose salted hash is `promptHash`.
   * `writtenAt` is when the hook wrote the edge. The newest open receipt on the pane with the same
   * hash, sent no later than that and inside its window (10 minutes queued, 30 seconds otherwise),
   * closes as `effective`: at once when it has settled, or at its settle when it still runs. Returns
   * the request id it closed, or null. Never throws; a counter or a write that fails is a warning.
   */
  promptEdge(paneId: string, promptHash: string, writtenAt: number): string | null {
    this.pruneOpen(this.now());
    const match = closingReceipt(this.openSends, paneId, promptHash, writtenAt);
    if (match === null) return null;
    const entry = this.openSends.find((open) => open.id === match.id);
    if (entry === undefined) return null;
    if (!entry.settled) {
      entry.effective = true;
      return entry.id;
    }
    this.openSends.splice(this.openSends.indexOf(entry), 1);
    try {
      const from = this.deps.store.markEffective(entry.id);
      if (from !== null) this.deps.ledger?.confirmEffective?.(entry.key, from);
      return from === null ? null : entry.id;
    } catch (err) {
      console.warn(`[send] could not close ${entry.id} as effective: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Drops open receipts past the window, and the oldest past the cap. */
  private pruneOpen(now: number): void {
    for (let i = this.openSends.length - 1; i >= 0; i--) {
      if (now - this.openSends[i]!.at > receiptWindowMs(this.openSends[i]!)) this.openSends.splice(i, 1);
    }
    if (this.openSends.length > OPEN_SENDS_MAX) this.openSends.splice(0, this.openSends.length - OPEN_SENDS_MAX);
  }

  /** The submit key is about to go out: the receipt opens for a prompt edge. */
  private openSend(state: RunState): void {
    const at = this.now();
    this.pruneOpen(at);
    // The lines as they were written: the harness reports what it took, control bytes and markers cut.
    const promptHash = this.deps.store.hashText(normalizePrompt(sendLines(state.request.text).join("\n")));
    const open: OpenSend = { id: state.record.id, paneId: state.target.paneId, promptHash, at, key: this.keyOf(state), settled: false, effective: false };
    this.openSends.push(state.queued && !state.runsInTurn ? { ...open, queued: true } : open);
  }

  /** At settle: a matched `sent` becomes `effective`; a `sent` or `unknown` stays open; any other end closes it. */
  private settleOpen(state: RunState, outcome: SendOutcome): SendOutcome {
    const entry = this.openSends.find((open) => open.id === state.record.id);
    if (entry === undefined) return outcome;
    // A witness after Enter (S2, or the late read) can find the send queued behind a turn: the
    // receipt then waits the queued window for its prompt edge.
    if (state.queued && !state.runsInTurn) entry.queued = true;
    if (entry.effective && (outcome === "sent" || outcome === "unknown")) {
      this.openSends.splice(this.openSends.indexOf(entry), 1);
      return "effective";
    }
    if (outcome === "sent" || outcome === "unknown") entry.settled = true;
    else this.openSends.splice(this.openSends.indexOf(entry), 1);
    return outcome;
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
      const detail = "This request id was already used for another text.";
      const receipt = this.receiptOf(this.bareState(request, accepted.record, target, null), "refused", "id_reused", undefined, { detail });
      return { receipt, offers: [], detail };
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
    // A pane with held sends: a new message or command joins the end of its queue, it never jumps. A
    // manual send joins too: the screen the person confirmed is not the one its turn will come on.
    // A pane with no profile never holds: its send goes in blind (see the header), so it skips this.
    // A command the harness runs at once in a turn (runsInTurnEntry) does not join: it acts on the
    // session now, and turns that follow each other with no free read (a goal that chains its turns)
    // would keep the sends ahead of it, and so the command too, waiting.
    const holds = this.deps.holds;
    const joins = holds !== undefined && JOINS.has(request.mode) && holds.waiting(target.session, target.paneId).length > 0;
    const match = joins ? await this.deps.profile(target.harness) : null;
    if (match !== null && !(request.mode === "command" && runsInTurnEntry(request.text, match) !== null)) {
      const state = this.bareState(request, accepted.record, target, match);
      const refusal = textRefusal(request, match);
      if (refusal !== null) return this.settle(state, refusal);
      // A command the profile never lets wait is refused, never held: it would act on a later session.
      if (state.command && neverHeldEntry(request.text, match) !== null) return this.settle(state, new Ended("refused", "turn_running", { detail: NEVER_HELD }));
      return this.hold(state, new Ended("refused", "turn_running", { detail: HELD_BEHIND }));
    }
    const work = this.run(request, accepted.record, target);
    this.inFlight.set(request.id, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(request.id);
    }
  }

  // ── The held send (M56 spec 15) ──

  /**
   * Whether an end is one the hold queue takes instead: a refusal before any key, of a new text, that
   * means "not yet". `turn_running` as before; `not_free` and `bound` (a box that is not free, a screen
   * that would not hold still) only for a message, never a command: a command at a box Collie could
   * not read stays a refusal. `draft_present` and `unconfirmed` need the person, so they stay refusals.
   * A `probe_failed` whose cleanup was read back (see {@link cleanProbe}) counts as no key, and is held
   * like `not_free`; one whose box Collie could not confirm clean stays a refusal.
   *
   * The box holds (`not_free`, `bound`, a clean `probe_failed`) also need a profile and a send that is
   * not manual (review, 2026-10-17): a pane with no profile, or a screen the person confirmed with Type
   * here, never reads free, so such a hold would wait out its 30 minutes with every later message
   * behind it, and its release carries no rows hash for the confirm. A `replace` whose text starts with
   * a reserved lead is a command here too.
   */
  private holdsEnd(state: RunState, end: Ended): boolean {
    if (this.deps.holds === undefined || end.outcome !== "refused") return false;
    const clean = cleanProbe(state, end);
    if (state.keys.length > 0 && !clean) return false;
    if (!HOLDABLE.has(state.request.mode) || state.neverHold === true) return false;
    if (end.reason === "turn_running") return true;
    if (state.manual || state.match === null) return false;
    const leads = state.match.profile.reservedLeads;
    const command = state.command || state.request.mode === "command" || (state.request.mode === "replace" && reservedLead(sendLines(state.request.text)[0] ?? "", leads) !== null);
    return (end.reason === "not_free" || end.reason === "bound" || clean) && !command;
  }

  /** The request goes to the end of its pane's queue; the answer's receipt says `held`. */
  private hold(state: RunState, end: Ended): SendAnswer {
    const holds = this.deps.holds!;
    const { request, target } = state;
    if (holds.waiting(target.session, target.paneId).length >= HOLD_PANE_MAX) {
      return this.settle(state, new Ended("refused", "busy", { detail: `This pane already holds ${String(HOLD_PANE_MAX)} messages. Cancel one, or wait for the turn to end.` }));
    }
    if (holds.waitingCount() >= HOLD_BRIDGE_MAX) {
      return this.settle(state, new Ended("refused", "busy", { detail: `Collie already holds ${String(HOLD_BRIDGE_MAX)} messages on this machine. Cancel one, or wait for a turn to end.` }));
    }
    // A hold made from a `turn_running` refusal read the turn running: the pane's release waits for it
    // to end. One made from a box that was not free read no turn: it goes on the quiet rule, or after a
    // turn a poll reads.
    if (end.reason === "turn_running" && end.extra.detail !== HELD_BEHIND) this.watchOf(target.session, target.paneId).sawRunning = true;
    else if (end.reason !== "turn_running") this.quietWatch(target.session, target.paneId);
    const command = state.command || request.mode === "command";
    const waitsForTurn = command && !commandCannotSteer(state.match);
    holds.add({ id: request.id, session: target.session, paneId: target.paneId, harness: target.harness, mode: request.mode, text: request.text, revision: request.revision ?? 0, command, waitsForTurn });
    const receipt = this.receiptOf(state, "held", undefined);
    this.deps.store.hold(state.record.id, receipt);
    this.count(state, receipt);
    return answerWith({ receipt, offers: [] }, { ...end.extra, detail: heldDetail(end) });
  }

  /**
   * A release that met a pane not ready yet: back to its place, its receipt `held` again. After
   * {@link HOLD_TRIES} such tries it ends with the refusal it met, its text kept for a Resend.
   */
  private backToQueue(state: RunState, end: Ended): SendAnswer {
    const holds = this.deps.holds!;
    const entry = holds.get(state.record.id);
    // An open question is a wait, not a failed try: the request waits for it to close, up to its own expiry.
    const counted = state.answerWait !== true;
    if (entry === null || (counted && entry.tries + 1 >= HOLD_TRIES)) return this.settle(state, end);
    holds.putBack(state.record.id, counted);
    const receipt = this.receiptOf(state, "held", undefined);
    this.deps.store.hold(state.record.id, receipt);
    return answerWith({ receipt, offers: [] }, { ...end.extra, detail: HELD });
  }

  /** The phone's rows for a pane's held requests, oldest first (the snapshot carries them). */
  heldOf(session: string, paneId: string): HeldRow[] {
    return this.deps.holds?.list(session, paneId).map(heldRow) ?? [];
  }

  /** The hold queue's view of a pane, made on first use. */
  /**
   * The watch of a pane whose first hold read no turn (a box that was not free): unlike
   * {@link watchOf}'s first sight, it starts with no running read, so the hold goes on the quiet rule
   * or after a turn a poll reads. A pane already watched keeps what its watch saw.
   */
  private quietWatch(session: string, paneId: string): void {
    const key = `${session}\u0000${paneId}`;
    if (!this.watches.has(key)) this.watches.set(key, { sawRunning: false, freeReads: 0, freeSince: null, pollSawRunning: false, missing: 0 });
  }

  private watchOf(session: string, paneId: string): PaneWatch {
    const key = `${session}\u0000${paneId}`;
    let watch = this.watches.get(key);
    if (watch === undefined) {
      // First sight of a pane with held requests: a hold is made from a read of a running turn, and after
      // a restart the turn may have ended while the bridge was down, so the running read counts as done.
      watch = { sawRunning: true, freeReads: 0, freeSince: null, pollSawRunning: false, missing: 0 };
      this.watches.set(key, watch);
    }
    return watch;
  }

  /**
   * One held request goes out: a fresh run of the steps under the same request id, the receipt the
   * run's own. The file says `running` before the first await, so a cancel that comes after it is
   * refused `busy`, and one that came before it leaves nothing to release. Null when the request is not
   * held (cancelled, already running, gone). The request file takes the pane's generation now: a session
   * id that resolved, or a /clear, since the hold is the same pane (the poll checked the agent).
   */
  async release(id: string): Promise<SendAnswer | null> {
    const holds = this.deps.holds;
    const entry = holds?.get(id) ?? null;
    if (holds === undefined || entry === null || entry.state !== "held" || this.inFlight.has(id)) return null;
    if (holds.markRunning(id) === null) return null;
    const watch = this.watchOf(entry.session, entry.paneId);
    // Every release starts the wait again: the next request waits for a running turn, then a free pane.
    watch.sawRunning = false;
    watch.freeReads = 0;
    watch.freeSince = null;
    watch.pollSawRunning = false;
    const record = this.deps.store.rearm(id, this.deps.generation(entry.paneId) ?? undefined);
    if (record === null) {
      holds.remove(id);
      return null;
    }
    const request: SendRequest = { id, text: entry.text, mode: entry.mode, revision: entry.revision };
    const target: SendTarget = { session: entry.session, paneId: entry.paneId, harness: entry.harness };
    const work = this.run(request, record, target, true);
    this.inFlight.set(id, work);
    let answer: SendAnswer;
    try {
      answer = await work;
    } catch (err) {
      // A throw that is not an end (a bug, a disk error): the request ends unknown, the text kept.
      holds.end(id, "unknown", "crash");
      throw err;
    } finally {
      this.inFlight.delete(id);
    }
    const outcome = answer.receipt?.outcome;
    if (outcome === "held") {
      // Back in its place with nothing typed: no turn came from it, so the pane need not run again first.
      watch.sawRunning = true;
      return answer;
    }
    if (outcome === "sent" || outcome === "effective") holds.remove(id);
    else holds.end(id, outcome ?? "unknown", answer.receipt?.reason);
    return answer;
  }

  /**
   * The hold queue's tick on the session's poll, after the Surface read the panes. Per pane with held
   * requests, oldest first:
   *  - a request past its time ends `expired` (a text after 30 minutes, a command after 10);
   *  - the pane ends its requests `refused(pane_gone)` when it holds another agent now, or when three
   *    polls in a row found no pane; a session id that resolved, or a /clear, keeps them;
   *  - the oldest held request goes only once a poll read a running turn since the last release, and
   *    then two polls in a row read the pane free; or, with no turn read, once five polls in a row read
   *    it free over at least ten seconds. A command whose Enter could steer a turn takes neither the
   *    quiet path nor the hold's own read: a poll must read the turn. A release starts that wait again.
   * Every end keeps the text. Returns the releases it started, for a test to wait on. Never throws: a
   * release that fails is a warning.
   */
  tickHolds(session: string, surfaceOf: (paneId: string) => Surface | undefined): Promise<SendAnswer | null>[] {
    const holds = this.deps.holds;
    if (holds === undefined) return [];
    const now = this.now();
    holds.prune();
    const started: Promise<SendAnswer | null>[] = [];
    const panes = new Map<string, HeldEntry[]>();
    for (const entry of holds.list(session)) {
      if (entry.state === "ended") continue;
      const rows = panes.get(entry.paneId);
      if (rows === undefined) panes.set(entry.paneId, [entry]);
      else rows.push(entry);
    }
    for (const [paneId, entries] of panes) {
      const watch = this.watchOf(session, paneId);
      const generation = this.deps.generation(paneId);
      watch.missing = generation === null ? watch.missing + 1 : 0;
      let busy = false;
      let next: HeldEntry | null = null;
      for (const entry of entries) {
        if (entry.state === "running" || this.inFlight.has(entry.id)) {
          busy = true;
          continue;
        }
        if (now >= entry.expiresAt) {
          this.endHeld(entry, "expired", undefined);
          continue;
        }
        const record = this.deps.store.get(entry.id);
        const otherAgent = generation !== null && record !== null && agentOfGeneration(generation) !== agentOfGeneration(record.paneGeneration);
        if (record === null || otherAgent || watch.missing >= MISSING_POLLS) {
          this.endHeld(entry, "refused", "pane_gone");
          continue;
        }
        next ??= entry;
      }
      if (next === null) {
        this.watches.delete(`${session}\u0000${paneId}`);
        continue;
      }
      const surface = generation === null ? undefined : surfaceOf(paneId);
      if (surface !== undefined && isFree(surface)) {
        watch.freeReads += 1;
        watch.freeSince ??= now;
      } else {
        if (surface?.turn === "running") {
          watch.sawRunning = true;
          watch.pollSawRunning = true;
        }
        watch.freeReads = 0;
        watch.freeSince = null;
      }
      // A command whose Enter could steer a turn waits for a running turn a poll itself read (review Q1).
      const afterTurn = (next.waitsForTurn === true ? watch.pollSawRunning : watch.sawRunning) && watch.freeReads >= FREE_POLLS;
      const quiet = next.waitsForTurn !== true && watch.freeReads >= QUIET_FREE_POLLS && watch.freeSince !== null && now - watch.freeSince >= QUIET_FREE_MS;
      if (busy || !(afterTurn || quiet)) continue;
      started.push(this.releaseQuietly(next.id));
    }
    return started;
  }

  /** {@link release} for the poll: a throw is a warning in the journal, never an unhandled rejection. */
  private async releaseQuietly(id: string): Promise<SendAnswer | null> {
    try {
      return await this.release(id);
    } catch (err) {
      console.warn(`[send] release of ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * A held request ends without a run: `expired`, `cancelled`, or `refused(pane_gone)`. Its receipt is
   * the held one with the new outcome; the counters take it. A cancel leaves no file; the others keep
   * the text for a Resend.
   */
  private endHeld(entry: HeldEntry, outcome: "expired" | "cancelled" | "refused", reason: SendReason | undefined): SendReceipt | null {
    const holds = this.deps.holds!;
    const record = this.deps.store.get(entry.id);
    const held = record?.receipt;
    if (outcome === "cancelled") holds.remove(entry.id);
    else holds.end(entry.id, outcome, reason);
    if (record === null || held === undefined || record.phase !== "held") return null;
    const { reason: _none, queued: _never, detail: _noDetail, saw: _noSaw, ...rest } = held;
    let receipt: SendReceipt = reason === undefined ? { ...rest, outcome } : { ...rest, outcome, reason };
    if (outcome === "refused" && reason === "pane_gone") receipt = { ...receipt, detail: HELD_PANE_GONE };
    this.deps.store.settle(entry.id, receipt);
    const ledger = this.deps.ledger;
    try {
      ledger?.send(
        { harness: held.harness === "" ? "-" : held.harness, version: held.version ?? "-", profileId: held.profileId ?? "-", status: held.profileStatus ?? "-" },
        { outcome, reason, probed: false },
      );
    } catch (err) {
      console.warn(`[surface] counters failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return receipt;
  }

  /**
   * The person's Cancel on a queued row (`DELETE /api/send/<id>`): a held request ends `cancelled` and
   * leaves no file; an ended row is dismissed (its receipt stays); a request going out now is refused
   * `busy`, and one that already went out is refused `busy` with its stored receipt. Null when the pane
   * holds no such request.
   */
  cancelHeld(session: string, paneId: string, id: string): HeldCancelAnswer | null {
    const entry = this.deps.holds?.get(id) ?? null;
    if (entry === null) {
      // No row any more: the request may have gone out a moment ago. Its own receipt says what happened.
      const record = this.deps.store.get(id);
      if (record === null || record.session !== session || record.paneId !== paneId) return null;
      if (record.phase === "settled" && record.receipt !== undefined) return { result: "refused", reason: "busy", receipt: record.receipt };
      return record.phase === "held" ? null : { result: "refused", reason: "busy" };
    }
    if (entry.session !== session || entry.paneId !== paneId) return null;
    if (entry.state === "running" || this.inFlight.has(id)) return { result: "refused", reason: "busy" };
    if (entry.state === "ended") {
      this.deps.holds!.remove(id);
      return { result: "dismissed" };
    }
    const receipt = this.endHeld(entry, "cancelled", undefined);
    return receipt === null ? { result: "cancelled" } : { result: "cancelled", receipt };
  }

  /**
   * What a Resend sends again (`POST /api/send` with `resendOf`): the stored text and mode of an ended
   * row on this pane, unmasked, never the row the phone shows. Null when there is no such row, or when it
   * may not be sent again: the pane is gone, the text may have reached the agent (`unknown`), or it
   * still stands in the box (`typed_not_submitted`, which takes Submit or Discard).
   */
  resendSource(session: string, paneId: string, id: string): { text: string; mode: SendMode } | null {
    const entry = this.deps.holds?.get(id) ?? null;
    if (entry === null || entry.session !== session || entry.paneId !== paneId || entry.state !== "ended") return null;
    if (entry.outcome === "unknown" || entry.outcome === "typed_not_submitted" || entry.reason === "pane_gone") return null;
    return { text: entry.text, mode: entry.mode };
  }

  /** An ended row goes once its Resend was taken. False when there is no such ended row. */
  dismissHeld(session: string, paneId: string, id: string): boolean {
    const entry = this.deps.holds?.get(id) ?? null;
    if (entry === null || entry.session !== session || entry.paneId !== paneId || entry.state !== "ended") return false;
    return this.deps.holds!.remove(id);
  }

  /**
   * After a start (M56 spec 15): the hold queue and the request files agree again. A request that was
   * going out when the bridge stopped has been settled `unknown(crash)` by `RequestStore.recover`: its
   * row ends with that outcome, the text kept. One that had not started yet goes back to waiting.
   * Rows whose request file is gone are dropped. Returns how many rows changed.
   */
  static reconcileHolds(holds: HoldStore, store: RequestStore): number {
    let changed = 0;
    for (const entry of holds.list()) {
      if (entry.state === "ended") continue;
      const record = store.get(entry.id);
      if (record === null) {
        holds.remove(entry.id);
        changed++;
        continue;
      }
      if (record.phase === "held") {
        if (entry.state === "running") {
          holds.putBack(entry.id);
          changed++;
        }
        continue;
      }
      const outcome = record.receipt?.outcome;
      if (outcome === "sent" || outcome === "effective" || outcome === "cancelled") holds.remove(entry.id);
      else holds.end(entry.id, outcome ?? "unknown", record.receipt?.reason ?? "crash");
      changed++;
    }
    return changed;
  }

  /**
   * After a start, once the sessions are known: held requests of a session that no longer exists go,
   * text and all. A request still held settles `refused(pane_gone)`. Returns how many rows went.
   */
  static dropHoldsOutside(holds: HoldStore, store: RequestStore, sessions: ReadonlySet<string>): number {
    let dropped = 0;
    for (const entry of holds.list()) {
      if (sessions.has(entry.session)) continue;
      const record = store.get(entry.id);
      if (record !== null && record.phase === "held" && record.receipt !== undefined) {
        const { reason: _none, queued: _never, ...rest } = record.receipt;
        store.settle(entry.id, { ...rest, outcome: "refused", reason: "pane_gone" });
      }
      if (holds.remove(entry.id)) dropped++;
    }
    return dropped;
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
      // A held request's release is bounded from its start, not from the accept (M56 spec 15).
      deadline: (record.runAt ?? record.acceptedAt) + LOCK_BOUND_MS,
      marks: { s0: null, s1: null, s2: null },
      gaps: {},
      keys: [],
      probed: false,
      manual: false,
      blind: false,
      command: request.mode === "command",
      noticeKey: false,
      heldOther: false,
      queued: false,
      streamed: false,
      belowMoved: false,
      witnessed: false,
      runsInTurn: false,
      previousRead: null,
      lastRead: null,
      stepStart: at,
    };
  }

  /**
   * The receipt of a run. A refusal also keeps its line and the words of the Surface it was refused
   * on (`note`): the sentence the phone got, cut short, and four words. Never a row, never the text.
   */
  private receiptOf(state: RunState, outcome: SendOutcome, reason: SendReason | undefined, cap?: SendCap, note?: EndNote): SendReceipt {
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
    // A command the harness ran at once in the turn waits for nothing, so it is never `queued`.
    const queued = !state.runsInTurn && (labelFromWitness(state.match) ? state.witnessed : state.queued);
    if (queued && (outcome === "sent" || outcome === "effective")) receipt.queued = true;
    if ((outcome === "refused" || outcome === "typed_not_submitted") && note !== undefined) {
      const detail = reason === "write_failed" && outcome === "refused" ? WRITE_FAILED : note.detail ?? (outcome === "typed_not_submitted" && reason !== undefined ? typedDetail(reason) : undefined) ?? reason;
      if (detail !== undefined) receipt.detail = detail.slice(0, RECEIPT_DETAIL_MAX);
      const saw = note.surface ?? state.lastRead?.surface ?? state.marks.s0?.surface;
      if (saw !== undefined) receipt.saw = surfaceWords(saw);
    }
    if (state.blind) receipt.saw = BLIND_SAW;
    return receipt;
  }

  private async prepare(target: SendTarget): Promise<SendAnswer> {
    const match = await this.deps.profile(target.harness);
    const state = this.bareState({ id: "prepare", text: "", mode: "prepare" }, prepareRecord(target, this.now()), target, match);
    try {
      const snap = await this.stableRead(state, "prepare");
      // A pane with no profile offers nothing: its next tap is a plain send, typed blind.
      return { surface: snap.surface, rowsHash: snap.rowsHash, offers: match === null ? [] : prepareOffers(snap) };
    } catch (err) {
      if (err instanceof Ended) return answerWith({ offers: ["keys"] }, { ...err.extra, detail: err.extra.detail ?? err.message });
      throw err;
    }
  }

  /**
   * One run of the steps. `release` marks the run of a held request (M56 spec 15): a refusal that means
   * "not yet" sends it back to its place in the queue instead of ending it.
   */
  private async run(request: SendRequest, record: SendRecord, target: SendTarget, release = false): Promise<SendAnswer> {
    const match = await this.deps.profile(target.harness);
    const state: RunState = { ...this.bareState(request, record, target, match), released: release };
    const { locks } = this.deps;
    if (!locks.acquire(state.lockKey, record.id, state.deadline, this.now())) {
      const busy = new Ended("refused", "busy", { detail: "Another send on this pane is still running." });
      return release ? this.backToQueue(state, busy) : this.settle(state, busy);
    }
    try {
      await this.steps(state);
      const note: EndNote = { framed: true };
      if (state.heldOther && record.mode === "submit") note.detail = HELD_OTHER;
      if (state.noticeKey) note.cause = NOTICE_KEY;
      const answer = this.settle(state, new Ended(record.mode === "discard" ? "discarded" : "sent", undefined, note));
      if (state.blind && answer.receipt?.outcome === "sent") this.noteBlindSent(state);
      return answer;
    } catch (err) {
      if (!(err instanceof Ended)) throw err;
      if (release && err.outcome === "refused" && err.reason !== undefined && ((NOT_YET.has(err.reason) && state.keys.length === 0) || cleanProbe(state, err))) return this.backToQueue(state, err);
      if (!release && this.holdsEnd(state, err)) return this.hold(state, err);
      return this.settle(state, err);
    } finally {
      locks.release(state.lockKey, record.id);
    }
  }

  /** Tell {@link SendDeps.blindSent} a blind send went out. Never throws, and never changes the answer. */
  private noteBlindSent(state: RunState): void {
    try {
      this.deps.blindSent?.({ session: state.target.session, paneId: state.target.paneId, text: state.request.text });
    } catch (err) {
      console.warn(`[send] the blind-send note failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private settle(state: RunState, end: Ended): SendAnswer {
    const outcome = this.settleOpen(state, end.outcome);
    if (outcome === "refused" && end.reason === "write_failed" && end.extra.detail !== undefined) {
      console.warn(`[send] ${state.record.id} write_failed on ${state.target.paneId}: ${end.extra.detail}`);
    }
    const receipt = this.receiptOf(state, outcome, outcome === "effective" ? undefined : end.reason, end.extra.cap, end.extra);
    this.deps.store.settle(state.record.id, receipt);
    this.count(state, receipt, end.extra.surface);
    const framed = end.extra.framed ?? (state.marks.s0?.frame ?? null) !== null;
    return answerWith({ receipt, offers: end.extra.offers ?? offersFor(outcome, receipt.reason, framed) }, end.extra);
  }

  /** The counters key of a request: harness, binary version, profile id and status, `-` where there is none. */
  private keyOf(state: RunState): CounterKey {
    const { target, match } = state;
    return { harness: match?.profile.id ?? (target.harness === "" ? "-" : target.harness), version: match?.version ?? "-", profileId: match?.profile.id ?? "-", status: match?.status ?? "-" };
  }

  /**
   * One settled request into the counters, and an example into the examples folder: a probed send
   * that went out, or a refusal whose modal read `unreadable` or `unknown` (`refusedOn`, the answer's
   * Surface, else the last read's). Never throws and never waits on anything: a counter is not a verdict.
   */
  private count(state: RunState, receipt: SendReceipt, refusedOn?: Surface): void {
    const { ledger } = this.deps;
    if (ledger === undefined) return;
    try {
      const key = this.keyOf(state);
      const probed = receipt.keys.includes("probe");
      ledger.send(key, { outcome: receipt.outcome, reason: receipt.reason, probed, released: state.released === true });
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
      if (receipt.outcome === "refused") this.refusalExample(state, receipt, key, refusedOn);
    } catch (err) {
      console.warn(`[surface] counters failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * A refusal over a screen Collie could not read, kept as a negative example: the last read's bottom
   * cluster, and each cue of its framed read with its row. The ledger masks every row the same way as
   * a sent example's. Refusals keep their own cap, one per frame hash and reason a day.
   */
  private refusalExample(state: RunState, receipt: SendReceipt, key: CounterKey, refusedOn: Surface | undefined): void {
    const snap = state.lastRead ?? state.marks.s0;
    if (snap === null) return;
    const modal = (refusedOn ?? snap.surface).modal;
    if (modal !== "unreadable" && modal !== "unknown") return;
    const win = bottomWindow(snap.plainRaw);
    this.deps.ledger?.example({
      requestId: receipt.requestId,
      ...key,
      outcome: "refused",
      reason: receipt.reason ?? "-",
      modal,
      cues: snap.cues.map((cue) => ({
        kind: cue.kind,
        at: cue.row >= win.first && cue.row < win.end ? cue.row - win.first : null,
        row: snap.texts[cue.row] ?? "",
      })),
      cluster: snap.plainRaw.slice(win.first, win.end),
      frame: snap.rowsHash,
      textLength: receipt.textLength,
    });
  }

  // ── The steps ──

  private async steps(state: RunState): Promise<void> {
    const { request, match } = state;
    const profile = match?.profile ?? null;
    const lines = sendLines(request.text);
    const leads = profile?.reservedLeads ?? GENERIC_LEADS;
    const writes = request.mode === "send" || request.mode === "command" || request.mode === "append" || request.mode === "replace";

    if (writes) {
      const refusal = textRefusal(request, match);
      if (refusal !== null) throw refusal;
    }
    // Submit and Discard name the text the box holds: a command's text may stand there with its lead read as a mode marker.
    if ((request.mode === "submit" || request.mode === "discard") && reservedLead(lines[0] ?? "", leads) !== null) state.command = true;
    const holds = (box: string): boolean => (state.command ? commandBoxMatches : boxMatches)(box, "", lines, collapseOf(match));

    if (match === null && (request.mode === "send" || request.mode === "command")) {
      await this.blindSend(state, lines);
      return;
    }

    this.begin(state);
    let s0 = await this.stableRead(state, "s0");
    state.marks.s0 = s0;
    // A held request is a message for the agent, in every mode a release runs (a send, a command, a
    // Replace): a box that answers the agent's question would take it as the answer. It waits.
    if (state.released === true && answersQuestion(match, s0)) {
      state.answerWait = true;
      throw new Ended("refused", "not_free", { surface: s0.surface, detail: ANSWER_BOX });
    }
    state.manual = takesManualSend(s0.surface);
    if (state.manual) this.gateSteeringTurn(state, s0);
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
        // The box would end up holding one of the notice's digits alone, which answers the notice.
        if (this.answersNotice(state, s0)) throw noticeRefusal(s0);
        // S0 ends with its two reads; emptying the box is its own step with its own bound.
        this.lap(state, "s0");
        if (boxText(frame).length > 0) {
          s0 = await this.clear(state, s0);
          state.marks.s0 = s0;
          this.lap(state, "clear");
        }
        break;
      }
      case "append": {
        const frame = this.draftFrame(state, s0);
        // Add to it on a box the person emptied since the phone saw its draft: the digit would stand
        // alone in the box, and the notice would take it.
        if (boxText(frame).trim().length === 0 && this.answersNotice(state, s0)) throw noticeRefusal(s0);
        break;
      }
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
    // A notice's digit is never probed: S0 proved the box empty, and no key but the digit may reach a box under the notice.
    state.probed =
      !state.noticeKey &&
      (state.queued ||
      s0.frame === null ||
      match === null ||
      match.status !== "verified" ||
      // A probe the profile calls provisional (no live send passed on a version inside its range) is never skipped.
      match.profile.probe.status !== "verified" ||
      (!isFree(s0.surface) && request.mode !== "append" && request.mode !== "replace") ||
      ([...text].length >= 1 && [...text].length <= SHORT_TEXT));
    let landing: Landing | null = null;
    if (state.probed) landing = await this.probe(state, s0, prefix);
    this.lap(state, "probe");

    await this.write(state, lines);
    this.lap(state, "write");

    if (state.noticeKey) {
      await this.awaitNoticeAnswer(state);
      this.lap(state, "s2");
      return;
    }

    // A harness that swallows a submit key sent too soon after the text names its pause in the
    // profile (`paste.settleMs`, #507): the blind send's 350 ms is the same pause with no profile
    // to name it. The pause sits before S1, so the read Enter is minted on is taken after it.
    const settleMs = state.match?.profile.paste?.settleMs;
    if (settleMs !== undefined) await this.sleep(settleMs);

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
   * A send or a command on a pane with no profile (a bare shell, a program, an agent Collie has no
   * profile for): the text, a 350 ms pause, then Enter through the gate, the way the reply route sent
   * before the protocol. No profile means no box to prove free and no submit key to trust but Enter,
   * so nothing is probed and the person's first tap is the send. One read comes first, for one thing
   * only: a password prompt on the last rows (#103, ADR 0017, the phone's own detector) refuses the
   * send before any key, with the key pad offered, so a text is never typed into a prompt that does
   * not echo it. The phone shows its password-prompt notice beside that refusal. The lock, the receipt
   * and the request id still hold. `textRefusal` already turned away a text of more than one line. A
   * failed Enter leaves the text in the pane with only the key pad offered: no rows hash binds a Submit.
   */
  private async blindSend(state: RunState, lines: readonly string[]): Promise<void> {
    state.blind = true;
    this.begin(state);
    const until = Math.min(this.now() + BOUNDS.s0.ms, state.deadline);
    let snap: Snap | null;
    try {
      snap = await this.read(state, "s0", until);
    } catch (err) {
      if (err instanceof StepLate) throw new Ended("refused", "bound", { detail: `The screen did not read inside ${String(BOUNDS.s0.ms)} ms.` });
      throw err;
    }
    if (snap === null) throw new Ended("refused", "pane_gone", { detail: "The pane could not be read." });
    state.marks.s0 = snap;
    this.checkGeneration(state, "refused");
    if (noEchoPromptIn(snap.texts) !== null) {
      throw new Ended("refused", "not_free", { surface: snap.surface, framed: false, offers: ["keys"], detail: NO_ECHO_REFUSAL });
    }
    this.lap(state, "s0");
    await this.write(state, lines);
    this.lap(state, "write");
    await this.sleep(BLIND_SETTLE_MS);
    this.guard(state);
    const { gate, store } = this.deps;
    const { paneId } = state.target;
    const token = gate.mint(paneId, GENERIC_SUBMIT, gate.revision(paneId));
    store.markSubmitSent(state.record.id);
    const result = await this.within(state, gate.commit(token));
    if (!result.ok) {
      const reason: SendReason = result.reason === "mux" ? "submit_failed" : result.reason;
      throw new Ended("typed_not_submitted", reason, { framed: false, offers: ["keys"], detail: result.reason === "mux" ? result.refusal.detail : result.detail });
    }
    state.keys.push(...GENERIC_SUBMIT);
    this.lap(state, "commit");
  }

  /**
   * The S0 rule for a plain send: free goes ahead; a draft is refused with the offers; unknown(no-match)
   * needs the person's rows hash. A running turn with no modal over a found box: an empty box goes
   * ahead when the harness queues (the receipt says `queued`), a draft is refused with its offers, and
   * a harness that does not queue, or a command, is refused `turn_running`.
   */
  private gateSend(state: RunState, s0: Snap): void {
    const { surface } = s0;
    if (isFree(surface)) {
      // On an empty box a digit the notice above it printed answers the notice: the manual Send.
      if (this.answersNotice(state, s0)) {
        state.manual = true;
        this.gateSteeringTurn(state, s0);
        this.gateManual(state, s0, NOTICE_KEY_DETAIL, NOTICE_KEY);
        state.noticeKey = true;
      }
      return;
    }
    if (surface.turn === "running" && surface.modal === "none" && s0.frame !== null && (surface.composer === "empty" || surface.composer === "draft")) {
      this.gateTurn(state, s0, s0.frame);
      if (surface.composer === "draft") {
        state.queued = false;
        throw new Ended("refused", "draft_present", { surface, framed: true, detail: "The box already holds a draft." });
      }
      // In a turn the digit would answer the notice before the harness queues it, so no commit is offered.
      if (this.answersNotice(state, s0)) {
        state.queued = false;
        throw noticeRefusal(s0);
      }
      return;
    }
    if (surface.turn === "idle" && surface.modal === "none" && surface.composer === "draft") {
      throw new Ended("refused", "draft_present", { surface, framed: s0.frame !== null, detail: "The box already holds a draft." });
    }
    if (takesManualSend(surface)) {
      this.gateManual(state, s0, "Collie cannot read this screen. Check the pane, then tap Type here.");
      return;
    }
    throw new Ended("refused", "not_free", { surface, detail: "The input box is not free." });
  }

  /** The manual Send: the first tap is refused `unconfirmed` with the rows hash, the commit goes ahead
   *  on the same rows, and the cap may ask for one more confirm. */
  private gateManual(state: RunState, s0: Snap, unconfirmed: string, cause?: SendCause): void {
    const { surface } = s0;
    if (state.request.rowsHash === undefined) {
      const note: EndNote = { surface, rowsHash: s0.rowsHash, detail: unconfirmed };
      if (cause !== undefined) note.cause = cause;
      throw new Ended("refused", "unconfirmed", note);
    }
    if (state.request.rowsHash !== s0.rowsHash) {
      throw new Ended("refused", "stale_surface", { surface, rowsHash: s0.rowsHash, detail: "The screen moved since you looked." });
    }
    // The cap counts sends typed past a screen Collie cannot read; a notice's digit is no such screen.
    if (cause !== NOTICE_KEY) this.gateCap(state, s0);
  }

  /**
   * Whether S0 shows a notice the profile names over the found box (`idle.notices`) and the send's
   * whole text, trimmed, is one of the keys it printed. The harness reads such a box as the answer to
   * the notice, so the send takes the manual Send even on a free screen.
   */
  private answersNotice(state: RunState, s0: Snap): boolean {
    const text = state.request.text.trim();
    return s0.notice !== null && s0.notice.keys.some((key) => key.key === text);
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

  /** The manual path's turn rule at S0 ({@link steeringTurn}): a refusal ends the send, a queued send takes the queue key. */
  private gateSteeringTurn(state: RunState, s0: Snap): void {
    const verdict = steeringTurn(state, s0);
    if (verdict instanceof Ended) throw verdict;
    if (verdict === "queue") state.queued = true;
  }

  /**
   * The turn rule again on the S1 read that passed (PR 491, 2026-10-18). S0 read no turn, but one may
   * start in the few hundred milliseconds before the commit key, and the S1 compare lets that through
   * where the turn draws only in the band over the box. So the read the commit is bound to meets the
   * rule S0 applies to a running turn: {@link turnRefusal} when the Surface reads the turn running over
   * a found box, else the running-sign rule of a manual send ({@link steeringTurn}). A send the rule
   * refuses or would hold gets no commit key: it ends `typed_not_submitted` with its text in the box
   * ({@link TURN_STARTED}), and nothing is held or typed again. A send the rule allows goes ahead as
   * before; on a harness whose Enter does not queue it takes the queue key, as at S0, so Enter never
   * steers the turn, and a command the harness runs at once in a turn takes the command keys, as at
   * S0. The rule's cue part reads S0's rows, as in aboveMovedInTurn: what may stand at the
   * box once the text is typed is the S1 compare's to say (a command's own list under the box is no
   * dialog). A send S0 already put on the queued path met the rule there and skips this.
   */
  private turnAtS1(state: RunState, s0: Snap, s1: Snap): void {
    if (state.queued) return;
    // The box as S0 read it: what goes out is the text plus what the box held then (Add to it).
    const frame = s1.surface.turn === "running" && s1.frame !== null ? s0.frame : null;
    const verdict = frame !== null ? (turnRefusal(state, s0, frame, "below") ?? "queue") : state.manual ? steeringTurn(state, s1) : null;
    if (verdict === null) return;
    if (verdict instanceof Ended) {
      state.marks.s1 = s1;
      throw new Ended("typed_not_submitted", "changed", sawNote(s1, { framed: s0.frame !== null, rowsHash: s1.rowsHash, detail: TURN_STARTED }));
    }
    if (state.match?.profile.keys.enterWhileRunning !== "queues") state.streamed = true;
  }

  /** Anything that goes into a turn S0 read as running (a send, Add to it, Replace, Submit, Discard) meets {@link turnRefusal}, then is queued. */
  private gateTurn(state: RunState, s0: Snap, frame: Frame): void {
    const refusal = turnRefusal(state, s0, frame);
    if (refusal !== null) throw refusal;
    state.queued = true;
  }

  /** Whether the rows above the box only scrolled and grew since the read before this one ({@link aboveScrolled}). */
  private bandScrolled(state: RunState, snap: Snap): boolean {
    const before = state.lastRead === snap ? state.previousRead : state.lastRead;
    return before !== null && aboveScrolled(before, snap);
  }

  /** The outside compare of a read in a turn: {@link turnOutsideUnchanged}, and the rows above only scrolled. */
  private turnOutside(state: RunState, s0: Snap, snap: Snap): boolean {
    return turnOutsideUnchanged(s0, snap) && this.bandScrolled(state, snap);
  }

  /**
   * The amended rule of S1 (ARCHITECTURE.md, Send Protocol, 2026-10-16): on a harness that takes a
   * message in a turn (its Enter queues, or its profile names a queue key, which commitKeys then
   * presses), a send that is not a command may see the rows ABOVE the box move while Collie types. All
   * else must hold: the frame is there, the rows under the box keep their count, the cue read inside
   * the frame is the same, and the Surface claims no modal. When the rows above moved under these
   * terms, the send takes the queued path from there and this returns true. Movement under the box, a
   * changed cue inside the frame, a missing frame or a modal claim return false, and the caller
   * refuses or ends as before.
   */
  private aboveMovedInTurn(state: RunState, s0: Snap, snap: Snap): boolean {
    // (The rows above may only scroll and grow from read to read: bandScrolled.)
    if (state.queued || state.manual || state.command || !queuesInTurn(state.match)) return false;
    const { mode } = state.request;
    if (mode !== "send" && mode !== "append" && mode !== "replace") return false;
    if (s0.frame === null || snap.frame === null || aboveUnchanged(s0, snap)) return false;
    if (snap.cueStrength !== s0.cueStrength || framedCueGrew(s0, snap) || rowsBelow(s0, s0.frame) !== rowsBelow(snap, snap.frame) || modalAtBox(snap)) return false;
    if (!this.bandScrolled(state, snap)) return false;
    // The text is in the box now: only something open under the box stops it, never the turn's answer above.
    if (snap.belowCues === "strong" || turnRefusal(state, s0, s0.frame, "below") !== null) return false;
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
    const signs = (idle?.runningRows ?? []).map((source) => new RegExp(source, "u"));
    const plain = plainRaw.map((row) => steadyRow(row, signs));
    const win = bottomWindow(texts);
    this.deps.ring.push({ requestId: state.record.id, step, at: this.now(), rows: texts });
    const framed = readCuesFor(rows, frame, idle);
    // The frameless reads never see a row the profile names as a footer row (the frame found it), nor
    // the typed command's own list over or under the box (ownCommandList): Enter there picks that command.
    const ownList = ownCommandList(texts, frame, idle);
    const bare = withoutNamedRows(withoutCommandList(rows, ownList), frame);
    // A notice over the box (`idle.notices`) is left out of every read as well: its keys act only on a
    // box holding one of its digits, so its key row is no prompt that holds the keys.
    const notice = noticeOver(texts, frame, idle);
    const snap: Snap = {
      revision: grid.value.revision,
      gateRevision,
      rows,
      texts,
      plain,
      plainRaw,
      frame,
      surface,
      cueStrength: framed.strength,
      cuesUnderBox: frame !== null && framed.cues.length > 0 && framed.cues.every((cue) => cue.row > frame.bottom),
      cues: framed.cues,
      // The box's own rows are cut out first: they hold the person's text, which may look like a list.
      // A harness that draws its dialogs in the box's place (`idle.dialogsInBox`) keeps them in.
      // A box with a blank top edge has no rule between it and the transcript, and that transcript
      // echoes each prompt behind the prompt glyph (Codex: `› the prompt`, its answer indented under
      // it), which reads as a pointer list with no anchor. There only the rows under the box count.
      bareCues:
        frame !== null && idle?.dialogsInBox === true
          ? framed.strength
          : frame !== null && idle?.frame.top.blank === true
            ? readCues(bare.slice(frame.bottom + 1), null, null).strength
            : // The notice stands above the box's interior, so its rows keep their index in this read.
              readCues(frame === null ? bare : [...bare.slice(0, frame.interior.first), ...bare.slice(frame.interior.last + 1)], null, notice).strength,
      belowCues: frame === null ? "none" : readCues(bare.slice(frame.bottom + 1), null, null).strength,
      notice,
      below: countBelow(texts, frame, (idle?.volatile.below.hints ?? []).map((source) => new RegExp(source, "u"))),
      otherScreen: otherScreenOf(texts, frame, idle?.volatile.below.otherScreens ?? []),
      commandList: frame === null ? null : commandListAt(texts, frame, idle?.volatile.below.commandList),
      ownList,
      hash: shortHash(texts.join("\n")),
      // A running row's timer is masked (steadyRow): a ticking timer is not a screen the person did not see.
      rowsHash: shortHash(plain.slice(win.first, win.end).join("\n")),
    };
    state.previousRead = state.lastRead;
    state.lastRead = snap;
    return snap;
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
    if (belowMovedAlone(first, second)) state.belowMoved = true;
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
    // A message probe on a harness that takes a message during a turn: only the box and the rows under
    // it decide, as at S1 (2026-10-17). Commands and manual sends keep the full compare below.
    const boxOnly = s0.frame !== null && !state.command && !state.manual && queuesInTurn(state.match);
    const typed = await this.poll(state, "probe", { reads: budget.reads - 1, ms: budget.ms }, (snap) => {
      if (s0.frame !== null) {
        // Queued: the Surface's claim of a modal over a found box fails, and so do two reads in a row
        // with no box. One read with no box may be torn, and its Surface claims nothing to trust.
        frameless = snap.frame === null ? frameless + 1 : 0;
        const inTurn = state.queued || state.streamed;
        if (inTurn && (frameless >= FRAMELESS_READS || modalAtBox(snap))) return "fail";
        if (snap.frame === null) return "wait";
        if (boxText(snap.frame) === boxText(s0.frame)) return "wait";
        if (boxOnly) {
          if (!probeBoxPasses(s0, snap, prefix, probe)) return "fail";
          // The rows above moved on a harness that queues in a turn: the commit takes its queue key.
          if (!state.queued && !aboveUnchanged(s0, snap)) state.streamed = true;
          return "pass";
        }
        // The probe character opens no popup, so a command in a turn is held to the full compare too.
        const outside = inTurn
          ? this.turnOutside(state, s0, snap)
          : state.manual
            ? manualOutsideUnchanged(s0, snap)
            : outsideUnchanged(s0, snap, aboveLosesText(state)) || this.aboveMovedInTurn(state, s0, snap);
        return wsFree(boxText(snap.frame)) === wsFree(prefix) + probe && outside ? "pass" : "fail";
      }
      if (snap.plain.join("\n") === s0.plain.join("\n")) return "wait";
      landing = probeLanding(s0.plain, snap.plain, probe, { freeBelow: state.manual });
      return landing !== null && !cueAppeared(s0, snap) ? "pass" : "fail";
    });
    if (typed.verdict !== "pass") {
      const screen = boxOnly ? (typed.snap?.otherScreen ?? null) : null;
      const why =
        typed.verdict === "wait" ? "The probe character did not show in the box." : screen !== null ? probeOtherScreen(screen) : "The probe character changed more than the box.";
      throw await this.probeCleanup(state, s0, typed.snap, probe, why);
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
    if (look !== null && countIn(look.texts, probe) === countIn(s0.texts, probe)) {
      const clean = failed(PROBE_REMOVED, look);
      clean.extra.probeClean = true;
      return clean;
    }
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
    // The other screen that owns the box, when a read showed one (typedBoxVerdict): the detail names it.
    let otherScreen: string | null = null;
    // The last read showed the command typed and the harness's command list pointing at another one.
    let elsewhere = false;
    let earlier: Snap | null = null;
    // A message into a framed box on a harness that takes one in a turn: only the box and what is under
    // it decide (2026-10-17 decision). Where Enter would steer or interrupt a turn and no queue key
    // exists, rows above that moved may be a turn Collie did not see, so the full compare stays.
    const boxOnly = s0.frame !== null && !command && !manual && queuesInTurn(state.match);
    const result = await this.poll(state, "s1", BOUNDS.s1, (snap) => {
      if (belowMovedAlone(earlier, snap)) state.belowMoved = true;
      earlier = snap;
      if (boxOnly) {
        const verdict = typedBoxVerdict(s0, snap, prefix, lines, collapse);
        if (verdict === "other_screen") {
          // Not the conversation's box: it does not come back by itself, and Enter there starts a new session.
          why = "changed";
          otherScreen = snap.otherScreen;
          return "fail";
        }
        if (verdict !== "pass") {
          if (verdict !== "wait") why = verdict;
          return verdict === "modal_cue" ? "fail" : "wait";
        }
        // The rows above moved on a harness that queues in a turn: the commit takes its queue key.
        if (!state.queued && queuesInTurn(state.match) && !aboveUnchanged(s0, snap)) state.streamed = true;
        return "pass";
      }
      // A command whose list under the box points at another command: Enter would run that one. The list
      // may still be catching up with the paste, so the read waits; when no read passes, the text stays.
      elsewhere = command && listPointsElsewhere(snap, prefix, lines, collapse, state.match?.profile.idle.volatile.below.commandList);
      if (elsewhere) {
        why = "modal_cue";
        return "wait";
      }
      // In a turn: the cue read inside the frame and the Surface's claim only (framedCueGrew says why).
      // A frameless cue that grew while the rows above moved is the turn's own list (aboveMovedInTurn).
      // A command: only its own popup is excused, the generic cues of the rows under the box. The
      // Surface's claim of a modal and a cue read inside the frame still fail it (review of spec 15: a
      // permission dialog drawn under the box after the write got the Enter).
      const cueGrew = command
        ? commandCueGrew(s0, snap)
        : state.queued || state.streamed
          ? framedCueGrew(s0, snap) || modalAtBox(snap)
          : cueAppeared(s0, snap) && !this.aboveMovedInTurn(state, s0, snap);
      if (cueGrew) {
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
        // A command in a turn: its popup may fill the rows under the box, so only the rows above count.
        const outside = inTurn
          ? command
            ? this.bandScrolled(state, snap)
            : this.turnOutside(state, s0, snap)
          : manual
            ? aboveLostOnly(s0, snap)
            : command
              ? aboveUnchanged(s0, snap, ownListScroll(s0, snap))
              : outsideUnchanged(s0, snap, aboveLosesText(state)) || this.aboveMovedInTurn(state, s0, snap);
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
    if (result.verdict === "pass" && result.snap !== null) {
      this.turnAtS1(state, s0, result.snap);
      return result.snap;
    }
    // A dialog that took the box's place leaves no frame to claim it at: the last read's Surface says
    // so when it reads an ask or an unreadable dialog (a screen it cannot read is `unknown`, not one).
    const endedOn = (): SendReason => why; // set inside the poll's callback, so read through a closure
    const dialogUp = result.snap !== null && result.snap.surface.modal !== "none" && result.snap.surface.modal !== "unknown";
    if (boxOnly && endedOn() === "changed" && dialogUp) why = "modal_cue";
    state.marks.s1 = result.snap;
    // The rows hash binds a later Submit or Discard to the screen this answer saw.
    const note: EndNote = { framed: s0.frame !== null };
    if (result.snap !== null) note.rowsHash = result.snap.rowsHash;
    const screen: string | null = otherScreen; // set inside the poll's callback
    if (screen !== null) note.detail = otherScreenDetail(screen);
    const pointedElsewhere: boolean = elsewhere; // set inside the poll's callback
    if (pointedElsewhere) note.detail = LIST_ELSEWHERE;
    throw new Ended("typed_not_submitted", why, sawNote(result.snap, note));
  }

  /**
   * After a notice's digit: the notice must go and the box must empty inside {@link BOUNDS.notice}, the
   * harness answering the notice with the digit. No key follows the digit either way: Enter on a box the
   * notice did not take would send the digit to the agent as a message.
   */
  private async awaitNoticeAnswer(state: RunState): Promise<void> {
    const result = await this.poll(state, "s2", BOUNDS.notice, (snap) => (snap.notice === null && snap.frame !== null && boxText(snap.frame).length === 0 ? "pass" : "wait"));
    state.marks.s2 = result.snap;
    if (result.verdict === "pass") return;
    const frame = result.snap?.frame ?? null;
    const detail = frame !== null && boxText(frame).length > 0 ? NOTICE_DIGIT_LEFT : NOTICE_NOT_TAKEN;
    throw new Ended("typed_not_submitted", "mismatch", sawNote(result.snap, { framed: true, offers: ["keys"], detail, cause: NOTICE_KEY }));
  }

  /** Commit: `submit-sent` on disk, then the submit keys through the gate on S1's revision. */
  private async commit(state: RunState, s1: Snap): Promise<void> {
    this.guard(state);
    const keys = commitKeys(state);
    const { gate, store } = this.deps;
    const token = gate.mint(state.target.paneId, keys, s1.gateRevision);
    store.markSubmitSent(state.record.id);
    this.openSend(state);
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
      if (!command && !witnessed && (labelFromWitness(state.match) || (!state.queued && enterQueues(state.match)))) witnessed = showsQueued(snap, state.match?.profile.keys.queuedRow, sentText);
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
        // A command's own screen drawn where the box stood ({@link screenInBox}) took the box as surely as no frame.
        if (command && screenInBox(snap, state)) return "pass";
        // Queued: the running sign showed before Enter, so only the box letting go of the text is
        // evidence that the harness took it.
        if (queued) return boxText(snap.frame).length === 0 ? "pass" : "wait";
        if (command && !wsFree(boxText(snap.frame)).includes(wsFree(withoutLead(lines).join("")))) return "pass";
        return boxText(snap.frame).length === 0 || runningSign(snap.rows, snap.frame, state.match?.profile.idle.runningRows) ? "pass" : "wait";
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
    if (witnessed && result.verdict === "pass") {
      state.witnessed = true;
      state.queued = true;
    }
    if (dialog) throw new Ended("unknown", "dialog_after_enter", sawNote(result.snap, { offers: ["keys"], detail: DIALOG_AFTER_ENTER }));
    // In a turn: a dialog that drew in the gap before Enter takes the Enter (its first option) and
    // closes, so S2 sees the box again, still holding the text. That is no missing evidence.
    const lastFrame = result.snap?.frame ?? null;
    if (result.verdict !== "pass" && queued && lastFrame !== null && wsFree(boxText(lastFrame)) === wsFree(sentText) && wsFree(sentText).length > 0) {
      throw new Ended("unknown", "dialog_after_enter", sawNote(result.snap, { offers: ["keys"], detail: ENTER_MISSED_BOX }));
    }
    if (result.verdict !== "pass") throw new Ended("unknown", "no_evidence", { detail: "The submit key went out, but the box did not show it was taken." });
  }

  /**
   * The late witness: a send that went in on a harness that takes a message in a turn, with no witness
   * yet (on a harness whose Enter queues: whose receipt would not say `queued`), gets one more read
   * {@link LATE_WITNESS_MS} after S2, outside S2's timing. The harness's
   * queued row with the text there makes the receipt say `queued`. Nothing else on that read counts:
   * a dialog, a read that fails or comes too late, or the request's bound changes no outcome; only the
   * label stays off. A command, a pane with no box at S2 and a receipt that says `queued` already skip it.
   */
  private async lateWitness(state: RunState, lines: readonly string[]): Promise<void> {
    const queuedRow = state.match?.profile.keys.queuedRow;
    const fromWitness = labelFromWitness(state.match);
    if (queuedRow === undefined || state.command || state.witnessed || !queuesInTurn(state.match) || (!fromWitness && state.queued)) return;
    if ((state.marks.s2?.frame ?? null) === null) return;
    // Only where a turn may run: the rows above moved while Collie typed, a spinner showed before
    // Enter above the box or under it, or the rows under the box changed between two reads with the
    // same box text (S0's two, or two S1 reads). A truly idle send skips the read.
    const { s0, s1 } = state.marks;
    const maybeTurn = state.queued || state.streamed || spinnerAbove(s0) || spinnerAbove(s1) || state.belowMoved || runningBelow(s0) || runningBelow(s1);
    if (!maybeTurn) return;
    const s1Frame = state.marks.s1?.frame ?? null;
    const sentText = s1Frame === null ? lines.join("") : boxText(s1Frame);
    if (state.deadline - this.now() <= LATE_WITNESS_MS * 2) return;
    try {
      await this.sleep(LATE_WITNESS_MS);
      const snap = await this.readNow(state, "witness", Math.min(state.deadline, this.now() + LATE_WITNESS_MS * 2));
      if (snap !== null && showsQueued(snap, queuedRow, sentText)) {
        state.witnessed = true;
        state.queued = true;
      }
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
 * The rules a text meets before any read: a plain send may not start with a reserved lead (it has the
 * command route), and a text of more than one line needs a profile's newline key. Null when it passes.
 */
function textRefusal(request: SendRequest, match: ProfileMatch | null): Ended | null {
  const lines = sendLines(request.text);
  const leads = match?.profile.reservedLeads ?? GENERIC_LEADS;
  const lead = request.mode === "command" ? null : reservedLead(lines[0] ?? "", leads);
  if (lead !== null) return new Ended("refused", "reserved_lead", { detail: LEAD_ROUTES.get(lead) ?? `A text that starts with ${lead} has its own route.` });
  if (lines.length > 1 && match === null) return new Ended("refused", "multiline", { detail: "This harness has no profile, so its newline key is unknown; send one line at a time." });
  return null;
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
