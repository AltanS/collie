// Take a waiting queue back (ADR 0122, the 2026-11-22 addendum): `POST /api/pane/:id/dequeue` on a pane
// with a screen. A person's tap on Edit, on the chat's "Waiting to send" card, takes the agent's whole
// queue back into Collie's composer: one request id, a fresh read, the harness's own dequeue key once,
// the journal's proof, the box emptied, one receipt that carries the texts. The harness's key and its
// proof are data (`JournalAdapter.dequeue`); no harness name lives here (no-harness-names.test.ts scans
// this folder).
//
// Steps, all inside the pane's send lock (a send of this bridge never types between them, and the poll's
// box reads leave the queued cards alone while it is held):
//   read    a fresh read of the screen; the Surface decides, in this order:
//             no profile (or a revoked one)                 -> refused no_profile
//             the pane could not be read                    -> refused pane_gone
//             a dialog is up                                -> refused dialog_open
//             the turn already ended                        -> refused turn_idle
//             no turn claim, no dialog claim, no box found  -> refused unreadable
//             the agent's box holds text (the key would move the cursor in it) -> refused draft_present
//   journal the session's log read again now: the person's waiting texts, whole, and the number of the
//           newest queue move (RowReducer.queueMark). No log -> refused no_journal; no waiting text ->
//           refused queue_empty; a text that cannot come back whole (a picture, a paste marker, too
//           long, or a secret shape this bridge masks) -> refused not_whole
//   reread  one more read of the screen right before the key, with the same refusals
//   press   the declared keys once, through the key gate as `person_tap`. Never pressed twice: on an idle
//           box the same key recalls the last prompt from the agent's history
//   proof   the log read at 0.4 s, 1.4 s and 2.4 s after the key (the Stop's read-back clock). Proved when,
//           in the same log generation, the moves after the one read before the key are only the
//           harness's own plumbing up to a `back` move (the queue went back into the box), and that
//           move's words, when its row names any, are the texts that were read. A box read is never the
//           proof, for the reason above
//   proved  the box is read until it holds exactly the texts (white space folded); then the profile's clear
//           key, as many times as the box has characters plus its slack (the Send Protocol's discard
//           step), in batches, each one only after a read showed the box shorter, and a read-back that
//           shows it empty -> `taken` with the texts. A box that never held exactly the texts, or that
//           still holds exactly them after the clear (no key left, or none removed anything), is left as
//           it is -> `in_box`. A clear that removed something and did not read back empty (it stopped
//           shrinking, a dialog came up, the span ran out) -> `taken` with the texts and `leftover`: the
//           words left the queue, so they go to the person; the box may hold a cut-off rest
//   not     the queue went out, or the log cannot tell:
//           a `back` move that did not tie                -> nothing pressed again; `in_box` when the box
//                                                            holds text, else `unknown`
//           the person's words left the queue first (the turn ended between the read and the key) and
//           the box now holds one of the texts read, or all of them, which the empty box before the
//           key did not: the key recalled it from history -> cleared as above -> `too_late` (a clear
//           that does not read back empty -> `unknown`)
//           the words left and the box is empty, the queue now empty -> `too_late`
//           anything else                                  -> nothing pressed again; `unknown`
//           With no `back` move at all, the Send Protocol stops matching those texts' queued sends to the
//           box (`blind`): a box that shows one now holds a recalled copy of a text that went out, and a
//           "Back in the box" card would offer to send it a second time. They leave when the journal
//           shows them sent.
//
// A THROW AFTER THE KEY. Everything after the press is behind one guard: a reader that throws (the screen, the log,
// the clear key) settles the request as `unknown`, pressed, so the receipt is kept, a replay answers it, and the
// route writes its audit line. When the proof had shown the queue go back into the box, the receipt also carries
// its texts (the words left the queue), and the audit line counts them. A throw before the key stays a throw.
//
// THE SPAN. Every press checks a deadline, the lock's span less a margin: no key leaves after it. Before
// the dequeue key that refuses `busy`; during the clear it stops the clear, under the rule above.
//
// The same request id answers the same receipt and presses once; a request id still in flight is joined,
// never pressed twice. The receipts live in memory, with the texts, for that replay only; a bridge
// restart forgets them. The texts never reach a log line, the audit line, a trace or an error: the
// route's audit line names the request id, the outcome, the reason and the count of texts.

