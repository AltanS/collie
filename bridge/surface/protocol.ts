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
//           profile allow it); a line break is the profile's newline key, through the gate. Where
//           the multiplexer frames a paste itself (`pasteBlock`), a long or multi-line message is ONE
//           paste instead (`wholePaste`: never a command, never a text that starts with a reserved lead)
//   S1      (6, 2500) read until the box holds exactly the predicted text (or the profile's collapse
//           form) and nothing else moved; else `typed_not_submitted`. A turn that started after an
//           idle S0 meets S0's turn rule on that read; a send it refuses or holds ends the same way
//   commit  the profile's submit keys through the gate with a 150 ms token; `submit-sent` is on disk first
//   S2      (6, 3000) read until the box is empty or a running sign shows: `sent`; else `unknown`. A command
//           that found nothing reads once more (6, 3000): its own screen may be slow to draw
// A request past the sum of the bounds ends `unknown` and releases the lock. A protocol token never carries Escape; a person's Stop does, through the key gate, with a receipt (ADR 0116).
// The sum starts once the profile and the binary's version are known (`profile` in gapsMs), never at
// the accept, and its detail names the step that ran out; a step whose end is the bound ends with its
// own outcome when its timer wakes late (ADR 0124).
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
// The steer (M69): Enter never steers a turn by accident; a steer is the person's explicit choice
// (`when: "steer"`), never the default, never an agent's. Only a send the phone posted for a person
// (`fromPhone`) may ask for it; walky talky, hooks and every other caller are refused
// `steer_not_allowed`, and a command, a pane with no profile, a profile with no `keys.steer` or a
// version not trusted with a turn (turnTrusted) are refused `steer_unsupported`, both before any read.
// Otherwise the steer runs the same S0, dialog gate and draft check as a send. An S0 that reads the turn idle sends it as
// a plain send (`sent`); so does an S1 that reads the turn ended, with the keys a plain send presses
// there. In a turn the text goes in on the queued path (probe, write), then `keys.steerDelayMs`, then
// S1, the read the key is minted on, after the pause: a dialog there (`dialog_open`), no box or a modal
// it cannot tell (`unreadable`), or the text gone from the box (`mismatch`) ends `typed_not_submitted`
// with no key. Then the profile's `keys.steer` through the gate instead of the queue key. Reads at 0.4, 1.2 and
// 2 s after the key decide (a read at 0.1 s is not reliable): the profile's steer witness
// (`keys.steerWitness`) says `steered` (a transcript row or a marker row counts only once the box let
// the text go: it reads empty or holds other text; a block counts as drawn); the queued row with the text says the harness queued it
// (`sent`, `queued`); the text still in the box after the last read is `typed_not_submitted`;
// anything else is `unknown(no_evidence)`. A steer is never held and never joins a pane's held sends.
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
// The launch window: a pane where an agent is starting is a shell, or an empty screen, for the first
// seconds, and the multiplexer may name no agent yet, so the pane has no profile of its own and a blind
// send would type into the shell and press Enter there (omp gang, 2026-10-25 and gang three S3: `sent`,
// and the text later sat as an unsent draft in the agent's box). `SendDeps.starting` names the harness
// that is starting in the pane (the bridge launched it, the pane's foreground process is its binary, or
// the multiplexer named it a moment ago), while no frame of it has been read there yet. The send then
// reads the screen with that harness's profile: with its input box on screen it runs the normal steps,
// always probed, and the window ends once the probe shows (`SendDeps.framed`); with none it ends
// `refused(probe_failed)` before any key, no probe included, saying the pane may still be starting. On a
// pane the multiplexer names already, a dialog the profile lifts keeps its own path. A box can be drawn
// before it reads keys (omp 18.12.6, about twenty seconds; gang three, 2026-10-26): a probe that never
// shows in it ends `refused(probe_failed)` with the same words, presses no Backspace (it would wait in the
// terminal too, and land in what comes next), and tells the window (`SendDeps.deaf`), which stays open.
// Nothing here names a harness.
//
// Collie's probe characters are Collie's own residue (probe-marker.ts): an idle box whose whole text is
// one or more of them, and nothing else, is no person's draft. A send, a command, Add to it, Replace and
// Discard prove that box as a draft, take out exactly those characters (one Backspace each), and go on
// from a read that shows the box empty; a box that does not empty ends `probe_failed`. A probe character
// beside any other text is never taken out.
//
// A manual send (the screen takes the two-tap Send: no frame found, an unreadable overlay, a weak cue)
// compares less than a free one: the rows under the box (hints, footers, status rows) and the rest
// of the box may change while the probe and the text go in, as a `command` lets them. The rows
// above the box may lose text (go blank, or move because rows vanished) but never gain any, and a
// modal cue that shows still fails.
//
// A box that scrolls its draft (`idle.frame.scroll`; OMP keeps the last 17 rows in view): once it stands
// at that height (Frame.scrolled) the head of a long text is out of view. S1, and Submit and Discard's
// own check, then compare the rows in view with the END of the typed text (boxHolds), as strictly as a
// box that fits; a box under that height, and a text written as one paste, are compared in full. The
// receipt's detail says only the end was compared. Discard and Replace count their clear keys before
// the first one: what a box shows, or on a scrolled box the length of the text Collie typed (a
// Discard). With no length known the request is refused `draft_present` before any key, so a clear
// never stops half way through a person's draft (omp gang, 2026-10-25).
//
// A draft read is a reading until a probe proves it (2026-10-25): a pane can keep a stale image of an
// earlier, taller layout at its foot (a resize that never reached a background pane), whose editor row
// shows a draft while the live editor, drawn higher up, is empty. So no request acts on an idle box's
// draft before a probe: a send or command it would refuse `draft_present`, an Add to it, a Replace, a
// Discard, and a returned card's Submit. The probe character must land in that box, after the draft;
// then it goes again with one Backspace and the request goes on as before. When it lands elsewhere it
// is taken back with one Backspace, and when it shows nowhere it is left alone. Either way the frame is
// stale. Collie never asks the multiplexer to redraw it (ADR 0008: a pane's geometry is the operator's).
// S0 reads once more after one S0 gap: a box that now reads empty, or shows other rows and takes a
// second probe, carries the request on from that read with the send's own probe forced. The same rows
// again, or a second probe that does not land, ends `probe_failed` with the cause `stale_screen` and
// the key pad as the only offer; nothing is deleted. One second read per request, never a loop.
// A probe that fails, goes out again with one Backspace and leaves text in the box proves a real
// draft that is not Collie's (a stale row painted over the live box row): the send ends
// `draft_present` with the draft's offers, never held (2026-10-26).
//
// A screen in flux (2026-10-26): for 50 to 100 ms after a resize Herdr shows the old frame re-wrapped
// to the new width, so S0's two reads differ in grid size (row count or widest row), or the read is torn
// (cut inside the box). That is no reason yet to hold or refuse: S0 reads once more after SETTLE_MS
// (150 ms), before any key, and that read is judged. One more S0, never a loop; its gap is `settle`.
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
// person may cancel it while it waits. A held command whose Enter could steer a turn waits for the turn
// to end: two free polls after a poll read it running, two free polls at least two seconds apart after
// only its own hold read it (the turn ended between polls), or the quiet rule when no turn was read
// since the last release. Its run reads the turn again before any key.
//
// A draft holds a walky talky message (M62 spec 02): a send its caller marks `draftHolds` is held over
// a draft instead of refused `draft_present`, and nothing is typed while the draft is there. It goes
// once two polls in a row, at least two seconds apart, read the box empty and the pane idle, or after
// the turn a submitted draft starts. Its caller names the hold's end (`holdUntil`), so one clock runs for it, and checks the pane
// once more before it goes (`releaseCheck`). Every other send keeps the refusal and its offers.
//
// Rows live only in the short memory ring below; the receipt and the request file hold hashes.
// No harness name lives here (no-harness-names.test.ts scans this folder).

import { statSync } from "node:fs";
import type { MuxAck, MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { noEchoPromptIn } from "../../web/src/lib/no-echo.ts";
import { isUploadImagePath, pastePieces } from "../../web/src/lib/upload-path.ts";
import { pointsAt, staleListUnder } from "../../web/src/lib/surface/command-list.ts";
import type { PopupRead } from "../../web/src/lib/surface/popup.ts";
import { commandListAt, isRunningRow, noticeOver, ownCommandList, popupAt, readCues, readCuesFor, runningSign, withoutCommandList, withoutPopup, withoutPromptEchoes, type CommandListRead, type Cue } from "../../web/src/lib/surface/cues.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { findInputFrame, rowText, type Frame, type FrameRow } from "../../web/src/lib/surface/frame.ts";
import { liftAsk, liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { AboveNotice } from "../../web/src/lib/surface/notice.ts";
import type { CommandListRows, OtherScreenRow, ProfileMatch, QueuedRow, SteerWitness } from "../../web/src/lib/surface/profile.ts";
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
  type SendWhen,
  type SurfaceWords,
  type HeldCancelAnswer,
  type HeldRow,
  STALE_SCREEN,
} from "../../web/src/lib/surface/send.ts";
import { askOf, frameImageKey, isFree, shortHash, type Surface } from "../../web/src/lib/surface/surface.ts";
import { closingReceipt, normalizePrompt, receiptWindowMs, type OpenReceipt } from "../../web/src/lib/surface/edges.ts";
import type { CapState, CounterKey, ExampleEntry, InboxEntry } from "./counters.ts";
import { askLifetimeOf, type AskBook } from "./ask.ts";
import type { KeyGate } from "./key-gate.ts";
import type { RequestStore, SendRecord } from "./requests.ts";
import { HOLD_BRIDGE_MAX, HOLD_PANE_MAX, heldRow, type HeldEntry, type HoldCause, type HoldStore } from "./holds.ts";
import { QueuedSends, type BoxReading, type ReceiptQueued } from "./queued.ts";
import { PROBE_MARKER, probeCharOf, probeResidue } from "./probe-marker.ts";

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

/** The probe character on a pane with no profile: Collie's one probe marker (probe-marker.ts). */
export const GENERIC_PROBE = PROBE_MARKER;
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

/** The refusal of a box that does not take keys, after its second S0 read (2026-10-25); the phone reads the same words. */
export { STALE_SCREEN };
/** The wait before a stale box's second S0 read: one S0 gap. */
const REREAD_GAP_MS = 120;

/** The detail after a failed probe whose one Backspace took the character out again. */
const PROBE_REMOVED = "One Backspace removed the probe character, so the box is clean again.";
/**
 * The detail of a probe that never showed in the box of a harness that is starting: the box is drawn but
 * reads no keys yet. The first sentence is the launch window's.
 */
function deafDetail(match: ProfileMatch | null, probe: string): string {
  return `The ${match?.profile.id ?? "agent"} input box does not take keys yet; it may still be starting. Send again in a moment: Collie first takes its probe character (${probe}) out of the box.`;
}
/** The detail of a box that held only Collie's probe characters and did not read empty after one Backspace each. */
function residueLeft(probe: string): string {
  return `The box held only Collie's probe characters (${probe}), and Backspace did not empty it. Check the pane before you type.`;
}
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
/**
 * The pause before the one more S0 of a screen whose geometry is in flux (2026-10-26, omp gang three
 * 02-desync): for 50 to 100 ms after a resize Herdr shows the old frame re-wrapped to the new width,
 * until the program draws again. Measured as `gapsMs.settle`, with the S0 read that saw it.
 */
const SETTLE_MS = 150;
/** Emptying a box (replace, discard) borrows the S2 bound: a read after every batch, inside S2's reads and ms. */
const CLEAR_BOUND = BOUNDS.s2;
/** Keys per clear batch; a read sits between two batches. */
const CLEAR_BATCH = 256;
/** The ms one clear read may take, from the S2 bound it borrows: 500. A long draft's clear gets one per read it needs. */
const CLEAR_READ_MS = CLEAR_BOUND.ms / CLEAR_BOUND.reads;
/** Reads a clear keeps beyond one per batch: the read that sees the box empty, and one late redraw. */
const CLEAR_SPARE_READS = 2;
/** The longest draft one request empties: 64 batches, about 33 s. A longer one is refused before any key. */
const CLEAR_MAX_CHARS = 16_384;
/** The detail of a Replace or Discard refused on a box that hides the head of a draft Collie cannot measure. */
const TALL_DRAFT = "The draft is taller than the box, so Collie cannot see how long it is. Nothing was deleted. Empty the box with the key pad, then send again.";
/** The detail of a Replace or Discard refused on a draft longer than one request empties. */
const LONG_DRAFT = "The draft is longer than Collie empties in one request. Nothing was deleted. Empty the box with the key pad, then send again.";
/** The detail of a receipt whose S1 compared only the rows a scrolled box showed with the end of the text. */
const TAIL_ONLY = "The box showed only the last rows of this long text. Collie compared those with the end of the text.";
/** Reads a clear gets on top when its profile names a `keys.clearAll`: one to see the box after the stroke, one spare. */
const CLEAR_ALL_READS = 2 + 2;
/** Unchanged reads, after a Backspace batch, before the profile's `keys.clearAll` goes: the first may be a late redraw. */
const CLEAR_ALL_AFTER = 3;
/** Texts this short take the probed path whatever the profile says. */
const SHORT_TEXT = 3;

/** The detail of a text that holds a paste chip's token: typed, the token would expand to a file pasted earlier. */
const CHIP_TOKEN = "This text holds the label of a paste chip. Typed into the box, the label would expand to a file or text pasted earlier, not to your words. Nothing was typed. Write the text without the label.";

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
  /** One bracketed paste of the whole text, line breaks included, where the multiplexer frames it itself. */
  pasteBlock?(paneId: string, text: string): Promise<MuxAck>;
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
  /**
   * The harness that is starting in this pane, or null (the launch window, `bridge/launch-window.ts`).
   * `named` is the agent the multiplexer names, for a pane with a profile of its own, and null for a
   * pane with none. A pane that has one takes no key until that harness's input box is on screen
   * ({@link SendProtocol}, the launch window). A throw reads as null. Absent: no pane is starting.
   */
  readonly starting?: ((paneId: string, named: string | null) => Promise<string | null> | string | null) | undefined;
  /** The box of `harness` took a key on the pane while it was starting: its window ends. Never throws into a send. */
  readonly framed?: ((paneId: string, harness: string) => void) | undefined;
  /**
   * The box of `harness` is on screen but its probe never showed, on a pane where it is starting: the
   * window stays open (it opens again inside its bound if a box read ended it), and the pane counts one
   * more probe character that may still show. Answers whether the pane is starting; 0 or a throw: not.
   */
  readonly deaf?: ((paneId: string, harness: string) => number) | undefined;
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
  /**
   * The caller's last word before a held request goes out (M62 spec 02): false ends it
   * `refused(pane_gone)` with nothing typed. The bridge asks walky talky, which checks that the pane
   * still holds the instance the message was meant for. Absent: every release goes ahead.
   */
  readonly releaseCheck?: (requestId: string, session: string, paneId: string) => boolean;
  /**
   * A request proved the box a pane's screen shows does not take keys, and a second S0 read showed the
   * same rows (2026-10-25): `frame` names the box's rows ({@link frameImageKey}). The bridge's Surface marks the
   * reads that show the same rows `staleFrame` until one differs. Called inside a try.
   */
  readonly staleFrame?: (paneId: string, frame: string) => void;
  /** Whether an upload path still names a file the harness can attach (`wholePaste`). Absent: a regular file on this disk. */
  readonly imageFile?: (path: string) => boolean;
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
  /**
   * A walky talky delivery (M62 spec 02): a draft in the box holds this send instead of refusing it.
   * Nothing is typed over the draft: the hold goes once the box reads empty and the pane idle. Every
   * other caller leaves it out and keeps the refusal and its offers.
   */
  readonly draftHolds?: boolean;
  /** With {@link draftHolds}: when the hold ends, epoch ms. It replaces the hold store's own clock. */
  readonly holdUntil?: number;
  /** `steer` (M69): into the running turn with the profile's steer key, see the header. Absent: as before. */
  readonly when?: SendWhen;
  /**
   * The request is a person's send from the phone: the bridge's `POST /api/send` route, or the reply
   * route with a request id the phone minted. Only such a request may steer. Every other caller
   * (walky talky, hooks, the CLI) leaves it out.
   */
  readonly fromPhone?: boolean;
  /**
   * A Send on a queued message a Stop gave back to the box (ADR 0122): set by `POST /api/send` alone,
   * for `resendOf` of a returned card, never read off a body. The submit then needs the S0 read, taken
   * under the pane lock right before the key, to show an idle turn as well as the exact text in the box.
   */
  readonly returnedCard?: boolean;
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

  /** Whether any request holds the lock inside its bound. */
  busy(key: string, now: number): boolean {
    const current = this.held.get(key);
    return current !== undefined && current.until >= now;
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
  /** The typeahead popup the box's text opened ({@link popupAt}), its rows left out of every count and cue read; null with none. */
  readonly popup: PopupRead | null;
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

/**
 * A read's grid size: how many rows it has and how wide its widest row is, blanks kept. Two reads of one
 * pane geometry share it; a resize between them (or the old frame re-wrapped to the new width, as
 * Herdr shows it for a moment) gives two sizes. The text inside the rows plays no part.
 */
function gridSizeOf(snap: Snap): string {
  let width = 0;
  for (const row of snap.rows) width = Math.max(width, rowText(row).length);
  return `${String(snap.rows.length)}x${String(width)}`;
}

/**
 * Whether two reads that do not agree show the pane's geometry in flux rather than a box that changed:
 * their grid sizes differ ({@link gridSizeOf}), or one has a frame and the other reads as nothing at all, no
 * frame, no cue, no dialog (`no-match`, or `torn`: cut inside the box). Herdr's `visible` read keeps
 * the pane's own row count, so the old frame re-wrapped to a narrower width can share the new size;
 * it then has no frame. A dialog that opened is not this: it reads as a dialog.
 */
function inFlux(first: Snap, second: Snap): boolean {
  if (gridSizeOf(first) !== gridSizeOf(second)) return true;
  if ((first.frame === null) === (second.frame === null)) return false;
  const reason = (first.frame === null ? first : second).surface.reason;
  return reason === "no-match" || reason === "torn";
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

/** How many rows from a queued hint are read for the queued texts. */
const QUEUED_SCAN_ROWS = 24;

/**
 * When the reads after a steer key go, in ms after it (M69). The lab (2026-10-23) saw no witness at
 * 0.1 s on pi (the row not drawn yet) and on OMP (the box still full), and Codex's header gone by 2 s,
 * the line by then in the transcript.
 */
const STEER_READS_MS = [400, 1200, 2000] as const;

/**
 * How many rows above the box hold the text as a transcript row the pattern takes: a row whose group
 * `text`, with the rows it wrapped onto, is the whole text (white space aside).
 */
function transcriptRows(snap: Snap, source: string, text: string): number {
  if (snap.frame === null) return 0;
  const start = new RegExp(source, "u");
  const want = wsFree(text);
  const above = snap.texts.slice(0, snap.frame.top);
  let count = 0;
  for (let at = 0; at < above.length; at++) {
    const head = start.exec(above[at]!);
    if (head === null) continue;
    let got = wsFree(head.groups?.["text"] ?? "");
    for (let next = at + 1; got.length < want.length && want.startsWith(got) && next < above.length && next - at <= QUEUED_SCAN_ROWS; next++) got += wsFree(above[next]!);
    if (got === want) count++;
  }
  return count;
}

/** How many rows above the box a marker pattern takes. */
function markerRows(snap: Snap, source: string): number {
  if (snap.frame === null) return 0;
  const marker = new RegExp(source, "u");
  return snap.texts.slice(0, snap.frame.top).filter((row) => marker.test(row)).length;
}

/**
 * Whether one steer witness ({@link SteerWitness}) holds on a read after the steer key, against the
 * read the key was bound to: a block with the text that was not there before; or, only once the box
 * let the text go (`letGo`: the read found a box that reads empty or holds other text), a transcript
 * row with the text more than before while no queued row holds the text, or more marker rows than
 * before. A transcript row alone is not enough: a short text ("ok") is also a line the agent may write,
 * and a marker alone does not say which text the harness took. With the text still in the box, neither counts.
 */
function steerWitnessed(before: Snap, after: Snap, witness: SteerWitness, text: string, queuedNow: boolean, letGo: boolean): boolean {
  if (witness.hint !== undefined) {
    const plain: QueuedRow = { pattern: witness.pattern, hint: witness.hint, hintGap: witness.hintGap ?? 0 };
    const withBetween: QueuedRow = witness.between === undefined ? plain : { ...plain, between: witness.between };
    const base: QueuedRow = witness.header === undefined ? withBetween : { ...withBetween, header: witness.header };
    const block: QueuedRow = witness.hintAbove === true ? { ...base, hintAbove: true } : base;
    return showsQueued(after, block, text) && !showsQueued(before, block, text);
  }
  if (!letGo) return false;
  if (witness.transcript === true) return !queuedNow && transcriptRows(after, witness.pattern, text) > transcriptRows(before, witness.pattern, text);
  return markerRows(after, witness.pattern) > markerRows(before, witness.pattern);
}

/**
 * Whether a read shows a text as a message the harness queued, by the profile's own drawing of one
 * (`keys.queuedRow`): a hint row above the box, and by it, past at most `hintGap` blank rows, the
 * queued texts — over the hint, or under it when the profile sets `hintAbove` (Muse draws its
 * `Queued input` header over the texts; lab, Muse Code 1.4.10, 2026-10-18). Each text starts on a
 * row the pattern matches, its wrapped rows indented under it. One of them, joined and
 * whitespace-free, must equal the text. A row of the profile's `between` pattern starts an entry of
 * another kind in the same block (pi's `Follow-up:` rows between its `Steering:` rows and the hint):
 * it and its wrapped rows are passed over. With a `header` (the hint under the texts), the block
 * counts only when the row over its first text is that header: OMP draws `After yield · N` over a
 * queue and `Steering · N` over a waiting steer, both with the same rows and hint. With both, a
 * `between` row is the header of another block stacked over the same hint (OMP draws `Steering · 1`,
 * its text, then `After yield · 1`, its text, then one `└ Alt+↑ to edit`): a text under it is that
 * block's, and the scan goes on upward to the next header. Rows inside the box are never read.
 */
function showsQueued(snap: Snap, queuedRow: QueuedRow | undefined, text: string): boolean {
  if (queuedRow === undefined || snap.frame === null || wsFree(text).length === 0) return false;
  const start = new RegExp(queuedRow.pattern, "u");
  const hint = new RegExp(queuedRow.hint, "u");
  const between = queuedRow.between === undefined ? null : new RegExp(queuedRow.between, "u");
  const header = queuedRow.header === undefined ? null : new RegExp(queuedRow.header, "u");
  const want = wsFree(text);
  const above = snap.texts.slice(0, snap.frame.top);
  for (let at = above.length - 1; at >= 0; at--) {
    if (!hint.test(above[at]!)) continue;
    if (queuedRow.hintAbove === true) {
      let i = at + 1;
      for (let gap = 0; i < above.length && gap < queuedRow.hintGap && above[i]!.trim().length === 0; gap++) i++;
      // Downward through the queued texts: an indented row belongs to the text over it.
      let parts: string[] | null = null;
      // Inside an entry of another kind (`between`): its wrapped rows are passed over.
      let other = false;
      for (const ceil = Math.min(above.length, i + QUEUED_SCAN_ROWS); i < ceil; i++) {
        const row = above[i]!;
        const head = start.exec(row);
        if (head !== null) {
          if (parts !== null && wsFree(parts.join("")) === want) return true;
          parts = [head.groups?.["text"] ?? ""];
          other = false;
          continue;
        }
        if (between?.test(row) === true) {
          if (parts !== null && wsFree(parts.join("")) === want) return true;
          parts = null;
          other = true;
          continue;
        }
        if (other && /^\s+\S/u.test(row)) continue;
        if (parts === null || !/^\s+\S/u.test(row)) break;
        parts.push(row.trim());
      }
      if (parts !== null && wsFree(parts.join("")) === want) return true;
      continue;
    }
    let i = at - 1;
    for (let gap = 0; i >= 0 && gap < queuedRow.hintGap && above[i]!.trim().length === 0; gap++) i--;
    // Upward through the queued texts: an indented row waits for the row that starts its text.
    let wrapped: string[] = [];
    // With a header: the text was found in the block, which counts once its header shows over it.
    let found = false;
    for (const floor = Math.max(0, i - QUEUED_SCAN_ROWS); i >= floor; i--) {
      const row = above[i]!;
      const head = start.exec(row);
      if (head !== null) {
        if (wsFree([head.groups?.["text"] ?? "", ...wrapped].join("")) === want) {
          if (header === null) return true;
          found = true;
        }
        wrapped = [];
        continue;
      }
      if (between?.test(row) === true) {
        // Another entry, with the rows it wrapped onto: passed over. Under a header it is the header of
        // another block over the same hint (OMP's `After yield · N` under its `Steering · N` block): the
        // texts found so far were that block's.
        wrapped = [];
        found = false;
        continue;
      }
      // The block's header ends it, before the indented-row rule could take it for a wrapped row.
      if (header?.test(row) === true) {
        if (found) return true;
        break;
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
function typedBoxVerdict(s0: Snap, snap: Snap, prefix: string, lines: readonly string[], collapse: RegExp | null, whole: WholePaste | null): "pass" | "wait" | "modal_cue" | "mismatch" | "changed" | "other_screen" {
  if (modalAtBox(snap) || framedCueGrew(s0, snap)) return "modal_cue";
  if (s0.frame === null || snap.frame === null) return "changed";
  if (snap.otherScreen !== null) return "other_screen";
  if (boxHolds(snap.frame, prefix, lines, collapse, whole) === null) return "mismatch";
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

/**
 * Why a steer's last read before the key refused the press (M69, counsel on the Edge 5 candidate): a
 * dialog (an ask, or one Collie cannot read) is `dialog_open`, because the steer key would answer it;
 * no read, no box, or a modal the Surface cannot tell is `unreadable`, because the key would land blind.
 */
function steerBlocked(snap: Snap | null, why: SendReason): SendReason {
  if (snap === null) return "unreadable";
  const { modal } = snap.surface;
  if (modal !== "none" && modal !== "unknown") return "dialog_open";
  if (snap.frame === null || modal === "unknown") return "unreadable";
  // A box that is there and no modal: the screen moved some other way, and S1's own word says how.
  return why;
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

/** Whether the framed cue read found cues and every one stands on a row of the frame itself: the box's own rows, not a list drawn under or over it. */
function cuesInsideFrame(snap: Snap, frame: Frame): boolean {
  return snap.cues.length > 0 && snap.cues.every((cue) => cue.row >= frame.top && cue.row <= frame.bottom);
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
 * moved screen. The rows of a stale list under an empty box (`stale`, `commandList.staleWhenEmpty`) are
 * left out the same way: the harness drops them at the next key.
 */
function countBelow(texts: readonly string[], frame: Frame | null, hints: readonly RegExp[], stale: CommandListRead | null = null, popup: PopupRead | null = null): number {
  if (frame === null) return 0;
  let n = 0;
  for (let i = frame.bottom + 1; i < texts.length; i++) {
    // The rows of a list the harness left under an empty box (`commandList.staleWhenEmpty`) go with the next key.
    if (stale !== null && i >= stale.first && i <= stale.last) continue;
    // A typeahead popup (`volatile.below.popups`) comes and goes with the text: its rows are not a screen that moved.
    if (popup !== null && i >= popup.first && i <= popup.last) continue;
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

/**
 * Whether the profile would take a message in a running turn (its Enter queues, or it names a queue
 * key) but the binary's version could not be read, so {@link queuesInTurn} says no (#594).
 */
function versionUnread(match: ProfileMatch | null): boolean {
  return match !== null && match.version === null && (match.profile.keys.enterWhileRunning === "queues" || match.profile.keys.queueKey !== undefined);
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
 * Whether a pane's harness may be steered (M69): its profile names a steer key (`keys.steer`, which
 * parses only with a witness and only where Enter steers) and may be trusted with a running turn
 * ({@link turnTrusted}). The pane view's `canSteer` and the protocol read this one rule.
 */
export function steerTrusted(match: ProfileMatch | null): boolean {
  return turnTrusted(match) && match.profile.keys.enterWhileRunning === "steers" && match.profile.keys.steer !== undefined && match.profile.keys.steerWitness !== undefined;
}

/**
 * Whether a released command's keys can never steer a turn: a version the binary reported, and an Enter
 * that queues in a turn or no Enter among the command's keys. Else a held command waits for the end of
 * the turn it was held for (review of spec 15, Q1; `tickHolds`): pi and OMP send a command with an Enter
 * that steers, so a command released into a turn would join it as text instead of running.
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
  // A steer the person asked for, into a turn S0 and S1 both read running (M69): the steer key only.
  if (state.steer) {
    if (keys.steer === undefined) throw new Ended("typed_not_submitted", "changed", { detail: STEER_UNSUPPORTED });
    return keys.steer;
  }
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
  if (!atOnce && !queuesInTurn(state.match)) return new Ended("refused", "turn_running", { surface, detail: versionUnread(state.match) ? TURN_VERSION_UNREAD : TURN_RUNNING });
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
 * accident: a steer is the person's explicit choice (`when: "steer"`), never the default, never an agent's.
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
/**
 * Submit or Discard on a box that no longer holds the text: what the person saw is gone. The route
 * reads this exact sentence to tell a returned card's Discard that only the card may go (ADR 0122).
 */
export const BOX_CHANGED = "The box no longer holds this text.";
/** A returned card's Send on a turn that runs again (ADR 0122): nothing is pressed. */
const RETURNED_BUSY = "The agent is busy again. Your message stays in its box; send it when the turn ends.";
/** The detail of a send refused because the turn runs. */
const TURN_RUNNING = "The agent is working, and this harness does not take a message during a turn.";
/**
 * The turn refusal on a harness that takes a message in a turn, on a version Collie could not read
 * (#594): the profile's queue key is trusted only on a version the binary reported (ADR 0091).
 */
const TURN_VERSION_UNREAD = "The agent is working, and Collie could not read this agent's version, so it does not type into a running turn. Run collie doctor to see why.";
/** The detail of a steer from a caller that is not a person's send from the phone (M69). */
const STEER_NOT_ALLOWED = "Only a person's send from the phone can steer a turn. This message waits for the turn instead.";
/** The detail of a steer on a pane Collie cannot steer (M69). */
const STEER_UNSUPPORTED = "Collie cannot steer this agent's turn. Send it without Steer, and it waits for the turn.";
/** The detail of a steer of a command (M69): only a message steers. */
const STEER_MESSAGE_ONLY = "Only a message can steer a turn, not a command.";
/** The detail of a steer whose text stayed in the box (M69). */
const STEER_NOT_TAKEN = "The steer key went out, but the text is still in the box.";
/** The detail of a steer with no sign either way (M69). */
const STEER_NO_EVIDENCE = "The steer key went out, but the screen did not show whether the agent took it.";
/** The `unconfirmed` detail of a send whose whole text, or first line, is one of the keys a notice above the box printed. */
const NOTICE_KEY_DETAIL = "That message would answer the notice above the box. Check the pane, then tap Type here.";
/** The detail of a notice digit refused where no commit can go ahead (a running turn, a Replace). */
const NOTICE_KEY_HELD_DETAIL = "That message would answer the notice above the box. Answer it on its card, or send it once the turn has ended.";
/** The detail of a notice's digit that still stands in the box when the notice wait ends. */
const NOTICE_DIGIT_LEFT = "The key is still in the box: the notice did not take it. Check the pane.";
/** The detail of a notice's digit gone from the box while the notice still stands. */
const NOTICE_NOT_TAKEN = "The notice did not take the number. Check the pane.";
/** The {@link SendAnswer.cause} of every send the notice digit rule decides. */
const NOTICE_KEY: SendCause = "notice_key";
/** The cause of a refusal on a screen whose input box does not take keys (2026-10-25). */
const STALE_CAUSE: SendCause = "stale_screen";

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
 * alone or followed by white space (`/goal`, `/goal pause`, never `/goals`), on one line: a text with a line break matches nothing. Only where the profile may
 * be trusted with a running turn at all ({@link turnTrusted}): a version the binary reported, on a range
 * that is not revoked. A provisional version borrows the list as it borrows the queue key; an unread
 * version or a revoked range matches nothing, so such a command is held as before.
 */
export function runsInTurnEntry(text: string, match: ProfileMatch | null): string | null {
  if (!turnTrusted(match)) return null;
  // One line only: a text with a line break is not the command the harness runs at once, so it takes the hold or queue path.
  if (/\r|\n/u.test(text)) return null;
  const t = text.trim();
  for (const entry of match.profile.keys.commandsRunInTurn ?? []) {
    if (t === entry || (t.startsWith(entry) && /\s/u.test(t.charAt(entry.length)))) return entry;
  }
  return null;
}
/** The words for a step in {@link boundDetail}: what the step waits for. */
function phaseWords(phase: string): string {
  switch (phase) {
    case "s0":
      return "S0, the two reads of the box";
    case "probe":
      return "the probe";
    case "write":
      return "the write";
    case "s1":
      return "S1, the read of the typed text";
    case "commit":
      return "the submit key";
    case "s2":
      return "S2, the wait for the box to take the text";
    case "clear":
      return "the clear of the box";
    default:
      return phase;
  }
}

/**
 * The detail of a send that ran past its bound (#594): the step it was in, how long that step had run,
 * and the gaps of the steps before it, so a report says which one used the time. The `profile` gap
 * (the version read before S0) is named too, though the bound no longer counts it.
 */
function boundDetail(state: RunState, now: number): string {
  const phase = phaseWords(state.phase);
  const spent = Object.entries(state.gaps).map(([step, ms]) => `${step} ${String(ms)} ms`);
  spent.push(`${state.phase} ${String(Math.max(0, now - state.stepStart))} ms so far`);
  return `The send ran past its bound at ${phase} (${spent.join(", ")}).`;
}

/** The detail of a held send (M56 spec 15): the harness cannot take it during the turn, so Collie keeps it. */
const HELD = "The agent is working. Collie keeps this and sends it when the turn ends.";
/** The detail of a send refused in the launch window: the harness starting in the pane has drawn no input box yet. */
function notStartedDetail(match: ProfileMatch | null): string {
  return `The pane shows no ${match?.profile.id ?? "agent"} input box yet; it may still be starting. Nothing was typed.`;
}
/** The detail of a send held because the box was not free or would not hold still: no turn was read. */
const HELD_BOX = "The input box is not free. Collie keeps this and sends it when the box is free.";
/** The line of a held send that ended because its pane closed. */
const HELD_PANE_GONE = "The pane closed before the held text could go out.";
/** The detail of a marked send held because the box holds a draft (M62 spec 02). */
const HELD_DRAFT = "The box holds a draft. Collie keeps this and sends it when the box is empty.";
/** The detail of a send held for a turn only because the version could not be read (#594). */
const HELD_VERSION_UNREAD = "The agent is working, and Collie could not read this agent's version. Collie keeps this and sends it when the turn ends. Run collie doctor to see why.";
/** The detail a held answer carries, by what it was held for. */
function heldDetail(end: Ended): string {
  if (end.extra.detail === HELD_BEHIND) return HELD_BEHIND;
  if (end.extra.detail === TURN_VERSION_UNREAD) return HELD_VERSION_UNREAD;
  if (end.reason === "draft_present") return HELD_DRAFT;
  return end.reason === "turn_running" ? HELD : HELD_BOX;
}

/** The cause a held request keeps from the refusal it was held from ({@link holdsEnd} lets only these through). */
function holdCauseOf(end: Ended): HoldCause {
  switch (end.reason) {
    case "turn_running":
    case "not_free":
    case "bound":
    case "draft_present":
    case "probe_failed":
      return end.reason;
    default:
      // holdsEnd holds no other refusal; a box hold is the plain reading if one ever does.
      return "not_free";
  }
}

/**
 * What a poll's Surface says holds a held request now, or null when it says nothing new (the pane reads
 * free, or the turn is unknown): a running turn, something open at the box (a cue or a dialog), or a
 * draft in the box. The turn comes first, as the refusal rules read it.
 */
function causeOf(surface: Surface): HoldCause | null {
  if (surface.turn === "running") return "turn_running";
  if (surface.modal !== "none") return "not_free";
  if (surface.turn === "idle" && surface.composer === "draft") return "draft_present";
  return null;
}
/**
 * Whether an end is a failed probe that left nothing behind (2026-10-17): the only keys were the probe
 * character and the one Backspace of its cleanup, and a read after that Backspace showed the box as at
 * S0. Nothing of the text went in, so the hold queue may take it like a box that was not free.
 */
function cleanProbe(state: RunState, end: Ended): boolean {
  return end.reason === "probe_failed" && end.extra.probeClean === true && probeOnly(state);
}
/** The only keys that left were the probe and the Backspace that took it out again. */
function probeOnly(state: RunState): boolean {
  return state.keys.length === 2 && state.keys[0] === "probe" && state.keys[1] === "Backspace";
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
/** The detail of a Submit of a typed command whose list under the box points at another command: Enter would run that one. */
const SUBMIT_ELSEWHERE = "The command list at the box points at another command, so Enter was not pressed. Discard the text, or pick the command with the keys.";
/** The detail of a typed command with a typeahead popup open under the box: Enter would act on the popup. */
const POPUP_AT_ENTER = "A popup is open under the box, and Enter would act on it, so Enter was not pressed. Submit the text, or discard it.";
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

/**
 * The detail of a send left typed because the box's own rows read as a list (a cue inside the frame) while the box holds exactly
 * the typed text: nothing opened, the box shape could not be read. The known case is a draft of two lines under a composer shape
 * whose prompt glyph stands on the first row (omp's `claude` shape, omp-gang 04-readers, 2026-10-26).
 */
const BOX_UNREADABLE_DRAFT = "The box shape could not be read: the rows of the box look like a list, though nothing opened. A draft of two or more lines in a composer shape that puts a prompt glyph on its first row is a known gap. Enter was not pressed.";
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
  // The box moved up (its list opened under it, or it grew): the volatile band is a fixed number of rows
  // counted up from the box's top edge, so it now reaches higher and takes the last rows of the transcript
  // into itself. That happens when the transcript is shorter than the pane and blank rows fill the gap
  // over the box: the list takes its room from the blank rows, the transcript stays where it was, and the
  // band, no longer padded by blank rows, covers its last lines (omp 18.12.6, `/plan` with plan mode on,
  // tester 14, 2026-10-25: three lines went into the band). The rows that stay must still be the same,
  // in order, and no row is new: the transcript may end earlier by up to the band's height.
  const bandRows = after.frame.volatile.above === null ? 0 : after.frame.volatile.above.last - after.frame.volatile.above.first + 1;
  const bandMoved = after.frame.top < before.frame.top;
  for (let shift = 0; shift <= Math.max(0, grew) + 1 + scroll; shift++) {
    const tail = a.slice(shift);
    if (tail.length === b.length && tail.every((row, i) => row === b[i])) return true;
    const lost = tail.length - b.length;
    if (bandMoved && lost > 0 && lost <= bandRows && b.some((row) => row.length > 0) && b.every((row, i) => row === tail[i])) return true;
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

/** A text the write sends as ONE paste (`pasteBlock`): what the harness keeps of it in the box. */
export interface WholePaste {
  /** The image files the harness takes off the paste; each shows as one `image` token before the rest. */
  readonly images: number;
  /** The profile's image token, or null when the profile names none (then `images` is 0). */
  readonly image: RegExp | null;
  /** The text that stays in the paste, as lines. */
  readonly lines: readonly string[];
}

/**
 * One line of at most this many characters is written as before, never as a whole paste: Claude Code
 * inserts a paste this short literally (ADR 0010, the 2026-10-03 addendum: 800 literal, 801 a token).
 */
const WHOLE_PASTE_MIN_CHARS = 800;

function isImageFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Whether a text goes as ONE paste, and what the box then shows of it; null for the write per line.
 * Only where the profile measured it (`paste.block`), only for a message of more than one line or of
 * more than {@link WHOLE_PASTE_MIN_CHARS} on one line (a dictation is often one long line), and never
 * for a text that starts with a reserved lead: a slash command, a shell line or a file mention keeps
 * the write it has always had, so the harness reads the lead as typed. With the profile's image
 * token, the pieces that are Collie's own uploads (the shape the web adapter's `liftedPaste` reads,
 * `web/src/lib/upload-path.ts`) and still a file on this disk come off the paste the way the harness
 * takes them (lab, Claude Code 2.1.305: `<text> /shot.jpg` shows `[Image #1][Pasted text #2]`); the
 * kept pieces stay, joined by newlines. Any other image path stays text here: the harness may still
 * take it, and then the box does not match and the send stalls instead of guessing.
 */
export function wholePaste(match: ProfileMatch | null, lines: readonly string[], imageFile: (path: string) => boolean = isImageFile): WholePaste | null {
  const paste = match?.profile.paste;
  if (match === null || paste?.block !== true) return null;
  const text = lines.join("\n");
  if (lines.length === 1 && text.length <= WHOLE_PASTE_MIN_CHARS) return null;
  if (reservedLead(lines[0] ?? "", match.profile.reservedLeads) !== null) return null;
  if (paste.image === undefined) return { images: 0, image: null, lines };
  const image = new RegExp(paste.image, "uy");
  const pieces = pastePieces(text);
  const kept = pieces.filter((piece) => !(isUploadImagePath(piece) && imageFile(piece.trim())));
  const images = pieces.length - kept.length;
  return { images, image, lines: images === 0 ? lines : kept.join("\n").split("\n") };
}

/**
 * The tail half of the box compare, for a box at its scroll height (omp gang, 2026-10-25): the box
 * shows the END of the typed text, white space and wrapping ignored as in {@link boxMatches}, and less
 * than all of it. Every character the box shows must stand at the end of the text, in order, and the
 * last one must be the text's last: what is in view is compared as strictly as a box that fits.
 */
export function boxMatchesTail(box: string, prefix: string, lines: readonly string[]): boolean {
  const seen = wsFree(box);
  const typed = wsFree(prefix + lines.join(""));
  return seen.length > 0 && seen.length < typed.length && typed.endsWith(seen);
}

/**
 * Whether a framed box holds the typed text: `all` of it ({@link boxMatches}), or, on a box at the
 * height where its profile scrolls the draft (`idle.frame.scroll` keeps the last rows,
 * {@link Frame.scrolled}), its `tail` ({@link boxMatchesTail}); null otherwise. A box that shows fewer
 * rows than that height shows its whole draft, so it is never compared by its tail, and neither is a
 * text written as one paste, which the harness may fold.
 */
function boxHolds(frame: Frame, prefix: string, lines: readonly string[], collapse: RegExp | null, whole: WholePaste | null): "all" | "tail" | null {
  const box = boxText(frame);
  if (boxMatches(box, prefix, lines, collapse, whole)) return "all";
  return frame.scrolled === true && whole === null && boxMatchesTail(box, prefix, lines) ? "tail" : null;
}

/**
 * Whether the box text equals `prefix` then each line, white space and wrapping ignored. A line may
 * also show as the profile's collapse form (a long paste the harness folded), whose line count, if it
 * carries one, must say one line: each written line is its own write. A text written as ONE paste
 * (`whole`) first shows its image tokens, then may stand as one collapse form for all of it, whose
 * line count is exactly the line breaks the kept text holds (Claude Code counts `+M lines` as the
 * `\n`s in the paste; lab, 2.1.304), or else lands literally, never one line of it folded. Its tokens
 * are read with white space taken out, since the box may wrap inside one. Without `whole` none of this
 * is read: a profile that writes per line keeps the rule above.
 */
export function boxMatches(box: string, prefix: string, lines: readonly string[], collapse: RegExp | null, whole: WholePaste | null = null): boolean {
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
  if (whole !== null) {
    // The tokens are read with all white space taken out, the box's and the pattern's: the box may wrap
    // inside a token (`+9 li` / `nes]`, ADR 0010).
    let squeezed = "";
    const at: number[] = [];
    for (let i = p; i < box.length; i++) {
      if (isSpace(box[i])) continue;
      squeezed += box[i];
      at.push(i);
    }
    at.push(box.length);
    let q = 0;
    const take = (token: RegExp | null): RegExpExecArray | null => {
      if (token === null) return null;
      const bare = new RegExp(token.source.replaceAll(" ", ""), "uy");
      bare.lastIndex = q;
      const m = bare.exec(squeezed);
      if (m !== null) q += m[0].length;
      return m;
    };
    for (let i = 0; i < whole.images; i++) if (take(whole.image) === null) return false;
    const after = q;
    const m = take(collapse);
    const count = m?.groups?.lines;
    if (m !== null && q === squeezed.length && (count === undefined ? lines.length === 1 : Number(count) === lines.length - 1)) return true;
    p = at[after]!;
  }
  for (const line of lines) {
    const at = p;
    if (eat(line)) continue;
    p = at;
    // A whole paste folds whole or lands literally, never one line of it.
    if (whole !== null || !eatCollapse()) return false;
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
  /** The request's bound. Emptying a long draft moves it later by its own bound ({@link SendProtocol.stretch}). */
  deadline: number;
  readonly marks: { s0: Snap | null; s1: Snap | null; s2: Snap | null };
  readonly gaps: Partial<Record<SendStep, number>>;
  readonly keys: string[];
  probed: boolean;
  /** The screen at S0 took the manual Send (no frame found, an unreadable overlay, a weak cue): the probe and S1 compare less. */
  manual: boolean;
  /** The pane has no profile: the text went in blind, with no read ({@link SendProtocol.blindSend}). */
  blind: boolean;
  /**
   * A harness is starting in the pane ({@link SendDeps.starting}): `match` is its profile (the pane's
   * own, or the starting harness's on a pane with none), and nothing is typed or pressed until S0 finds
   * its input box. {@link RunState.startingNamed} says whether the pane has a profile of its own.
   */
  starting: boolean;
  /** The pane has a profile of its own: a dialog the profile lifts keeps its own path in the window. */
  startingNamed: boolean;
  /** The text is a command: sent as one, or a draft that starts with a reserved lead (Submit and Discard of a command). */
  command: boolean;
  /** The text went, or a draft stands, as ONE paste ({@link wholePaste}); null for the write per line. */
  whole: WholePaste | null;
  /**
   * The confirmed commit of a digit a notice over the empty box printed ({@link SendProtocol.gateSend}):
   * no probe, the digit alone, no submit key; the notice taking it is the send.
   */
  noticeKey: boolean;
  /** A Submit or Discard found the box holding another text than the request names (the person's own Backspace shortened it). */
  heldOther: boolean;
  /**
   * The box stood at its scroll height and showed only the end of the text: S1 (or Submit and
   * Discard's own check) compared those rows with the end of the text (boxHolds). The receipt says so.
   */
  tailOnly: boolean;
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
  /** The step that runs now (a read's step name, `write`, `commit`): the bound's detail names it ({@link boundDetail}). */
  phase: string;
  /** The run of a held request (M56 spec 15): its `sent` also counts under `held_sent`. */
  released?: boolean;
  /** The turn gate refused a command the profile never lets wait (`keys.neverHeld`): it is not held either. */
  neverHold?: boolean;
  /** A release met a box that answers the agent's question (`idle.answerPrompt`): it waits, and the try does not count. */
  answerWait?: boolean;
  /** A steer (M69) that S0 read into a running turn: the commit presses `keys.steer`, and the reads after it look for the steer witness. */
  steer: boolean;
  /** The steer witness showed after the steer key: the receipt says `steered`. */
  steered: boolean;
  /** The probe proved S0's draft a stale image and S0 read once more (the header): once per request. */
  reread: boolean;
}

/** What the hold queue knows of one pane between polls (M56 spec 15 review). */
interface PaneWatch {
  /** A poll read a running turn since the last release (a hold is made from such a read). */
  sawRunning: boolean;
  /** Polls in a row that read the pane free. */
  freeReads: number;
  /** When the first of those free polls came; null while the run is empty. */
  freeSince: number | null;
  /**
   * A poll itself read a running turn since the last release (a hold's own read does not count). A
   * command that waits for a turn goes on two free polls after such a read; after the hold's read alone
   * its two free polls must span {@link DRAFT_LEFT_MS}.
   */
  pollSawRunning: boolean;
  /** Polls in a row that found no pane. */
  missing: number;
  /**
   * The pane's holds were made from a box that was not free (no turn read), and since then no poll read
   * a running turn and no release ran (2026-10-26). Its cause clears on the first free poll.
   */
  cleared?: boolean;
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
/**
 * A hold made from a box that was not free, with no turn read and no release since (2026-10-26, omp
 * gang three 03-launch headline 6): its cause has cleared once this many polls in a row read the pane
 * idle with an empty box. Its release reads S0 fresh, two reads that must agree, before any key; one that
 * finds the box not free goes back to its place. The quiet rule stays for the requests after a release
 * and the turn rules for a turn a poll read: there a turn may yet draw. An idle pane polls every
 * `pollIdleMs` (12 s), so five quiet polls kept a send held for about 50 s on an idle, empty box.
 */
const CLEARED_FREE_POLLS = 1;
/**
 * A marked request held over a draft (M62 spec 02) goes on two free reads in a row, and the second
 * comes at least this long after the first. The poll ticks on every screen update, so two reads can be
 * a few hundred milliseconds apart, and a draft just submitted reads as an empty box over an idle pane
 * until the agent draws its turn. Field case 2026-10-21 (browser leg case 9, Claude Code on Haiku): two
 * reads about a second after the Enter released the message, the turn showed while it was typed, and
 * it ended `typed_not_submitted(changed)` with the text left in the box. A box the person cleared waits
 * these two seconds; a submitted draft's turn shows inside them and makes it a turn hold.
 */
const DRAFT_LEFT_MS = 2000;
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
  /** S0's two reads differed in grid size ({@link gridSizeOf}): the pane's geometry moved between them (2026-10-26). */
  inFlux?: boolean;
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

/**
 * Whether Submit and Discard would be taken on `surface`, the screen a `typed_not_submitted` answer last saw:
 * a box that holds a draft or nothing under no modal, or a screen the manual road takes. Anything else (a
 * torn read, a dialog, a turn nobody can read) is refused `not_free` by both verbs, so the answer must not
 * offer them (omp-gang three, S1: the offered Submit and Discard answered `not_free`).
 */
function submitDiscardOpen(surface: Surface): boolean {
  if (takesManualSend(surface)) return true;
  return surface.turn !== "unknown" && surface.modal === "none" && (surface.composer === "draft" || surface.composer === "empty");
}

/** The offers of an end: the shared rules, but Submit and Discard only where they would be taken. */
function offersOf(outcome: SendOutcome, reason: SendReason | undefined, framed: boolean, surface: Surface | undefined): SendOffer[] {
  if (outcome === "typed_not_submitted" && surface !== undefined && !submitDiscardOpen(surface)) return ["keys"];
  return offersFor(outcome, reason, framed);
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
  /** Sends that settled `sent` + `queued`, with their texts, until the journal or the box closes them (ADR 0122). */
  private readonly queuedSends: QueuedSends;

  constructor(private readonly deps: SendDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.queuedSends = new QueuedSends({
      store: deps.store,
      generation: deps.generation,
      matches: (box, lines, collapse) => boxMatches(box, "", lines, collapse),
      now: this.now,
      busy: (session, paneId) => deps.locks.busy(`${session}\u0000${paneId}`, this.now()),
    });
  }

  /**
   * The pane's open queued sends, oldest first (ADR 0122): sends that settled `sent` + `queued` inside
   * the bound, each `queued` or `returned`. The live window decides which of them the journal already
   * shows as a prompt; this only lists what Collie's receipts left open.
   */
  queuedOf(session: string, paneId: string): ReceiptQueued[] {
    return this.queuedSends.of(session, paneId);
  }

  /**
   * One read of a pane (ADR 0122): its input box ("" for an empty box, null when the read found no box)
   * and its turn. Marks the open queued sends whose texts the box holds as returned (their receipts take
   * `late: "returned"`), ends the returned ones it no longer holds, keeps a running turn's queued cards
   * alive, and turns a queued card unconfirmed after polls of an idle turn over an empty box
   * (QueuedSends.boxRead). Returns the ids the box holds. The poll's Surface read and the Stop's
   * read-back both call it. Never throws.
   */
  boxRead(session: string, paneId: string, reading: BoxReading): string[] {
    try {
      return this.queuedSends.boxRead(session, paneId, reading);
    } catch (err) {
      console.warn(`[send] box read on ${paneId} failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  /**
   * The poll's tick for queued sends, after the Surface read the panes: one {@link boxRead} per pane
   * with open queued sends. `boxOf` answers the newest read's box and when it was taken, or null.
   */
  tickQueued(session: string, boxOf: (paneId: string) => Omit<BoxReading, "poll"> | null): void {
    for (const paneId of this.queuedSends.panes(session)) {
      const read = boxOf(paneId);
      if (read !== null) this.boxRead(session, paneId, { ...read, poll: true });
    }
  }

  /**
   * The unmasked text of a queued send that is back in the box, for the Send or Discard on its card
   * (`POST /api/send` with `resendOf` and mode `submit` or `discard`); null when the row is not back
   * in the box on this pane.
   */
  returnedSource(session: string, paneId: string, id: string): string | null {
    return this.queuedSends.returnedText(session, paneId, id);
  }

  /** A returned row's Send or Discard was taken: the row goes now rather than at the next read. */
  dismissReturned(id: string): void {
    this.queuedSends.drop(id);
  }

  /**
   * The newest settled requests for a pane, newest first, as the session page lists them (M56 spec 09).
   * The request files hold receipts and the line Sent would keep (requests.ts), so no row of the screen
   * can come out of here, and of the text only that line.
   */
  recent(paneId: string, limit = 10): SendReceiptRow[] {
    const rows: SendReceiptRow[] = [];
    for (const record of this.deps.store.list().toReversed()) {
      if (rows.length >= limit) break;
      const receipt = record.receipt;
      if (record.paneId !== paneId || receipt === undefined) continue;
      const row: RowDraft = { requestId: record.id, at: record.acceptedAt, mode: record.mode, outcome: receipt.outcome, keys: receipt.keys, gapsMs: receipt.gapsMs, harness: receipt.harness, version: receipt.version };
      if (receipt.reason !== undefined) row.reason = receipt.reason;
      if (receipt.profileId !== null) row.profileId = receipt.profileId;
      if (receipt.profileStatus !== null) row.profileStatus = receipt.profileStatus;
      if (receipt.cap !== undefined) row.cap = receipt.cap;
      if (receipt.queued === true) row.queued = true;
      if (receipt.late !== undefined) row.late = receipt.late;
      // A refusal's line and the Surface words are stored to be read later: the list carries them.
      if (receipt.detail !== undefined) row.detail = receipt.detail;
      if (receipt.saw !== undefined) row.saw = receipt.saw;
      if (record.line !== undefined) row.line = record.line;
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
    // The harness took the prompt: a queued send is not waiting any more.
    this.queuedSends.drop(entry.id);
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
        // A command's draft refusal offers no Add on a replay either: the same rule, read from the same request.
        const command = stored.reason === "draft_present" && draftCommand(request, await this.deps.profile(target.harness));
        const replay: SendAnswer = { receipt: stored, offers: offersFor(stored.outcome, stored.reason, stored.profileId !== null, command), replayed: true };
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
    const waiting = holds?.waiting(target.session, target.paneId) ?? [];
    // A queue of marked sends held over a draft only (M62 spec 02) does not take an unmarked send: that
    // one runs, and a draft still in the box refuses it with its offers, as on a pane with no queue.
    const draftOnly = request.draftHolds !== true && waiting.every((entry) => entry.draftHolds === true && entry.cause === "draft_present");
    // A steer never joins (M69): it is for the turn that runs now, and goes in ahead of the held sends,
    // which wait for that turn to end anyway.
    const joins = holds !== undefined && JOINS.has(request.mode) && waiting.length > 0 && !draftOnly && request.when !== "steer";
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
   * not read stays a refusal. `draft_present` and `unconfirmed` need the person, so they stay refusals,
   * except a `draft_present` on a send its caller marked `draftHolds` (a walky talky delivery, M62
   * spec 02): that one is held, typed once the box reads empty and the pane idle.
   * A `probe_failed` whose cleanup was read back (see {@link cleanProbe}) counts as no key, and is held
   * like `not_free`; one whose box Collie could not confirm clean stays a refusal. A cleanup that reads
   * a draft in the box is no such end: the probe proved a real draft, and it ends `draft_present`
   * ({@link probeCleanup}, 2026-10-26).
   *
   * The box holds (`not_free`, `bound`, a clean `probe_failed`) also need a profile and a send that is
   * not manual (review, 2026-10-17): a pane with no profile, or a screen the person confirmed with Type
   * here, never reads free, so such a hold would wait out its 30 minutes with every later message
   * behind it, and its release carries no rows hash for the confirm. A `replace` whose text starts with
   * a reserved lead is a command here too.
   */
  private holdsEnd(state: RunState, end: Ended): boolean {
    if (this.deps.holds === undefined || end.outcome !== "refused") return false;
    // A steer is never held (M69): it is for the turn that runs now, and a later turn is the wrong one.
    if (state.request.when === "steer") return false;
    const clean = cleanProbe(state, end);
    // A draft proven live by its probe (2026-10-25) left the box as it was: it holds like an unprobed one did.
    if (state.keys.length > 0 && !clean && !(end.reason === "draft_present" && probeOnly(state))) return false;
    if (!HOLDABLE.has(state.request.mode) || state.neverHold === true) return false;
    if (end.reason === "turn_running") return true;
    if (state.manual || state.match === null) return false;
    const leads = state.match.profile.reservedLeads;
    const command = state.command || state.request.mode === "command" || (state.request.mode === "replace" && reservedLead(sendLines(state.request.text)[0] ?? "", leads) !== null);
    if (end.reason === "draft_present") return state.request.draftHolds === true && !command;
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
    // What holds it, for the phone's sentence and a marked send's caller: the refusal it came from, or
    // what the newest request ahead of it waits on when it joins the queue behind.
    const ahead = holds.waiting(target.session, target.paneId).at(-1)?.cause;
    const cause = end.extra.detail === HELD_BEHIND ? (ahead ?? "turn_running") : holdCauseOf(end);
    const unread = end.extra.detail === TURN_VERSION_UNREAD;
    const input = { id: request.id, session: target.session, paneId: target.paneId, harness: target.harness, mode: request.mode, text: request.text, revision: request.revision ?? 0, command, waitsForTurn, cause, versionUnread: unread };
    if (request.draftHolds === true) {
      // A marked send keeps its caller's clock.
      holds.add(request.holdUntil === undefined ? { ...input, draftHolds: true } : { ...input, draftHolds: true, expiresAt: request.holdUntil });
    } else {
      holds.add(input);
    }
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
    // An open question is a wait, not a failed try: the request waits for it to close, up to its own
    // expiry. So is a draft for a marked send (M62 spec 02): its own clock bounds it.
    const draft = end.reason === "draft_present" && entry?.draftHolds === true;
    const counted = state.answerWait !== true && !draft;
    if (entry === null || (counted && entry.tries + 1 >= HOLD_TRIES)) return this.settle(state, end);
    holds.putBack(state.record.id, counted);
    if (draft) holds.setCause(state.record.id, "draft_present");
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
    if (!this.watches.has(key)) this.watches.set(key, { sawRunning: false, freeReads: 0, freeSince: null, pollSawRunning: false, missing: 0, cleared: true });
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
    watch.cleared = false;
    const record = this.deps.store.rearm(id, this.deps.generation(entry.paneId) ?? undefined);
    if (record === null) {
      holds.remove(id);
      return null;
    }
    const base: SendRequest = { id, text: entry.text, mode: entry.mode, revision: entry.revision };
    const request: SendRequest = entry.draftHolds === true ? { ...base, draftHolds: true } : base;
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
   *    it free over at least ten seconds. A hold made from a box that was not free, with no turn read
   *    and no release since, goes on the first poll that reads the pane free ({@link CLEARED_FREE_POLLS}):
   *    its cause has cleared, and its run reads S0 fresh before any key. A command whose Enter could steer a turn (`waitsForTurn`)
   *    counts the hold's own read of the turn only when its two free polls also span
   *    {@link DRAFT_LEFT_MS}: a turn that ended before the first poll ends its wait there, and a turn a
   *    poll read ends it on two free polls as before. It still never goes while a poll reads the turn,
   *    and its run reads the turn once more before any key. A release starts that wait again;
   *  - a marked request held over a draft (M62 spec 02) goes once two polls in a row read the pane free,
   *    the box empty and the pane idle (the shape of hold.ts `DESK_READS`), the second at least
   *    {@link DRAFT_LEFT_MS} after the first. A poll that reads a turn
   *    makes it a turn hold: the draft was submitted, and it goes after that turn. Each poll writes what
   *    holds a marked request now (`cause`), and the caller's `releaseCheck` has the last word.
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
      // What holds each held request now, as this poll reads it: a turn, something open at the box, or a
      // draft. A cause written at hold time goes stale (a /plan held for a turn showed `turn_running` on an
      // idle pane whose box held a returned draft, omp gang tester 14, 2026-10-25).
      const cause = surface === undefined ? null : causeOf(surface);
      if (cause !== null) for (const entry of entries) if (entry.state === "held" && entry.cause !== cause) holds.setCause(entry.id, cause);
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
      // A command whose Enter could steer a turn goes on two free polls only after a running turn a poll
      // itself read (review Q1). When only its own hold read the turn (the turn ended between two polls,
      // or the bridge restarted), the two free polls must also span DRAFT_LEFT_MS (turnEnded), so a turn
      // the screen dropped for one poll is not taken for its end. With no turn read since the last
      // release it takes the quiet rule like every other request (omp gang 2026-10-25: before this, such
      // a command never left an idle pane and held every later send for its ten minutes).
      const afterTurn = (next.waitsForTurn === true ? watch.pollSawRunning : watch.sawRunning) && watch.freeReads >= FREE_POLLS;
      const turnEnded = next.waitsForTurn === true && watch.sawRunning && watch.freeReads >= FREE_POLLS && watch.freeSince !== null && now - watch.freeSince >= DRAFT_LEFT_MS;
      const quiet = watch.freeReads >= QUIET_FREE_POLLS && watch.freeSince !== null && now - watch.freeSince >= QUIET_FREE_MS;
      // A box hold whose cause cleared: no turn read and no release since it was made.
      const cleared = watch.cleared === true && !watch.sawRunning && next.waitsForTurn !== true && next.draftHolds !== true && watch.freeReads >= CLEARED_FREE_POLLS;
      // A draft that left the box: two reads in a row of an empty box and an idle pane, at least
      // DRAFT_LEFT_MS apart, so a submitted draft has drawn its turn before anything is typed.
      // Only a marked request: another held send keeps its own release rules, whatever its label says.
      const draftLeft = next.draftHolds === true && holds.get(next.id)?.cause === "draft_present" && watch.freeReads >= FREE_POLLS && watch.freeSince !== null && now - watch.freeSince >= DRAFT_LEFT_MS;
      if (busy || !(afterTurn || turnEnded || quiet || draftLeft || cleared)) continue;
      if (this.deps.releaseCheck?.(next.id, session, paneId) === false) {
        this.endHeld(next, "refused", "pane_gone");
        continue;
      }
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
    // Discard on an unconfirmed queued card (ADR 0122): the card goes, and nothing is pressed.
    if (this.queuedSends.dismissUnconfirmed(session, paneId, id)) return { result: "dismissed" };
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
      // A held request's release is bounded from its start, not from the accept (M56 spec 15). A steer
      // also gets the pause its profile names before the steer key (M69).
      deadline: (record.runAt ?? record.acceptedAt) + LOCK_BOUND_MS + (request.when === "steer" ? (match?.profile.keys.steerDelayMs ?? 0) : 0),
      marks: { s0: null, s1: null, s2: null },
      gaps: {},
      keys: [],
      probed: false,
      manual: false,
      blind: false,
      starting: false,
      startingNamed: false,
      command: request.mode === "command",
      whole: null,
      noticeKey: false,
      heldOther: false,
      tailOnly: false,
      queued: false,
      streamed: false,
      belowMoved: false,
      witnessed: false,
      runsInTurn: false,
      previousRead: null,
      lastRead: null,
      stepStart: at,
      phase: "s0",
      steer: false,
      steered: false,
      reread: false,
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
    // Whatever the end, a box that showed only the end of the text was compared by those rows alone.
    if (state.tailOnly && receipt.detail === undefined) receipt.detail = TAIL_ONLY;
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
    const own = await this.deps.profile(target.harness);
    // A pane where a harness is starting is that harness's pane in waiting: its shell is not the place
    // for the text, and its input box is not there yet (the launch window).
    const starting = await this.startingOf(target, own);
    const expected = own !== null || starting === null ? null : await this.deps.profile(starting);
    const match = own ?? expected;
    const state: RunState = {
      ...this.bareState(request, record, target, match),
      released: release,
      starting: own === null ? expected !== null : starting !== null,
      startingNamed: own !== null && starting !== null,
    };
    // The bound starts once the profile is known (#594): the profile waits for the binary's version,
    // and a slow or hanging `--version` used to spend the whole bound before S0, so every send ended
    // `unknown(bound)` with nothing read and nothing typed. The wait is measured as `profile`, never counted.
    const waited = this.now() - (record.runAt ?? record.acceptedAt);
    if (waited > 0) {
      state.gaps.profile = waited;
      state.deadline += waited;
    }
    const { locks } = this.deps;
    if (!locks.acquire(state.lockKey, record.id, state.deadline, this.now())) {
      const busy = new Ended("refused", "busy", { detail: "Another send on this pane is still running." });
      return release ? this.backToQueue(state, busy) : this.settle(state, busy);
    }
    try {
      await this.steps(state);
      const note: EndNote = { framed: true };
      if (state.heldOther && record.mode === "submit") note.detail = HELD_OTHER;
      else if (state.tailOnly) note.detail = TAIL_ONLY;
      if (state.noticeKey) note.cause = NOTICE_KEY;
      const answer = this.settle(state, new Ended(record.mode === "discard" ? "discarded" : state.steered ? "steered" : "sent", undefined, note));
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

  /** The harness starting in the pane ({@link SendDeps.starting}), or null. A throw reads as null. */
  private async startingOf(target: SendTarget, own: ProfileMatch | null): Promise<string | null> {
    if (this.deps.starting === undefined) return null;
    try {
      const harness = await this.deps.starting(target.paneId, own === null ? null : target.harness);
      return harness === null || harness === "" ? null : harness;
    } catch (err) {
      console.warn(`[send] the starting read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Tell {@link SendDeps.framed} the starting harness's box is on screen. Never throws, and never changes the answer. */
  private noteFramed(state: RunState): void {
    const harness = state.startingNamed ? state.target.harness : state.match?.profile.id;
    if (harness === undefined) return;
    try {
      this.deps.framed?.(state.target.paneId, harness);
    } catch (err) {
      console.warn(`[send] the framed note failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Tell {@link SendDeps.deaf} the starting harness's box showed no probe. True when the pane is
   * starting: this run's window, or one the dependency keeps or opens again. Never throws.
   */
  private noteDeaf(state: RunState): boolean {
    const harness = state.startingNamed || !state.starting ? state.target.harness : state.match?.profile.id;
    if (harness === undefined || harness === "" || this.deps.deaf === undefined) return state.starting;
    try {
      return this.deps.deaf(state.target.paneId, harness) > 0 || state.starting;
    } catch (err) {
      console.warn(`[send] the deaf note failed: ${err instanceof Error ? err.message : String(err)}`);
      return state.starting;
    }
  }

  /**
   * How many of Collie's own probe characters an idle box holds when they are its whole text
   * (probe-marker.ts), else 0. Only a request that would act on the box counts them: a send, a
   * command, Add to it, Replace and Discard. A box with any other text in it is never counted.
   */
  private residueOf(state: RunState, s0: Snap): number {
    const { frame, surface } = s0;
    if (frame === null || frame.scrolled === true || state.manual || s0.notice !== null) return 0;
    if (surface.turn !== "idle" || surface.modal !== "none" || surface.composer !== "draft") return 0;
    const { mode } = state.request;
    if (mode !== "send" && mode !== "command" && mode !== "append" && mode !== "replace" && mode !== "discard") return 0;
    return probeResidue(boxText(frame), probeCharOf(state.match));
  }

  /**
   * Takes Collie's own probe characters out of a box the draft probe just proved: one Backspace each,
   * then reads until the box reads empty. The read is where the request goes on from; a box that does
   * not empty ends `probe_failed`, saying what may remain, and no other key follows.
   */
  private async removeResidue(state: RunState, markers: number): Promise<Snap> {
    const probe = probeCharOf(state.match);
    const left = (snap: Snap | null): Ended => new Ended("refused", "probe_failed", sawNote(snap, { detail: residueLeft(probe), framed: true, offers: ["keys"] }));
    this.stretch(state, BOUNDS.probe.ms);
    try {
      await this.keysThroughGate(state, Array.from({ length: markers }, () => "Backspace"), "refused");
    } catch (err) {
      if (err instanceof Ended && err.outcome === "refused") throw left(state.lastRead);
      throw err;
    }
    const back = await this.poll(state, "probe", { reads: BOUNDS.probe.reads, ms: BOUNDS.probe.ms }, (snap) =>
      snap.frame !== null && snap.surface.modal === "none" && boxText(snap.frame) === "" ? "pass" : "wait",
    );
    if (back.verdict !== "pass" || back.snap === null) throw left(back.snap);
    return back.snap;
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
    // A send the harness holds for after the turn: a card until the journal or the box closes it (ADR 0122).
    // A steer is kept too, with no card of its own: a Stop may give it back together with the queue.
    if ((receipt.outcome === "sent" && receipt.queued === true) || receipt.outcome === "steered") {
      this.queuedSends.add({
        id: state.record.id,
        session: state.target.session,
        paneId: state.target.paneId,
        generation: state.record.paneGeneration,
        text: state.request.text,
        collapse: state.match?.profile.collapse.pattern ?? null,
        at: this.now(),
        steer: receipt.outcome === "steered",
      });
    }
    this.count(state, receipt, end.extra.surface);
    const framed = end.extra.framed ?? (state.marks.s0?.frame ?? null) !== null;
    return answerWith({ receipt, offers: end.extra.offers ?? offersOf(outcome, receipt.reason, framed, end.extra.surface) }, end.extra);
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
    // A steer (M69): who asked, and whether it is a message to a pane that can be steered at all.
    // Nothing is read or typed for these refusals.
    if (request.when === "steer") {
      if (request.fromPhone !== true) throw new Ended("refused", "steer_not_allowed", { detail: STEER_NOT_ALLOWED });
      if (request.mode !== "send") throw new Ended("refused", "steer_unsupported", { detail: STEER_MESSAGE_ONLY });
      // No profile, no steer key, or a version Collie may not trust with a turn: the same answer on an
      // idle and a running turn, before any read, so a pane that cannot steer always says so.
      if (!steerTrusted(match)) throw new Ended("refused", "steer_unsupported", { detail: STEER_UNSUPPORTED });
    }
    // Submit and Discard name the text the box holds: a command's text may stand there with its lead read as a mode marker.
    // A Replace whose text starts with a reserved lead empties the box and then sends a command, so it is one from here on.
    if ((request.mode === "submit" || request.mode === "discard" || request.mode === "replace") && reservedLead(lines[0] ?? "", leads) !== null) state.command = true;
    // A draft that went as one paste is read the way the send read it.
    if ((request.mode === "submit" || request.mode === "discard") && !state.command && this.deps.mux.pasteBlock !== undefined) {
      state.whole = wholePaste(match, lines, this.deps.imageFile);
    }
    const { whole } = state;
    // On a box at its scroll height the text Collie typed is compared by the rows in view (boxHolds).
    const holds = (frame: Frame): boolean => {
      if (state.command) return commandBoxMatches(boxText(frame), "", lines, collapseOf(match));
      const held = boxHolds(frame, "", whole?.lines ?? lines, collapseOf(match), whole);
      state.tailOnly = held === "tail";
      return held !== null;
    };

    if (match === null && (request.mode === "send" || request.mode === "command")) {
      await this.blindSend(state, lines);
      return;
    }

    this.begin(state);
    let s0 = await this.settledS0(state);
    state.marks.s0 = s0;
    // The launch window: a harness is starting in the pane, and its box is not on screen yet. No probe
    // either, for the probe would be typed into the shell. A dialog the pane's own profile lifts is the
    // harness up and asking: it keeps its own path. A box on screen is not yet a box that reads keys
    // (omp draws its box long before it reads one): the window ends once the probe shows in it.
    if (state.starting && s0.frame === null && (!state.startingNamed || askOf(s0.surface.modal) === null)) {
      throw new Ended("refused", "probe_failed", { surface: s0.surface, framed: false, detail: notStartedDetail(match) });
    }
    this.atS0(state, s0);
    // A box whose whole text is Collie's own probe characters (a box that was drawn before it read keys
    // kept them, probe-marker.ts) is proven like a draft, then emptied of exactly them.
    const residue = this.residueOf(state, s0) > 0;
    // A draft read is a reading until a probe proves it (the header, 2026-10-25). A stale frame gets one
    // more S0 read, and the run goes on from it or ends refused.
    if (residue || this.draftToProve(state, s0, holds)) {
      const started = this.now();
      let proven: Snap;
      try {
        proven = await this.proveDraft(state, s0);
      } finally {
        // The proof is its own gap, on a refusal too: S0's gap stays the time of its two reads.
        const spent = this.now() - started;
        state.gaps.proof = spent;
        state.stepStart += spent;
      }
      if (proven !== s0) {
        s0 = proven;
        state.marks.s0 = s0;
        this.atS0(state, s0);
      }
    }
    const markers = this.residueOf(state, s0);
    if (markers > 0) {
      s0 = await this.removeResidue(state, markers);
      state.marks.s0 = s0;
      this.atS0(state, s0);
      // A Discard is for what Collie typed: the box held only Collie's probe characters, and they are out.
      if (request.mode === "discard") return;
    }

    switch (request.mode) {
      case "submit": {
        // A returned card's Send goes only on an idle turn: a busy one means the text may be on its way.
        if (request.returnedCard === true && s0.surface.turn !== "idle") throw new Ended("refused", "not_free", { surface: s0.surface, detail: RETURNED_BUSY });
        const located = this.typedBox(state, s0, holds, lines);
        // A popup first, as at the end of the typing: the command key is Enter, and Enter acts on the popup. A popup is no command list.
        if (state.command && s0.popup !== null) {
          throw new Ended("refused", "not_free", { surface: s0.surface, framed: true, rowsHash: s0.rowsHash, detail: POPUP_AT_ENTER });
        }
        // Enter on a command whose list points at another one runs that one: the person picks it with the keys or discards the text.
        if (state.command && listPointsElsewhere(s0, "", lines, collapseOf(match), match?.profile.idle.volatile.below.commandList)) {
          throw new Ended("refused", "not_free", { surface: s0.surface, framed: true, rowsHash: s0.rowsHash, detail: SUBMIT_ELSEWHERE });
        }
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
        if (s0.frame === null && located === null) throw new Ended("refused", "not_free", { surface: s0.surface, detail: BOX_CHANGED });
        this.lap(state, "s0");
        // The length of the text Collie typed sizes the clear of a box that hides its head; a box that
        // held another text has no length Collie knows.
        if (located === null) await this.clear(state, s0, state.heldOther ? null : [...lines.join("\n")].length);
        else await this.clearBare(state, located);
        this.lap(state, "clear");
        return;
      }
      case "replace": {
        const frame = this.draftFrame(state, s0);
        // The box would end up holding one of the notice's keys alone, which answers the notice.
        if (this.answersNotice(state, s0)) throw noticeRefusal(s0);
        // S0 ends with its two reads; emptying the box is its own step with its own bound.
        this.lap(state, "s0");
        if (boxText(frame).length > 0) {
          // The draft is the person's (or one a refusal left there): Collie knows only what the box shows.
          s0 = await this.clear(state, s0, null);
          state.marks.s0 = s0;
          this.lap(state, "clear");
        }
        break;
      }
      case "append": {
        const frame = this.draftFrame(state, s0);
        // Add to it on a box the person emptied since the phone saw its draft: the key would stand
        // alone in the box, and the notice would take it.
        if (boxText(frame).trim().length === 0 && this.answersNotice(state, s0)) throw noticeRefusal(s0);
        break;
      }
      case "send":
      case "command":
        this.gateSend(state, s0);
        if (request.when === "steer") this.gateSteer(state, s0);
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
      // After a second S0 read of a stale box the box is proven by the probe again, whatever the profile says.
      // So is a box of a harness that is starting: it may be drawn and still read no keys.
      (state.reread ||
      state.starting ||
      state.queued ||
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
    // The probe showed in the box and went again: the starting harness reads keys, its window ends.
    if (state.starting && state.probed) this.noteFramed(state);

    if (!state.command && !state.noticeKey && this.deps.mux.pasteBlock !== undefined) state.whole = wholePaste(match, lines, this.deps.imageFile);
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
    // A steer waits the profile's own pause before the steer key too (Codex reads a quick Enter as part
    // of a paste, M69); the longer of the two pauses, once.
    const steerDelayMs = state.steer ? (state.match?.profile.keys.steerDelayMs ?? 0) : 0;
    const pauseMs = Math.max(settleMs ?? 0, steerDelayMs);
    if (pauseMs > 0) await this.sleep(pauseMs);

    const s1 = await this.awaitTyped(state, s0, landing, prefix, state.whole?.lines ?? lines);
    state.marks.s1 = s1;
    this.lap(state, "s1");
    this.checkGeneration(state, "typed_not_submitted");

    // A steer whose turn ended while the text went in goes as the plain send S0's read put it on: a
    // steer is never held, and the keys of the queued path are what a plain send presses there.
    if (state.steer && s1.surface.turn !== "running") state.steer = false;
    await this.commit(state, s1);
    this.lap(state, "commit");
    if (state.steer) {
      await this.awaitSteered(state, s1, lines);
      this.lap(state, "s2");
      return;
    }
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
    state.phase = "commit";
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

  /** What every S0 read is held to before the mode's own rule: a held request's answer box, the manual Send's turn rule, the pane's generation. */
  private atS0(state: RunState, s0: Snap): void {
    // A held request is a message for the agent, in every mode a release runs (a send, a command, a
    // Replace): a box that answers the agent's question would take it as the answer. It waits.
    if (state.released === true && answersQuestion(state.match, s0)) {
      state.answerWait = true;
      throw new Ended("refused", "not_free", { surface: s0.surface, detail: ANSWER_BOX });
    }
    state.manual = takesManualSend(s0.surface);
    if (state.manual) this.gateSteeringTurn(state, s0);
    this.checkGeneration(state, "refused");
  }

  /**
   * Whether this request would act on the draft S0 reads in an idle box (the header, 2026-10-25): a send
   * or command it would refuse `draft_present`, an Add to it, a Replace, a Discard of a box that holds
   * the text, and a returned card's Submit. A notice over the box keeps its own refusal, which presses
   * nothing; a running turn keeps its rules.
   */
  private draftToProve(state: RunState, s0: Snap, holds: (frame: Frame) => boolean): boolean {
    const { frame, surface } = s0;
    if (state.reread || state.manual || frame === null || s0.notice !== null) return false;
    // A box at its scroll height shows a slice of its draft, so a probe there cannot be compared; its
    // own rules refuse or bound the clear before any key (TALL_DRAFT, LONG_DRAFT).
    if (frame.scrolled === true) return false;
    // A marked send (walky talky) is held over a draft, never refused, and nobody tapped it: a person may
    // be typing in that box right now, and a probe there could land between their keys. It waits as before.
    if (state.request.draftHolds === true) return false;
    if (surface.turn !== "idle" || surface.modal !== "none" || surface.composer !== "draft" || boxText(frame).length === 0) return false;
    switch (state.request.mode) {
      case "send":
      case "command":
      case "append":
      case "replace":
        return true;
      case "discard":
        return holds(frame);
      case "submit":
        return state.request.returnedCard === true && holds(frame);
      default:
        return false;
    }
  }

  /**
   * The draft's probe (the header): the read after the probe and its Backspace when the probe landed in
   * its box (the gate's revision moved, so the run goes on from that read), or the second S0 read from
   * which the request goes on. A frame that stays stale ends `probe_failed` with the cause
   * `stale_screen`. The request's bound grows by each step it adds.
   */
  private async proveDraft(state: RunState, s0: Snap): Promise<Snap> {
    const probe = probeCharOf(state.match);
    const before = countIn(s0.texts, probe);
    // The probe, then its Backspace, each with the probe's own bound.
    this.stretch(state, 2 * BOUNDS.probe.ms);
    const first = await this.draftProbe(state, s0, probe);
    if (first.landing === "live") return first.snap;
    state.reread = true;
    // The second S0 read, a second probe, and the send's own probe that the second read forces.
    this.stretch(state, REREAD_GAP_MS + BOUNDS.s0.ms + 3 * BOUNDS.probe.ms);
    this.guard(state);
    await this.sleep(REREAD_GAP_MS);
    let fresh = await this.stableRead(state, "s0");
    // A probe that showed nowhere may show now that the screen drew again: it is taken back first.
    if (first.landing === "nowhere") {
      if (countIn(fresh.texts, probe) !== before + 1) throw this.staleScreen(state, fresh, probe);
      fresh = await this.takeBack(state, before, probe);
    }
    const { frame } = fresh;
    if (frame === null || fresh.surface.composer !== "draft" || boxText(frame).length === 0) return fresh;
    // The same rows again: nothing mended the screen, and a second probe would only say so twice.
    if (s0.frame !== null && frameImageKey(fresh.texts, frame.top, frame.bottom) === frameImageKey(s0.texts, s0.frame.top, s0.frame.bottom)) {
      throw this.staleScreen(state, fresh, null);
    }
    const again = await this.draftProbe(state, fresh, probe);
    if (again.landing === "live") return again.snap;
    throw this.staleScreen(state, state.lastRead ?? fresh, again.landing === "nowhere" ? probe : null);
  }

  /**
   * One probe of a box that reads a draft: the read that shows the box as it was, when the character
   * landed in the box after the draft and one Backspace gave the box back; `away` when it stood elsewhere on the screen and one Backspace
   * took it back; `nowhere` when no read showed it (no key follows). A probe that changed the box some
   * other way, or opened something, fails as the send's own probe does.
   */
  private async draftProbe(state: RunState, s0: Snap, probe: string): Promise<{ readonly landing: "live"; readonly snap: Snap } | { readonly landing: "away" | "nowhere" }> {
    const frame = s0.frame!;
    const draft = boxText(frame);
    const before = countIn(s0.texts, probe);
    const failed = (detail: string, snap: Snap | null): Ended => new Ended("refused", "probe_failed", sawNote(snap, { detail, framed: true }));
    await this.writeText(state, probe, false);
    state.keys.push("probe");
    let away = false;
    const typed = await this.poll(state, "probe", { reads: BOUNDS.probe.reads - 1, ms: BOUNDS.probe.ms }, (snap) => {
      if (snap.frame === null) return "wait";
      if (probeBoxPasses(s0, snap, draft, probe)) return "pass";
      if (boxText(snap.frame) !== draft || modalAtBox(snap) || cueAppeared(s0, snap)) return "fail";
      if (countIn(snap.texts, probe) !== before + 1) return "wait";
      away = true;
      return "fail";
    });
    if (typed.verdict === "wait") return { landing: "nowhere" };
    if (typed.verdict === "fail" && away) {
      await this.takeBack(state, before, probe);
      return { landing: "away" };
    }
    if (typed.verdict === "fail") throw await this.probeCleanup(state, s0, typed.snap, probe, "The probe character changed more than the box.");
    try {
      await this.keysThroughGate(state, ["Backspace"], "refused");
    } catch (err) {
      if (err instanceof Ended && err.outcome === "refused") throw failed(`Backspace after the probe was refused: ${err.extra.detail ?? err.message}`, typed.snap);
      throw err;
    }
    const back = await this.poll(state, "probe", { reads: BOUNDS.probe.reads, ms: BOUNDS.probe.ms }, (snap) => (snap.frame !== null && boxText(snap.frame) === draft ? "pass" : "wait"));
    if (back.verdict !== "pass" || back.snap === null) throw failed("Backspace did not give the box back as it was.", back.snap);
    return { landing: "live", snap: back.snap };
  }

  /**
   * One Backspace for a probe character that stands outside the box (the live editor of a stale
   * screen), then reads until the screen holds as many of it as S0 did. The read is the answer; a
   * character that stays ends `probe_failed`, saying it may remain.
   */
  private async takeBack(state: RunState, before: number, probe: string): Promise<Snap> {
    const left = (snap: Snap | null): Ended =>
      new Ended("refused", "probe_failed", sawNote(snap, { detail: `${STALE_SCREEN} ${probeMayRemain(probe)}`, framed: true, offers: ["keys"], cause: STALE_CAUSE }));
    try {
      await this.keysThroughGate(state, ["Backspace"], "refused");
    } catch (err) {
      if (err instanceof Ended && err.outcome === "refused") throw left(state.lastRead);
      throw err;
    }
    const back = await this.poll(state, "probe", { reads: BOUNDS.probe.reads, ms: BOUNDS.probe.ms }, (snap) => (countIn(snap.texts, probe) === before ? "pass" : "wait"));
    if (back.verdict !== "pass" || back.snap === null) throw left(back.snap);
    return back.snap;
  }

  /**
   * The refusal of a box that does not take keys (the header): `probe_failed`, the cause `stale_screen`,
   * the key pad as the offer, nothing deleted. `probe` names a probe character that showed nowhere and
   * may still stand in the live editor. The bridge's Surface is told which box rows were proven stale.
   */
  private staleScreen(state: RunState, snap: Snap, probe: string | null): Ended {
    const { frame } = snap;
    if (frame !== null) {
      try {
        this.deps.staleFrame?.(state.target.paneId, frameImageKey(snap.texts, frame.top, frame.bottom));
      } catch (err) {
        console.warn(`[send] stale frame note failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const detail = probe === null ? STALE_SCREEN : `${STALE_SCREEN} ${probeMayRemain(probe)}`;
    return new Ended("refused", "probe_failed", sawNote(snap, { detail, framed: true, offers: ["keys"], cause: STALE_CAUSE }));
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
      // On an empty box a key the notice above it printed answers the notice: the manual Send. Only a
      // whole-text key is typed as the answer, with no Enter. A longer send whose first line is a key
      // takes the ordinary typed path once confirmed: if the notice took that line, S1 does not find
      // the whole text in the box, and no Enter follows.
      const answer = this.noticeAnswer(state, s0);
      if (answer !== null) {
        state.manual = true;
        this.gateSteeringTurn(state, s0);
        this.gateManual(state, s0, NOTICE_KEY_DETAIL, NOTICE_KEY);
        state.noticeKey = answer === "whole";
      }
      return;
    }
    if (surface.turn === "running" && surface.modal === "none" && s0.frame !== null && (surface.composer === "empty" || surface.composer === "draft")) {
      this.gateTurn(state, s0, s0.frame);
      if (surface.composer === "draft") {
        state.queued = false;
        throw draftRefusal(state, s0);
      }
      // In a turn the key would answer the notice before the harness queues it, so no commit is offered.
      if (this.answersNotice(state, s0)) {
        state.queued = false;
        throw noticeRefusal(s0);
      }
      return;
    }
    if (surface.turn === "idle" && surface.modal === "none" && surface.composer === "draft") {
      throw draftRefusal(state, s0);
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
   * Whether S0 shows a notice the profile names over the found box (`idle.notices`) and the send would
   * leave one of the keys it printed alone in the box: its whole text, trimmed, is that key, or its
   * first line is. The lines are written one at a time, so the first line stands alone in the box until
   * the newline key follows it, long enough for the notice to take it. A letter matches in either case
   * (Claude Code lowercases the box before it matches a lettered key). The harness reads such a box as
   * the answer to the notice, so the send takes the manual Send even on a free screen.
   */
  private answersNotice(state: RunState, s0: Snap): boolean {
    return this.noticeAnswer(state, s0) !== null;
  }

  /** How a send answers the notice S0 shows: `whole` text, `first` line only, or null for neither. */
  private noticeAnswer(state: RunState, s0: Snap): "whole" | "first" | null {
    if (s0.notice === null) return null;
    const keys = new Set(s0.notice.keys.map((key) => key.key.toLowerCase()));
    if (keys.has(state.request.text.trim().toLowerCase())) return "whole";
    const first = sendLines(state.request.text)[0] ?? "";
    return keys.has(first.trim().toLowerCase()) ? "first" : null;
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
  private typedBox(state: RunState, s0: Snap, holds: (frame: Frame) => boolean, lines: readonly string[]): Located | null {
    const { surface, frame } = s0;
    if (frame !== null) {
      if (holds(this.draftFrame(state, s0))) return null;
      state.heldOther = true;
    }
    if (frame === null && !takesManualSend(surface) && !isFree(surface)) throw new Ended("refused", "not_free", { surface, detail: "The input box is not free." });
    const hash = state.request.rowsHash;
    if (hash === undefined) throw new Ended("refused", "not_free", { surface, detail: BOX_CHANGED });
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

  /**
   * The steer's rule at S0, after the send's own gate let it through (M69; the profile's trust was
   * checked before S0): on a turn S0 read running over a found box (the queued path) the send steers;
   * anywhere else (an idle turn, the manual path) it goes as the plain send it is.
   */
  private gateSteer(state: RunState, s0: Snap): void {
    state.steer = state.queued && !state.manual && !state.runsInTurn && !state.noticeKey && s0.surface.turn === "running" && s0.frame !== null;
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
    if (now > state.deadline) throw new Ended("unknown", "bound", { detail: boundDetail(state, now) });
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
    state.phase = step;
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
    const ownList = ownCommandList(texts, frame, idle, rows);
    // The transcript's echo of a sent prompt above the box (`idle.promptEchoes`) is no pointed list either:
    // a long prompt wraps into rows aligned under its glyph (withoutPromptEchoes).
    // The box's typeahead popup (`volatile.below.popups`) is no dialog either: the profile's submit key ignores it.
    const popup = popupAt(texts, frame, idle);
    const bare = withoutPopup(withoutPromptEchoes(withoutNamedRows(withoutCommandList(rows, ownList), frame), frame, idle), popup);
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
      below: countBelow(
        texts,
        frame,
        (idle?.volatile.below.hints ?? []).map((source) => new RegExp(source, "u")),
        frame === null ? null : staleListUnder(texts, frame.bottom, frame.interior.text, idle?.volatile.below.commandList),
        popup,
      ),
      otherScreen: otherScreenOf(texts, frame, idle?.volatile.below.otherScreens ?? []),
      popup,
      commandList: frame === null ? null : commandListAt(texts, frame, idle?.volatile.below.commandList, rows),
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
    // count, a statusline) move on their own while a turn runs. A box that holds no draft compares
    // by its two edges alone: its placeholder may appear, go or change between the reads (Claude
    // Code's "Press up to edit queued messages" going as the queue is taken, a prompt suggestion
    // painted in the placeholder's own colour) without the box having moved. With no frame the
    // bottom window is compared with its running rows masked, for the same reason.
    const key = (snap: Snap): string => {
      if (snap.frame !== null && boxText(snap.frame) === "") return `${snap.plain[snap.frame.top] ?? ""}\n${snap.plain[snap.frame.bottom] ?? ""}`;
      if (snap.frame !== null) return snap.plain.slice(snap.frame.top, snap.frame.bottom + 1).join("\n");
      const win = bottomWindow(snap.plain);
      return snap.plain.slice(win.first, win.end).join("\n");
    };
    if ((first.frame === null) !== (second.frame === null) || key(first) !== key(second)) {
      const moved = new Ended("refused", "not_free", { surface: second.surface, detail: "The input box moved between two reads." });
      if (inFlux(first, second)) moved.extra.inFlux = true;
      throw moved;
    }
    return second;
  }

  /**
   * S0 with one more read when the screen's geometry is in flux (2026-10-26, omp gang three 02-desync):
   * the two reads differ in grid size (a resize landed between them), or the read is torn (cut inside the
   * box). Such a read is a frame on its way, not a box that is not free, so it is no reason yet to hold
   * the send or refuse it `not_free`. After {@link SETTLE_MS} S0 reads again, once, and that read is
   * judged by every rule as before. It runs before any key; the read in flux and the pause are
   * `gapsMs.settle`, so `s0` stays the time of the reads that were judged.
   */
  private async settledS0(state: RunState): Promise<Snap> {
    try {
      const s0 = await this.stableRead(state, "s0");
      if (s0.surface.reason !== "torn" || state.keys.length > 0) return s0;
    } catch (err) {
      if (!(err instanceof Ended) || err.extra.inFlux !== true || state.keys.length > 0) throw err;
    }
    this.stretch(state, SETTLE_MS + BOUNDS.s0.ms);
    this.guard(state);
    await this.sleep(SETTLE_MS);
    this.lap(state, "settle");
    return this.stableRead(state, "s0");
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
      // A step whose end is the request's bound, woken a hair past it (a timer fires late), ends as its
      // own bound would: its outcome (`no_evidence`, `typed_not_submitted`) says more than `bound` (#594).
      if (this.now() > state.deadline) break;
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
    const probe = probeCharOf(state.match);
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
    // A box on screen that showed no probe at all, on a pane where its harness is starting: the box is
    // drawn but reads no keys yet. The character waits in the terminal and shows later, where the next
    // send takes it out (residueOf). No Backspace now: it would wait too, and land in what comes next.
    if (typed.verdict === "wait" && s0.frame !== null && (typed.snap === null || countIn(typed.snap.texts, probe) === countIn(s0.texts, probe)) && this.noteDeaf(state)) {
      throw new Ended("refused", "probe_failed", sawNote(typed.snap, { detail: deafDetail(state.match, probe), framed: true }));
    }
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
      // The probe went in and out again, and the box still holds text Collie did not type: a real
      // draft, which a probe has just proven (2026-10-26, omp gang three 02-desync h 21 and 23: a stale
      // row painted over the live box row while the live editor held a draft). It is refused with the
      // draft's offers, never held: a hold would type its text later, after the person's next choice.
      // Another screen's own box (the agents screen) is not the conversation's: its text is no draft there.
      if (probeOnly(state) && look.frame !== null && look.otherScreen === null && look.surface.modal === "none" && look.surface.composer === "draft") return draftRefusal(state, look);
      const clean = failed(PROBE_REMOVED, look);
      clean.extra.probeClean = true;
      return clean;
    }
    return failed(probeMayRemain(probe), look ?? snap);
  }

  /**
   * The write: each line in one write, the profile's newline key between lines. A text that goes as
   * ONE paste (`state.whole`, {@link wholePaste}) is one `pasteBlock` instead. A long dictation typed
   * line by line grows the box past the screen, and a box whose top is off screen can never be proven,
   * so the send ended `typed_not_submitted` and Submit and Discard could not find the box either. One
   * paste is what the harness folds into its collapse form (`[Pasted text #N +M lines]`), one row,
   * which S1 matches (boxMatches); a short one lands literally.
   */
  private async write(state: RunState, lines: readonly string[]): Promise<void> {
    state.phase = "write";
    const { mux } = this.deps;
    if (state.whole !== null && mux.pasteBlock !== undefined) {
      this.guard(state);
      // Called on the mux, never torn off it: an adapter's method reads its own `this`.
      const ack = await this.within(state, mux.pasteBlock(state.target.paneId, lines.join("\n")));
      this.deps.gate.noteWrite(state.target.paneId);
      if (!ack.ok) throw new Ended("refused", "write_failed", { detail: ack.detail });
      return;
    }
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
    // The last read showed a command typed and a typeahead popup open under the box.
    let popupOpen = false;
    let earlier: Snap | null = null;
    // A message into a framed box on a harness that takes one in a turn: only the box and what is under
    // it decide (2026-10-17 decision). Where Enter would steer or interrupt a turn and no queue key
    // exists, rows above that moved may be a turn Collie did not see, so the full compare stays.
    const boxOnly = s0.frame !== null && !command && !manual && queuesInTurn(state.match);
    const result = await this.poll(state, "s1", BOUNDS.s1, (snap) => {
      if (belowMovedAlone(earlier, snap)) state.belowMoved = true;
      earlier = snap;
      if (boxOnly) {
        const verdict = typedBoxVerdict(s0, snap, prefix, lines, collapse, state.whole);
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
        state.tailOnly = snap.frame !== null && boxHolds(snap.frame, prefix, lines, collapse, state.whole) === "tail";
        return "pass";
      }
      // A command commits with the command key, and Enter acts on an open popup (the profile's `submitIgnores`
      // is its submit key's only). The popup's rows are no cue, so this is where the refusal stands. It comes
      // first: a popup is no command list, and rows that read as both are the popup (the receipt says so).
      popupOpen = command && snap.popup !== null;
      if (popupOpen) {
        elsewhere = false;
        why = "modal_cue";
        return "wait";
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
        const held = command ? (commandBoxMatches(boxText(snap.frame), prefix, lines, collapse) ? "all" : null) : boxHolds(snap.frame, prefix, lines, collapse, state.whole);
        if (held === null) {
          why = "mismatch";
          return "wait";
        }
        state.tailOnly = held === "tail";
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
    // A steer names what stood in the way of its key (counsel on the Edge 5 candidate): a dialog, or
    // a box it could not find or a modal it could not tell. The text that is no longer in the box
    // keeps its own word (`mismatch`), and so does a box that is there under no modal.
    if (state.steer && endedOn() !== "mismatch") why = steerBlocked(result.snap, endedOn());
    state.marks.s1 = result.snap;
    // The rows hash binds a later Submit or Discard to the screen this answer saw.
    const note: EndNote = { framed: s0.frame !== null };
    if (result.snap !== null) note.rowsHash = result.snap.rowsHash;
    const screen: string | null = otherScreen; // set inside the poll's callback
    if (screen !== null) note.detail = otherScreenDetail(screen);
    const pointedElsewhere: boolean = elsewhere; // set inside the poll's callback
    if (pointedElsewhere) note.detail = LIST_ELSEWHERE;
    const popupAtEnter: boolean = popupOpen; // set inside the poll's callback
    if (popupAtEnter) note.detail = POPUP_AT_ENTER;
    const last = result.snap;
    if (note.detail === undefined && why === "modal_cue" && last !== null && last.frame !== null && cuesInsideFrame(last, last.frame) && boxHolds(last.frame, prefix, lines, collapse, state.whole) !== null) note.detail = BOX_UNREADABLE_DRAFT;
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
    state.phase = "commit";
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
    const test = (snap: Snap): Verdict => {
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
    };
    let result = await this.poll(state, "s2", BOUNDS.s2, test);
    // A command's own screen (a picker, a panel) may be slow to draw: a machine under load took more
    // than S2's whole bound to open one, and the box stood unchanged until it did. That screen is the
    // evidence, so a command that found nothing gets one more S2 bound with the same test (still cut
    // by the request's deadline). Only a command waits: a send that left its text in the box has no
    // screen to wait for. A box that never changes still ends `no_evidence`.
    if (command && result.verdict === "wait") result = await this.poll(state, "s2", BOUNDS.s2, test);
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
   * After the steer key (M69): reads at {@link STEER_READS_MS} after it, each asked in order: a dialog
   * at the box (or two reads with no box) ends `unknown(dialog_after_enter)`; the profile's queued row
   * with the text, new since S1, says the harness queued it (the receipt says `sent`, `queued`); one of
   * the profile's steer witnesses says `steered` (a transcript or marker witness only on a read whose
   * box let the text go, see {@link steerWitnessed}). With neither after the last read, the text still in
   * the box is `typed_not_submitted`, anything else `unknown(no_evidence)`.
   */
  private async awaitSteered(state: RunState, s1: Snap, lines: readonly string[]): Promise<void> {
    const keys = state.match?.profile.keys;
    const witnesses = keys?.steerWitness ?? [];
    // The text as the person wrote it, and as the box held it (a long paste may stand as its chip).
    const boxed = s1.frame === null ? "" : boxText(s1.frame);
    const texts = [...new Set([lines.join(""), boxed].filter((text) => wsFree(text).length > 0))];
    const queuedIn = (snap: Snap): boolean => texts.some((text) => showsQueued(snap, keys?.queuedRow, text));
    const queuedBefore = queuedIn(s1);
    const keyAt = this.now();
    let last: Snap | null = null;
    let frameless = 0;
    for (const after of STEER_READS_MS) {
      if (keyAt + after > state.deadline) break;
      const wait = keyAt + after - this.now();
      if (wait > 0) await this.sleep(wait);
      let snap: Snap | null;
      try {
        snap = await this.read(state, "s2");
      } catch (err) {
        if (err instanceof StepLate) break;
        throw err;
      }
      if (snap === null) continue;
      last = snap;
      state.marks.s2 = snap;
      frameless = snap.frame === null ? frameless + 1 : 0;
      if (frameless >= FRAMELESS_READS || modalAtBox(snap)) throw new Ended("unknown", "dialog_after_enter", sawNote(snap, { offers: ["keys"], detail: DIALOG_AFTER_ENTER }));
      const queuedNow = queuedIn(snap);
      if (queuedNow && !queuedBefore) {
        state.witnessed = true;
        state.queued = true;
        return;
      }
      // The box let the text go: found, and it reads empty or holds other text than the one typed.
      const frame = snap.frame;
      const letGo = frame !== null && !texts.some((text) => wsFree(boxText(frame)) === wsFree(text));
      if (texts.some((text) => witnesses.some((witness) => steerWitnessed(s1, snap, witness, text, queuedNow, letGo)))) {
        state.steered = true;
        return;
      }
    }
    const lastFrame = last?.frame ?? null;
    if (lastFrame !== null && wsFree(boxed).length > 0 && wsFree(boxText(lastFrame)) === wsFree(boxed)) {
      throw new Ended("typed_not_submitted", "submit_failed", sawNote(last, { framed: true, rowsHash: last!.rowsHash, detail: STEER_NOT_TAKEN }));
    }
    throw new Ended("unknown", "no_evidence", { detail: STEER_NO_EVIDENCE });
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

  /**
   * Empties a framed box with the profile's clear key, in batches of {@link CLEAR_BATCH} with a read
   * between. Never Escape. The keys are counted before the first one goes (omp gang, 2026-10-25: six
   * rounds of 256 left most of a long draft in the box, or most of it gone and the rest kept):
   *  - a box that shows its whole draft takes what it shows plus the key's slack, counted again on
   *    every read, as before;
   *  - a box at its scroll height ({@link Frame.scrolled}) hides the head of its draft. It takes the
   *    length of the text Collie typed there (`known`, a Discard of its own send) plus the slack. With
   *    no such length (a Replace of the person's draft, a Discard of a box that held another text) it
   *    is refused `draft_present` before any key: a clear that stopped half way would leave half a draft;
   *  - a draft longer than {@link CLEAR_MAX_CHARS} is refused the same way.
   * The bound is one read per batch plus {@link CLEAR_SPARE_READS}, never under the S2 bound it borrowed
   * before, at {@link CLEAR_READ_MS} each; the request's own bound grows by what that adds. A batch
   * goes only after a read showed the box changed since the last one, so a late redraw costs a read,
   * never a second batch. A box that went away, a cue, or the bound end it `unknown(no_evidence)`.
   */
  private async clear(state: RunState, from: Snap, known: number | null): Promise<Snap> {
    const clearKey = state.match?.profile.keys.clear ?? GENERIC_CLEAR;
    const gone = (): Ended => new Ended("unknown", "no_evidence", { detail: "The box went away while it was being emptied." });
    const late = (): Ended => new Ended("unknown", "no_evidence", { detail: "The box did not empty inside the bound." });
    if (from.frame === null || from.cueStrength !== "none") throw gone();
    const shown = [...boxText(from.frame)].length;
    if (shown === 0) return from;
    const scrolled = from.frame.scrolled === true;
    if (scrolled && known === null) throw new Ended("refused", "draft_present", sawNote(from, { framed: true, offers: ["keys"], detail: TALL_DRAFT }));
    const length = scrolled && known !== null ? Math.max(known, shown) : shown;
    if (length > CLEAR_MAX_CHARS) throw new Ended("refused", "draft_present", sawNote(from, { framed: true, offers: ["keys"], detail: LONG_DRAFT }));
    let budget = length + clearKey.slack;
    // The profile's one stroke key (`keys.clearAll`) is pressed at most once, after reads showed the box
    // unchanged since the last batch, never on a box that reads empty.
    const clearAll = state.match?.profile.keys.clearAll;
    let allPressed = false;
    let unchanged = 0;
    const reads = Math.max(CLEAR_BOUND.reads, Math.ceil(budget / CLEAR_BATCH) + CLEAR_SPARE_READS) + (clearAll === undefined ? 0 : CLEAR_ALL_READS);
    const ms = reads * CLEAR_READ_MS;
    this.stretch(state, ms - CLEAR_BOUND.ms);
    const until = Math.min(this.now() + ms, state.deadline);
    let snap = from;
    // The box as the last batch left it; null before the first batch.
    let pressedAt: string | null = null;
    for (let read = 0; read < reads; read++) {
      if (this.now() > until) throw late();
      if (snap.frame === null || snap.cueStrength !== "none") throw gone();
      const text = boxText(snap.frame);
      const left = [...text].length;
      if (left === 0) return snap;
      unchanged = text === pressedAt ? unchanged + 1 : 0;
      if (clearAll !== undefined && !allPressed && unchanged >= CLEAR_ALL_AFTER) {
        // `left` is above 0 here: this very read showed a draft the Backspace batches did not move.
        allPressed = true;
        await this.keysThroughGate(state, [clearAll.key], "unknown");
        pressedAt = null;
      } else if (text !== pressedAt) {
        // A box that shows its whole draft is pressed for what it shows; one at its scroll height for
        // what is left of the length counted before the first key.
        const want = snap.frame.scrolled === true ? budget : Math.min(budget, left + clearKey.slack);
        if (want <= 0 && (clearAll === undefined || allPressed)) break;
        if (want <= 0) {
          // Backspace has no key left (its length plus slack went out) and the box still shows text: the
          // stroke key may follow once a few more reads show the box as it is, so a late redraw is no cause.
          pressedAt = text;
        } else {
          const count = Math.min(CLEAR_BATCH, want);
          await this.keysThroughGate(state, Array.from({ length: count }, () => clearKey.key), "unknown");
          budget -= count;
          pressedAt = text;
        }
      }
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
    throw late();
  }

  /**
   * The request's bound grows by `ms` (a clear of a long draft needs more than the S2 bound it
   * borrows), and the pane's lock with it, so no other send takes the pane while the keys go.
   */
  private stretch(state: RunState, ms: number): void {
    if (ms <= 0) return;
    state.deadline += ms;
    this.deps.locks.acquire(state.lockKey, state.record.id, state.deadline, this.now());
  }
}

/**
 * Whether a request is a command for the draft offers: mode `command`, or a submit whose first line
 * carries a reserved lead. One rule for a fresh refusal ({@link draftRefusal}) and a replayed one.
 */
function draftCommand(request: SendRequest, match: ProfileMatch | null): boolean {
  const leads = match?.profile.reservedLeads ?? GENERIC_LEADS;
  return request.mode === "command" || (request.mode === "submit" && reservedLead(sendLines(request.text)[0] ?? "", leads) !== null);
}

/**
 * The `draft_present` refusal of a send or a command at a box that holds a draft. A framed draft is
 * offered Add, Replace and Cancel, but a command only Replace and Cancel: Add would put the command
 * after the draft's words, and "old draft /model" is a message nobody means.
 */
function draftRefusal(state: RunState, s0: Snap): Ended {
  const framed = s0.frame !== null;
  const offers = offersFor("refused", "draft_present", framed, draftCommand(state.request, state.match));
  return new Ended("refused", "draft_present", { surface: s0.surface, framed, offers, detail: "The box already holds a draft." });
}

/**
 * The rules a text meets before any read: a plain send may not start with a reserved lead (it has the
 * command route), and a text of more than one line needs a profile's newline key. Null when it passes.
 * A Replace may start with one: it is the draft offer's answer to a command refused `draft_present`
 * (a typed `/model`, the belt's Model), the box is emptied first, and the text goes out as a command.
 */
function textRefusal(request: SendRequest, match: ProfileMatch | null): Ended | null {
  const lines = sendLines(request.text);
  const leads = match?.profile.reservedLeads ?? GENERIC_LEADS;
  const notes = match?.profile.reservedLeadNotes;
  const anyLead = reservedLead(lines[0] ?? "", leads);
  // A lead the profile gives a note has no command route: no mode may type it (it would be rewritten in the box).
  const note = anyLead === null ? undefined : notes?.[anyLead];
  if (note !== undefined) return new Ended("refused", "reserved_lead", { detail: note });
  const lead = request.mode === "command" || request.mode === "replace" ? null : anyLead;
  if (lead !== null) return new Ended("refused", "reserved_lead", { detail: LEAD_ROUTES.get(lead) ?? `A text that starts with ${lead} has its own route.` });
  // A chip token typed as text may expand to a pasted body the harness still holds (the profile says so).
  if (match?.profile.collapse.refuseLiteral === true && lines.some((line) => new RegExp(match.profile.collapse.pattern, "u").test(line))) {
    return new Ended("refused", "reserved_lead", { detail: CHIP_TOKEN });
  }
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