import type { MuxAck, MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import type { QueueMark, QueueMove } from "../journal/reduce.ts";
import { wsFree } from "../../web/src/lib/surface/send.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import type { DequeueReason, DequeueReceipt } from "../../web/src/lib/surface/dequeue.ts";
import type { Frame } from "../../web/src/lib/surface/frame.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { liftAsk, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import type { ProfileMatch } from "../../web/src/lib/surface/profile.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import type { KeyGate } from "./key-gate.ts";

/** Rows one read asks for, as the Stop and the Clear read them. */
const READ_LINES = 120;
/** The gaps before each proof read after the key: the Stop's read-back clock (0.4 s, 1.4 s, 2.4 s). */
export const PROOF_GAPS_MS: readonly number[] = [400, 1000, 1000];
/** The gaps before each read of the box after a proved key, until it holds the texts. */
const BOX_GAPS_MS: readonly number[] = [0, 120, 280, 500];
/** The gaps before each read-back after a clear press, as the Clear's. */
const CLEAR_GAPS_MS: readonly number[] = [120, 280, 500, 800];
/** Keys per clear press, as the Send Protocol's clear batch. */
const CLEAR_BATCH = 256;
/** Clear presses at most: twelve batches, the Clear's bound. */
const CLEAR_ROUNDS = 12;
/** The longest a take-back holds the pane's send lock: its reads, the key, the proof and the clear end well inside it. */
export const DEQUEUE_SPAN_MS = 30_000;
/** No key leaves later than this before the span ends: the lock may pass to another send at the span's end. */
export const SPAN_MARGIN_MS = 2_000;
/** How many settled receipts a bridge keeps for a replay, newest kept. */
const KEPT = 256;

/** What a take-back needs of a multiplexer besides keys (which only the gate sends). */
export interface DequeueMux {
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;
}

/** The session's queue, read again now: the log's generation and the reducer's mark (LiveWindows.queueNow). Null when the log cannot be read. */
export type DequeueJournal = () => Promise<{ readonly gen: number; readonly mark: QueueMark } | null>;

/** What one take-back is asked to do, from the route that knows the pane's journal adapter. */
export interface DequeueAsk {
  /** The harness's dequeue keys, in the neutral spelling, and the proof its journal gives (`JournalAdapter.dequeue`). */
  readonly keys: readonly string[];
  readonly journal: DequeueJournal;
  /** Whether a text may travel in the answer as it is: false for one this bridge would mask (`redact`). */
  readonly sendable: (text: string) => boolean;
}

export interface DequeueDeps {
  readonly mux: DequeueMux;
  readonly gate: Pick<KeyGate, "press">;
  /** The harness's profile; with `paneId`, at the version of the pane's own program when the bridge can see it (SendDeps.profile). */
  readonly profile: (harness: string, paneId?: string) => Promise<ProfileMatch | null>;
  /**
   * Run `work` holding the pane's send lock (SendProtocol.underPaneLock), or answer `busy()` with nothing
   * done when another send holds it.
   */
  readonly lock: <T>(paneId: string, owner: string, spanMs: number, work: () => Promise<T>, busy: () => T) => Promise<T>;
  /** The taken texts: the Send Protocol forgets its queued sends of them, so no card stands for them later (SendProtocol.takenBack). */
  readonly forget: (paneId: string, texts: readonly string[]) => void;
  /**
   * A key left and the log showed no `back` move: the Send Protocol stops matching these texts' queued sends
   * to the box, so a recalled copy never makes a "Back in the box" card (SendProtocol.blindToBox).
   */
  readonly blind?: (paneId: string, texts: readonly string[]) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  /** The clock the span's deadline reads; `Date.now` by default. */
  readonly now?: () => number;
}

/** What a take-back answers: the receipt, whether it is the stored one of an earlier tap, and whether a key left this time. */
export type DequeueAnswer =
  | { readonly kind: "receipt"; readonly receipt: DequeueReceipt; readonly replayed: boolean; readonly pressed: boolean }
  /** The request id was used on another pane. Nothing ran. */
  | { readonly kind: "id_reused" };

interface Settled {
  readonly receipt: DequeueReceipt;
  readonly pressed: boolean;
}

/** One read of the pane: its Surface and the box it found (null when the screen shows none). */
interface Look {
  readonly surface: Surface;
  readonly frame: Frame | null;
}

/** What the log shows after the key, against the mark read before it. */
type Proof =
  /** The queue that was read went back into the box. */
  | "proved"
  /** A `back` move came, but not for the queue that was read (other words moved first, or its words differ). */
  | "back_untied"
  /** The person's words left the queue and no `back` move came: the queue went out. */
  | "went_out"
  /** Nothing of the person's moved yet. */
  | "none"
  /** The log cannot be tied to the read before the key (a new generation, more moves than the mark keeps, no log). */
  | "lost";

function refusal(requestId: string, reason: DequeueReason): Settled {
  return { receipt: { requestId, outcome: "refused", reason }, pressed: false };
}

function ended(requestId: string, outcome: "in_box" | "too_late" | "unknown", leftover = false): Settled {
  return { receipt: leftover ? { requestId, outcome, leftover: true } : { requestId, outcome }, pressed: true };
}

/** What a take-back knows of the words after its key, for the guard around everything that follows the key. */
interface Progress {
  /** The log showed the queue that was read go back into the box: its words left the queue. */
  proved: boolean;
}

/**
 * The answer of a take-back that threw after its key: `unknown`, pressed. The words that left the queue ride along when
 * the proof had shown it (the same field a `taken` answer carries); the audit line counts them and never names them.
 */
function unknownAfterKey(requestId: string, texts: readonly string[] | null): Settled {
  return { receipt: texts === null ? { requestId, outcome: "unknown" } : { requestId, outcome: "unknown", texts: [...texts] }, pressed: true };
}

/** What a clear did: the box read back empty, or it stopped, with whether a key left and the last box it read (null when the last read showed none). */
type Emptied = { readonly empty: true } | { readonly empty: false; readonly pressed: boolean; readonly box: string | null };

function boxText(frame: Frame): string {
  return frame.placeholder ? "" : frame.interior.text;
}

/** Whether the profile may be trusted to read a screen: not on a revoked version or range. */
function readable(match: ProfileMatch | null): match is ProfileMatch {
  return match !== null && match.status !== "revoked" && match.range?.status !== "revoked";
}

/** Why a read refuses the key, or null when the key may go: a running turn, no dialog, a found and empty box. */
function refusalOf(look: Look | null): DequeueReason | null {
  if (look === null) return "pane_gone";
  const { surface, frame } = look;
  if (surface.modal !== "none" && surface.modal !== "unknown") return "dialog_open";
  if (surface.turn === "idle") return "turn_idle";
  if (surface.modal === "unknown" || surface.turn !== "running" || frame === null) return "unreadable";
  if (surface.composer === "draft") return "draft_present";
  if (surface.composer !== "empty") return "unreadable";
  return null;
}

/**
 * What the log shows after the key. The moves after `before.moves` must be the harness's plumbing only, up to
 * a `back` move whose words (when its row names any) are the texts read before the key.
 */
export function proofOf(before: { readonly gen: number; readonly mark: QueueMark }, after: { readonly gen: number; readonly mark: QueueMark } | null, texts: readonly string[]): Proof {
  if (after === null || after.gen !== before.gen) return "lost";
  const fresh = after.mark.recent.filter((move) => move.n > before.mark.moves);
  if (after.mark.moves > before.mark.moves && fresh[0]?.n !== before.mark.moves + 1) return "lost";
  let words = false;
  for (const move of fresh) {
    if (move.kind === "plumbing") continue;
    if (move.kind === "words") {
      words = true;
      continue;
    }
    if (words) return "back_untied";
    return backTies(move, texts) ? "proved" : "back_untied";
  }
  return words ? "went_out" : "none";
}

/** Whether a `back` move is the queue read: a row that names no words ties by its place alone; one that names words must name these. */
function backTies(move: QueueMove, texts: readonly string[]): boolean {
  if (move.words === null) return true;
  return wsFree(move.words) === wsFree(texts.join("\n"));
}

/** Whether a `back` move came at all after the mark, tied or not. */
function backSeen(before: QueueMark, after: { readonly mark: QueueMark } | null): boolean {
  return after !== null && after.mark.recent.some((move) => move.n > before.moves && move.kind === "back");
}

export class DequeueService {
  private readonly settled = new Map<string, { readonly paneId: string } & Settled>();
  private readonly running = new Map<string, { readonly paneId: string; readonly work: Promise<Settled> }>();

  constructor(private readonly deps: DequeueDeps) {}

  /**
   * One take-back. `harness` is the agent string the multiplexer reports for the pane. With `replayOnly` (the
   * phone asking by itself for a lost answer) an id this bridge does not know starts nothing: it answers
   * `unknown`, pressed nothing, and keeps no receipt for it.
   */
  async handle(requestId: string, paneId: string, harness: string, ask: DequeueAsk, replayOnly = false): Promise<DequeueAnswer> {
    const stored = this.settled.get(requestId);
    if (stored !== undefined) {
      return stored.paneId === paneId ? { kind: "receipt", receipt: stored.receipt, replayed: true, pressed: stored.pressed } : { kind: "id_reused" };
    }
    const inflight = this.running.get(requestId);
    if (inflight !== undefined) {
      if (inflight.paneId !== paneId) return { kind: "id_reused" };
      const joined = await inflight.work;
      return { kind: "receipt", receipt: joined.receipt, replayed: true, pressed: joined.pressed };
    }
    if (replayOnly) return { kind: "receipt", receipt: { requestId, outcome: "unknown" }, replayed: true, pressed: false };
    // Synchronous from the look above to this registration: two taps with one id must not both press.
    const work = this.start(requestId, paneId, harness, ask);
    this.running.set(requestId, { paneId, work });
    try {
      const done = await work;
      this.keep(requestId, { paneId, ...done });
      return { kind: "receipt", receipt: done.receipt, replayed: false, pressed: done.pressed };
    } finally {
      this.running.delete(requestId);
    }
  }

  private keep(requestId: string, stored: { readonly paneId: string } & Settled): void {
    this.settled.set(requestId, stored);
    if (this.settled.size <= KEPT) return;
    const oldest = this.settled.keys().next();
    if (!oldest.done) this.settled.delete(oldest.value);
  }

  private async start(requestId: string, paneId: string, harness: string, ask: DequeueAsk): Promise<Settled> {
    if (ask.keys.length === 0) return refusal(requestId, "no_key");
    const match = harness === "" ? null : await this.deps.profile(harness, paneId);
    if (!readable(match)) return refusal(requestId, "no_profile");
    return this.deps.lock(paneId, `dequeue-${requestId}`, DEQUEUE_SPAN_MS, () => this.run(requestId, paneId, harness, match, ask), () => refusal(requestId, "busy"));
  }

  private async run(requestId: string, paneId: string, harness: string, match: ProfileMatch, ask: DequeueAsk): Promise<Settled> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const now = this.deps.now ?? Date.now;
    // The lock is held from here: no key leaves after its span less the margin.
    const deadline = now() + DEQUEUE_SPAN_MS - SPAN_MARGIN_MS;
    const inTime = (): boolean => now() <= deadline;
    // 1. The read before the key: the screen, the log, the screen again right before the press.
    const first = refusalOf(await this.look(paneId, harness, match));
    if (first !== null) return refusal(requestId, first);
    const before = await ask.journal();
    if (before === null) return refusal(requestId, "no_journal");
    const texts = before.mark.texts;
    if (texts === null) return refusal(requestId, "not_whole");
    if (texts.length === 0) return refusal(requestId, "queue_empty");
    if (!texts.every((text) => ask.sendable(text))) return refusal(requestId, "not_whole");
    const again = refusalOf(await this.look(paneId, harness, match));
    if (again !== null) return refusal(requestId, again);
    // 2. The key, once, and only inside the span.
    if (!inTime()) return refusal(requestId, "busy");
    const sent: MuxAck = await this.deps.gate.press(paneId, [...ask.keys], "person_tap");
    // A key not confirmed in time may still land (M100 spec 03): it counts as pressed, and the proof decides.
    if (!sent.ok && sent.reason !== "unconfirmed") return refusal(requestId, "press_failed");
    // Everything from here on is behind one guard: a key left, so a throw settles as `unknown` and is never a rejection.
    const progress: Progress = { proved: false };
    try {
      return await this.afterKey(requestId, paneId, harness, match, { ask, before, texts, sleep, inTime }, progress);
    } catch (err) {
      // The name of a throw is the bridge's own; the texts never reach it.
      console.warn(`[dequeue] the take-back on ${paneId} failed after its key: ${err instanceof Error ? err.name : "error"}`);
      return unknownAfterKey(requestId, progress.proved ? texts : null);
    }
  }

  /** What follows the key: the proof, the clear, and the answer. Throws are the caller's guard. */
  private async afterKey(
    requestId: string,
    paneId: string,
    harness: string,
    match: ProfileMatch,
    { ask, before, texts, sleep, inTime }: { readonly ask: DequeueAsk; readonly before: { readonly gen: number; readonly mark: QueueMark }; readonly texts: readonly string[]; readonly sleep: (ms: number) => Promise<void>; readonly inTime: () => boolean },
    progress: Progress,
  ): Promise<Settled> {
    // 3. The proof, from the log, on the Stop's clock.
    let proof: Proof = "none";
    let after: Awaited<ReturnType<DequeueJournal>> = null;
    for (const gap of PROOF_GAPS_MS) {
      await sleep(gap);
      after = await ask.journal();
      proof = proofOf(before, after, texts);
      if (proof !== "none") break;
    }
    // 4. Proved: the box must hold exactly the texts before a key empties it.
    if (proof === "proved") {
      progress.proved = true;
      const shown = await this.boxHolding(paneId, harness, match, texts, sleep);
      if (shown === null) return ended(requestId, "in_box");
      const cleared = await this.empty(paneId, harness, match, shown, texts, sleep, inTime);
      // The box still holds exactly the queue: no clear key left, or none removed anything. Its card carries on.
      if (!cleared.empty && (!cleared.pressed || (cleared.box !== null && wsFree(cleared.box) === wsFree(texts.join("\n"))))) return ended(requestId, "in_box");
      // Emptied, or a clear that started and was not proved: the words left the queue and go to the person.
      this.forget(paneId, texts);
      const receipt: DequeueReceipt = cleared.empty ? { requestId, outcome: "taken", texts: [...texts] } : { requestId, outcome: "taken", texts: [...texts], leftover: true };
      return { receipt, pressed: true };
    }
    // 5. Not proved: the queue went out, or the log cannot tell.
    const look = await this.look(paneId, harness, match);
    const box = look?.frame == null ? null : boxText(look.frame);
    if (backSeen(before.mark, after)) return ended(requestId, box !== null && box.trim() !== "" ? "in_box" : "unknown");
    // No `back` move: whatever the box shows of these texts now is no queue given back. The sends leave on the journal.
    this.blind(paneId, texts);
    if (proof !== "went_out" || box === null) return ended(requestId, "unknown");
    if (box.trim() === "") return ended(requestId, after !== null && after.mark.texts !== null && after.mark.texts.length === 0 ? "too_late" : "unknown");
    // The box was empty before the key and holds one of the texts now, or all of them: the key recalled the
    // last prompt from the agent's history. It is emptied again; any other text is left alone.
    const recalled = [...texts, texts.join("\n")].find((text) => wsFree(text) === wsFree(box));
    if (recalled === undefined) return ended(requestId, "unknown");
    const cleared = await this.empty(paneId, harness, match, look!.frame!, [recalled], sleep, inTime);
    if (cleared.empty) return ended(requestId, "too_late");
    // A clear that removed part of the recalled copy: it went out all the same, and the box holds a rest.
    const untouched = !cleared.pressed || (cleared.box !== null && wsFree(cleared.box) === wsFree(recalled));
    return untouched ? ended(requestId, "unknown") : ended(requestId, "too_late", true);
  }

  /** The box, read until it holds exactly the texts (white space folded), or null when no read shows that. */
  private async boxHolding(paneId: string, harness: string, match: ProfileMatch, texts: readonly string[], sleep: (ms: number) => Promise<void>): Promise<Frame | null> {
    const want = wsFree(texts.join("\n"));
    for (const gap of BOX_GAPS_MS) {
      if (gap > 0) await sleep(gap);
      const look = await this.look(paneId, harness, match);
      if (look === null) return null;
      if (look.surface.modal !== "none" && look.surface.modal !== "unknown") return null;
      if (look.frame !== null && wsFree(boxText(look.frame)) === want) return look.frame;
    }
    return null;
  }

  /**
   * The box emptied with the profile's clear key: as many keys as it holds characters (or the texts, when they
   * are longer) plus the key's slack, in batches; a further batch only after a fresh read showed the box
   * shorter than before the last one, so no press is blind, and none after the span's deadline (`inTime`).
   * Empty once a read-back shows it empty with no dialog; otherwise whether any clear key left and the last box
   * read (null when the last read showed no box, a dialog, or nothing).
   */
  private async empty(paneId: string, harness: string, match: ProfileMatch, shown: Frame, texts: readonly string[], sleep: (ms: number) => Promise<void>, inTime: () => boolean): Promise<Emptied> {
    const clear = match.profile.keys.clear;
    let length = Math.max([...boxText(shown)].length, [...texts.join("\n")].length);
    let pressed = false;
    let box: string | null = boxText(shown);
    for (let round = 0; round < CLEAR_ROUNDS; round++) {
      if (!inTime()) return { empty: false, pressed, box };
      const count = Math.min(CLEAR_BATCH, length + clear.slack);
      const sent = await this.deps.gate.press(paneId, Array.from({ length: count }, () => clear.key), "person_tap");
      if (!sent.ok && sent.reason !== "unconfirmed") return { empty: false, pressed, box };
      pressed = true;
      let left: number | null = null;
      for (const gap of CLEAR_GAPS_MS) {
        await sleep(gap);
        const look = await this.look(paneId, harness, match);
        if (look === null || (look.surface.modal !== "none" && look.surface.modal !== "unknown")) return { empty: false, pressed, box: null };
        if (look.frame === null) {
          box = null;
          continue;
        }
        if (look.surface.composer === "empty") return { empty: true };
        box = boxText(look.frame);
        left = [...box].length;
        if (count === CLEAR_BATCH && left < length) break;
      }
      // A box that did not shrink, or a batch that should have emptied it, is left as it is.
      if (left === null || left >= length || count < CLEAR_BATCH || !sent.ok) return { empty: false, pressed, box };
      length = left;
    }
    return { empty: false, pressed, box };
  }

  private blind(paneId: string, texts: readonly string[]): void {
    try {
      this.deps.blind?.(paneId, texts);
    } catch (err) {
      console.warn(`[dequeue] the box match on ${paneId} could not be turned off: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  private forget(paneId: string, texts: readonly string[]): void {
    try {
      this.deps.forget(paneId, texts);
    } catch (err) {
      // The message of a throw is the bridge's own; the texts never reach it.
      console.warn(`[dequeue] forgetting the taken sends on ${paneId} failed: ${err instanceof Error ? err.name : "error"}`);
    }
  }

  /** One fresh read of the pane, folded into its Surface. Null when the multiplexer could not read it. */
  private async look(paneId: string, harness: string, match: ProfileMatch): Promise<Look | null> {
    const grid = await this.deps.mux.readGrid(paneId, { scope: "viewport", lines: READ_LINES, styling: "preserve" });
    if (!grid.ok) return null;
    const rows = splitLines(parseAnsi(grid.value.text));
    const ask = liftAsk(readerBlocks(rows, harness), grid.value.revision);
    const read = surfaceOfScreen({ seq: 0, source: "screen", at: Date.now(), revision: grid.value.revision, rows, ask }, match.profile.idle);
    return { surface: read.surface, frame: read.frame };
  }
}
