// The structured driver (M56 spec 14). A program session has no screen. It has structured state: the
// turn from its stream, its open asks, and no input box. This driver gives such a session the same
// three contracts a terminal pane has, from that state alone:
//
//  - Surface. `turn` comes from the program's pane state, `modal` from its oldest open ask, and
//    `composer` is always `empty`, because there is no box. The revision is a number made from the
//    pane's newest turn id, so a send can name the turn the phone saw (ADR 0101). The driver is the
//    one driver of its session: it never feeds a screen fold, and nothing votes against it.
//  - Send. Accept and persist, the lock and the receipt are the Send Protocol's own (requests.ts,
//    SessionLocks). In place of S0 to S2 there is one structured write: the text goes to the program
//    for the turn the bridge read, with the request id, and the program's answer is the evidence.
//    The outcome list is the same. `sent` carries `queued` when the turn ran and the program took
//    the text for after it (WIRE.md 7.4: a send with no steer waits for the next turn). `unknown`
//    means the program did not acknowledge. The receipt carries the request id the program took.
//  - Effective. The program writes the person's line into the conversation as a `user` item that
//    names the request id of the send. That item closes the receipt as `effective`, as a prompt edge
//    does for a terminal pane (spec 11): at once when the receipt settled, at its settle when the
//    write still runs. The request id is exact, so no time window and no text hash are needed.
//  - Ask. The oldest open ask becomes `{ id, kind, options, channel: "program", hash }`. The id is
//    single use and bound to the program's ask id, its revision and the content hash. The answer
//    carries the hash, the bridge compares it with the ask the program lists now, and the answer
//    goes to the program by the program's own ask id. No key is ever sent.
//
// The counters (spec 09) count the driver's reads and outcomes in one row, under the source
// `program`. No harness name lives here (no-harness-names.test.ts scans this folder), and the driver
// is picked by the session kind, never by an agent string.

import { randomUUID } from "node:crypto";
import { muxRefused, type MuxAdapter, type MuxAnswerResult, type MuxControlOutcome, type MuxOutcome } from "../mux/types.ts";
import type { AgentStatus, AnswerRequest, Ask as ProgramAsk, ControlRequest } from "../types.ts";
import type { Answer, AskReason, AskReceipt, AskReply, AskOutcome } from "../../web/src/lib/surface/ask.ts";
import { offersFor, type ReadMark, type SendAnswer, type SendOutcome, type SendReason, type SendReceipt, type SendReceiptRow } from "../../web/src/lib/surface/send.ts";
import { programContract, type ProgramContract } from "../../web/src/lib/surface/program.ts";
import { askOf, shortHash, type Ask, type Surface, type SurfaceTurn } from "../../web/src/lib/surface/surface.ts";
import type { CounterKey } from "./counters.ts";
import type { SendRequest, SendTarget, SessionLocks } from "./protocol.ts";
import type { AskRecord, RequestStore, SendRecord } from "./requests.ts";

/** The counters row of every program session: its own source, with no version and no profile. */
export const PROGRAM_COUNTER_KEY: CounterKey = { harness: "program", version: "-", profileId: "-", status: "-" };

/**
 * How long one request may hold the pane. The adapter reads the layout and then writes, each inside
 * its own deadline (1 s and 3 s over the socket, 5 s and 5 s over TLS, WIRE.md 7.6), plus room.
 */
export const PROGRAM_LOCK_MS = 12_000;

/** How often a Stop that waits for the lock tries again. */
const STOP_RETRY_MS = 50;

/** The pane generation a program record carries. A program pane holds one conversation for life. */
const PROGRAM_GENERATION = "program";

/** How many ask ids the book remembers, newest kept. An id it forgot answers `ask_unknown`. */
const BOOK_SIZE = 512;

// The sentences a person reads. Short, active, one idea each.
const NO_BOX = "This conversation has no input box, so there is no text to add to, replace, submit or discard.";
/** A steer on a program pane (M69): the driver writes a message for after the turn, never into it. */
const NO_STEER = "Collie cannot steer this agent's turn. Send it without Steer, and it waits for the turn.";
const ASK_OPEN = "The durable agent waits for an answer to a question. Answer it first, then send.";
const NOT_READ = "Collie cannot read the state of this conversation now. Try again in a moment.";
const PANE_GONE = "The conversation is not in the durable agent's layout.";
const TURN_MOVED = "The durable agent started another turn after you looked. Read the chat, then send again.";
const BUSY = "Another send or answer on this conversation is still running.";
const QUEUED = "The durable agent runs a turn. It takes the message when that turn ends.";
const NOT_ACKED = "The durable agent did not say it took the message. Read the chat before you send it again.";
const CRASHED = "Collie lost this send before it ended, so it cannot say whether the durable agent took it. Read the chat.";
const ASK_NOT_ACKED = "The durable agent did not say it took the answer. Read the chat before you answer again.";
const ASK_CRASHED = "Collie lost this answer before it ended, so it cannot say whether the durable agent took it. Read the chat.";
const ID_ELSEWHERE = "This request id belongs to a send on another conversation.";

/** What the driver needs of the program's adapter. Every read answers from the adapter's last layout read. */
export interface ProgramPort {
  /** `ready` while the program answers; anything else means its state is not known now. */
  phase(): "starting" | "ready" | "unreachable";
  /** How the pane is doing (WIRE.md section 5), or undefined when the pane is not in the layout. */
  paneStatus(paneId: string): AgentStatus | undefined;
  /** The pane's newest turn id, or undefined. */
  paneTurn(paneId: string): string | undefined;
  /** The pane's open asks, oldest first, or undefined when the program raises none. */
  openAsks(paneId: string): readonly ProgramAsk[] | undefined;
  /** One send to the turn named. The adapter reads the layout once more and checks the name first. */
  controlTurn(paneId: string, request: ControlRequest): Promise<MuxControlOutcome>;
  /** One answer to the ask named, by the program's own ask id and revision. */
  answerAsk(paneId: string, answer: AnswerRequest): Promise<MuxOutcome<MuxAnswerResult>>;
  /**
   * Hear of each `user` item the program writes with a request id, by its pane (WIRE.md 7.15). The
   * item is the program's word that the text reached the conversation. Absent: no send closes as
   * `effective`, and every receipt keeps the end the write gave it.
   */
  onUserItem?(listener: (paneId: string, requestId: string) => void): () => void;
}

/** What the driver tells the counters. Every call is made after the fact and inside a try. */
export interface ProgramLedger {
  read(key: CounterKey, surface: Surface, frame: string | null): void;
  send(key: CounterKey, end: { readonly outcome: string; readonly reason?: string | undefined; readonly probed: boolean }): void;
  /** A settled `sent` or `unknown` the program's own item confirmed: it moves to `effective`. */
  confirmEffective?(key: CounterKey, from: "sent" | "unknown"): void;
}

export interface ProgramDriverDeps {
  /** The bridge session this driver serves. Two programs may name a pane alike; a record of another session is never this driver's. */
  readonly session: string;
  readonly port: ProgramPort;
  readonly store: RequestStore;
  readonly locks: SessionLocks;
  readonly ledger?: ProgramLedger | undefined;
  readonly now?: () => number;
  /** How a Stop waits for the lock between tries. A test passes its own clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Random per driver, so a restart never mints an ask id a stored receipt already holds. */
  readonly salt?: string;
}

/** A receipt row, a send receipt and an ask receipt being finished, field by field. */
type RowDraft = { -readonly [K in keyof SendReceiptRow]: SendReceiptRow[K] };
type SendReceiptDraft = { -readonly [K in keyof SendReceipt]: SendReceipt[K] };
type AskReceiptDraft = { -readonly [K in keyof AskReceipt]: AskReceipt[K] };

// ── The structured state ─────────────────────────────────────────────────────────────────────────

/** One pane's structured state, as the adapter last read it. */
interface ProgramView {
  readonly ready: boolean;
  readonly status: AgentStatus | undefined;
  readonly turnId: string | undefined;
  readonly asks: readonly ProgramAsk[];
}

/** The Surface revision of a pane: a number made from its newest turn id, 0 when it names none. */
export function programRevision(turnId: string | undefined): number {
  if (turnId === undefined || turnId === "") return 0;
  // 48 bits of the short hash: a safe integer, the same for the same turn after a restart.
  return Number.parseInt(shortHash(`turn\n${turnId}`).slice(-12), 16);
}

/** The turn claim from the program's pane state. An open ask waits inside a turn, so it runs. */
export function turnOfStatus(status: AgentStatus | undefined): SurfaceTurn {
  if (status === "working" || status === "blocked") return "running";
  if (status === "idle" || status === "done") return "idle";
  return "unknown";
}

/** A short hash of the state a read saw: the turn, the pane state and the open asks by id and revision. */
function viewHash(view: ProgramView): string {
  const asks = view.asks.map((ask) => `${ask.id}@${String(ask.revision)}`).join(",");
  return shortHash(`${view.turnId ?? "-"}\n${view.status ?? "-"}\n${asks}`);
}

function markOf(view: ProgramView): ReadMark {
  return { revision: programRevision(view.turnId), hash: viewHash(view) };
}

// ── Asks ─────────────────────────────────────────────────────────────────────────────────────────

/** A program ask as the contract shows it (web/src/lib/surface/program.ts). */
export type ContractAsk = ProgramContract;

/** The contract form of a program ask, or null when one tap cannot answer it (see `programContract`). */
export function contractAsk(ask: ProgramAsk): ContractAsk | null {
  return programContract(ask);
}

type EntryState = "live" | "spent" | "voided";

/** One minted ask and the program ask it stands for. */
interface ProgramAskEntry {
  readonly ask: Ask;
  readonly paneId: string;
  readonly programAskId: string;
  readonly revision: number;
  readonly optionIds: readonly string[];
  readonly binding: string;
  state: EntryState;
}

/**
 * The single-use ask ids of one program session. The same program ask, at the same revision and with
 * the same content, keeps its id until the id is spent (answered) or voided (the ask closed or
 * changed). After that the same ask gets a new id.
 */
export class ProgramAskBook {
  private readonly byId = new Map<string, ProgramAskEntry>();
  private readonly current = new Map<string, string>();
  private serial = 0;

  constructor(private readonly salt: string = randomUUID()) {}

  /** The pane's oldest open ask as a contract ask, or null when it has none or the contract cannot answer it. */
  publish(paneId: string, ask: ProgramAsk | null): Ask | null {
    const live = this.liveEntry(paneId);
    const shown = ask === null ? null : contractAsk(ask);
    if (ask === null || shown === null) {
      if (live !== null) live.state = "voided";
      return null;
    }
    const binding = shortHash(`${paneId}\n${ask.id}\n${String(ask.revision)}\n${shown.hash}`);
    if (live !== null && live.binding === binding) return live.ask;
    if (live !== null) live.state = "voided";
    this.serial++;
    const id = `ask-${shortHash(`${this.salt}\n${String(this.serial)}\n${binding}`)}`;
    const options = shown.labels.map((label, index) => ({ id: String(index + 1), label }));
    const entry: ProgramAskEntry = {
      ask: { id, kind: shown.kind, options, channel: "program", hash: shown.hash },
      paneId,
      programAskId: ask.id,
      revision: ask.revision,
      optionIds: shown.optionIds,
      binding,
      state: "live",
    };
    this.byId.set(id, entry);
    this.current.set(paneId, id);
    while (this.byId.size > BOOK_SIZE) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
    return entry.ask;
  }

  entry(id: string): ProgramAskEntry | undefined {
    return this.byId.get(id);
  }

  /** The pane's live ask, or null. */
  currentAsk(paneId: string): Ask | null {
    return this.liveEntry(paneId)?.ask ?? null;
  }

  private liveEntry(paneId: string): ProgramAskEntry | null {
    const id = this.current.get(paneId);
    const entry = id === undefined ? undefined : this.byId.get(id);
    return entry !== undefined && entry.state === "live" ? entry : null;
  }

  /** An answer took the id: it is never live again. */
  spend(id: string): void {
    const entry = this.byId.get(id);
    if (entry !== undefined && entry.state === "live") entry.state = "spent";
  }
}

/** A `sent` or `unknown` end the program's item confirmed: no reason, and no sentence that doubts it. */
function effectiveEnd(end: SendEnd): SendEnd {
  const { reason: _reason, detail, ...rest } = end;
  return end.outcome === "sent" && detail !== undefined ? { ...rest, detail, outcome: "effective" } : { ...rest, outcome: "effective" };
}

// ── The driver ───────────────────────────────────────────────────────────────────────────────────

/** How a send ends, before the receipt is made. */
interface SendEnd {
  readonly outcome: SendOutcome;
  readonly reason?: SendReason;
  readonly detail?: string;
  readonly queued?: boolean;
  readonly acknowledged?: boolean;
}

/** How an answer ends, before the receipt is made. */
interface AskEnd {
  readonly outcome: AskOutcome;
  readonly reason?: AskReason;
  readonly detail?: string;
  /** The ask the program lists now, under its own new id, for a refusal about a changed ask. */
  readonly ask?: Ask | null;
}

/** A send as it runs: what the receipt is made of. */
interface SendRun {
  readonly request: SendRequest;
  readonly record: SendRecord;
  readonly target: SendTarget;
  s0: ReadMark | null;
  s2: ReadMark | null;
  readonly gaps: { s0?: number; write?: number };
}

export class ProgramDriver {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly book: ProgramAskBook;
  private readonly sending = new Map<string, Promise<SendAnswer>>();
  private readonly answering = new Map<string, Promise<AskReply>>();
  /** Sends still running whose item already came in: they settle as `effective`. */
  private readonly early = new Set<string>();

  constructor(private readonly deps: ProgramDriverDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.book = new ProgramAskBook(deps.salt);
    deps.port.onUserItem?.((paneId, requestId) => {
      this.itemTook(paneId, requestId);
    });
  }

  /**
   * The program wrote a `user` item that names `requestId` on `paneId`. A send of this driver on that
   * pane that ended `sent` or `unknown` closes as `effective`; one still running closes so at its
   * settle. Returns true when it closed or will close one. Never throws; a write that fails is a warning.
   */
  itemTook(paneId: string, requestId: string): boolean {
    const record = this.deps.store.get(requestId);
    // Only a send this driver's session ran on this pane: another program may have a pane of the same
    // name, and a terminal send never carries the program generation.
    if (record === null || record.session !== this.deps.session || record.paneId !== paneId || record.paneGeneration !== PROGRAM_GENERATION) return false;
    if (this.sending.has(requestId)) {
      this.early.add(requestId);
      return true;
    }
    try {
      const from = this.deps.store.markEffective(requestId);
      if (from === null) return false;
      this.deps.ledger?.confirmEffective?.(PROGRAM_COUNTER_KEY, from);
      return true;
    } catch (err) {
      console.warn(`[send] could not close ${requestId} as effective: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private view(paneId: string): ProgramView {
    const { port } = this.deps;
    return {
      ready: port.phase() === "ready",
      status: port.paneStatus(paneId),
      turnId: port.paneTurn(paneId),
      asks: port.openAsks(paneId) ?? [],
    };
  }

  /** The Surface of one view. A program that does not answer has a state nobody knows now. */
  private surfaceOfView(paneId: string, view: ProgramView): Surface {
    const revision = programRevision(view.turnId);
    if (!view.ready || view.status === undefined) return { revision, turn: "unknown", modal: "unknown", composer: "unreachable", reason: "stale" };
    const oldest = view.asks[0] ?? null;
    const ask = this.book.publish(paneId, oldest);
    const modal = oldest === null ? "none" : ask === null ? "unreadable" : { ask };
    return { revision, turn: turnOfStatus(view.status), modal, composer: "empty" };
  }

  /** The pane's Surface from the program's structured state, or undefined when the pane is not in the layout. */
  surfaceOf(paneId: string): Surface | undefined {
    const view = this.view(paneId);
    if (view.ready && view.status === undefined) return undefined;
    return this.surfaceOfView(paneId, view);
  }

  /** One poll of the session: each pane's Surface into the counters, as the screen fold counts its reads. */
  observe(paneIds: readonly string[]): void {
    const { ledger } = this.deps;
    for (const paneId of paneIds) {
      const surface = this.surfaceOf(paneId);
      if (surface === undefined || ledger === undefined) continue;
      try {
        ledger.read(PROGRAM_COUNTER_KEY, surface, null);
      } catch (err) {
        console.warn(`[surface] program read count failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** The newest settled sends for one pane of this session, newest first, as the session page lists them. */
  recent(paneId: string, limit = 10, session?: string): SendReceiptRow[] {
    const rows: SendReceiptRow[] = [];
    for (const record of this.deps.store.list().toReversed()) {
      if (rows.length >= limit) break;
      const receipt = record.receipt;
      if (record.paneId !== paneId || receipt === undefined) continue;
      if (session !== undefined && record.session !== session) continue;
      const row: RowDraft = { requestId: record.id, at: record.acceptedAt, mode: record.mode, outcome: receipt.outcome, keys: receipt.keys, gapsMs: receipt.gapsMs, harness: receipt.harness, version: receipt.version };
      if (receipt.reason !== undefined) row.reason = receipt.reason;
      if (receipt.queued === true) row.queued = true;
      // A refusal's line and the Surface words are stored to be read later: the list carries them.
      if (receipt.detail !== undefined) row.detail = receipt.detail;
      if (receipt.saw !== undefined) row.saw = receipt.saw;
      rows.push(row);
    }
    return rows;
  }

  /**
   * The program's own pane routes (Steer, Stop, a belt action, an answer on the program's card) write
   * through this, so they take the same lock as a send or an answer of the driver: one write per
   * conversation at a time. A write that meets the lock held is refused as busy before it leaves.
   * A Stop is the way out of a send that hangs, so it waits for the lock instead, up to the lock's own
   * time limit: a hung write lets go of the lock at that limit at the latest.
   */
  lockedWrites(adapter: Pick<MuxAdapter, "controlTurn" | "answerAsk">): Pick<MuxAdapter, "controlTurn" | "answerAsk"> {
    const control = adapter.controlTurn?.bind(adapter);
    const answer = adapter.answerAsk?.bind(adapter);
    const out: { -readonly [K in "controlTurn" | "answerAsk"]?: MuxAdapter[K] } = {};
    if (control !== undefined) {
      out.controlTurn = (paneId, request) =>
        this.underLock(paneId, request.requestId, () => control(paneId, request), (): MuxControlOutcome => ({ kind: "refused", detail: BUSY }), request.act === "abort" ? PROGRAM_LOCK_MS : 0);
    }
    if (answer !== undefined) {
      out.answerAsk = (paneId, request) => this.underLock(paneId, request.requestId, () => answer(paneId, request), () => muxRefused(BUSY));
    }
    return out;
  }

  private async underLock<T>(paneId: string, owner: string, work: () => Promise<T>, busy: () => T, waitMs = 0): Promise<T> {
    const lockKey = `${this.deps.session}\u0000${paneId}`;
    const { locks } = this.deps;
    const giveUp = this.now() + waitMs;
    while (!locks.acquire(lockKey, owner, this.now() + PROGRAM_LOCK_MS, this.now())) {
      // A lock past its own limit is free to take, so a wait as long as that limit always ends with the lock.
      if (this.now() > giveUp) return busy();
      await this.sleep(STOP_RETRY_MS);
    }
    try {
      return await work();
    } finally {
      locks.release(lockKey, owner);
    }
  }

  // ── Send ──

  /** One send request, start to receipt. Never throws for the program's state; every end is an answer. */
  async handle(request: SendRequest, target: SendTarget): Promise<SendAnswer> {
    if (request.mode === "prepare") {
      const surface = this.surfaceOf(target.paneId);
      return surface === undefined ? { offers: [], detail: PANE_GONE } : { surface, offers: [] };
    }
    const running = this.sending.get(request.id);
    if (running !== undefined) {
      await running;
      return this.handle(request, target);
    }
    const accepted = this.deps.store.accept({
      id: request.id,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: PROGRAM_GENERATION,
      surfaceRevision: request.revision ?? 0,
      mode: request.mode,
      text: request.text,
    });
    if (accepted.kind === "id_reused") {
      const receipt = this.sendReceipt(this.bareRun(request, accepted.record, target), { outcome: "refused", reason: "id_reused" });
      return { receipt, offers: [], detail: "This request id was already used for another text." };
    }
    if (accepted.kind === "replay" && (accepted.record.session !== target.session || accepted.record.paneId !== target.paneId)) {
      // The same id and text on another session or pane is not this send: nothing of that one is shown here.
      const receipt = this.sendReceipt(this.bareRun(request, accepted.record, target), { outcome: "refused", reason: "id_reused" });
      return { receipt, offers: [], detail: ID_ELSEWHERE };
    }
    if (accepted.kind === "replay") {
      const stored = accepted.record.receipt;
      if (stored !== undefined) return { receipt: stored, offers: [], replayed: true };
      // Unsettled and not running here: the bridge stopped while it ran. It ends unknown now.
      const run = this.bareRun(request, accepted.record, target);
      return this.settleSend(run, { outcome: "unknown", reason: "crash", detail: CRASHED }, true);
    }
    // Marked as running before the write starts, so an item that comes during the write finds it.
    const work = Promise.resolve().then(() => this.run(request, accepted.record, target));
    this.sending.set(request.id, work);
    try {
      return await work;
    } finally {
      this.sending.delete(request.id);
    }
  }

  private bareRun(request: SendRequest, record: SendRecord, target: SendTarget): SendRun {
    return { request, record, target, s0: null, s2: null, gaps: {} };
  }

  private async run(request: SendRequest, record: SendRecord, target: SendTarget): Promise<SendAnswer> {
    const run = this.bareRun(request, record, target);
    const lockKey = `${target.session}\u0000${target.paneId}`;
    const { locks } = this.deps;
    if (!locks.acquire(lockKey, record.id, record.acceptedAt + PROGRAM_LOCK_MS, this.now())) {
      return this.settleSend(run, { outcome: "refused", reason: "busy", detail: BUSY });
    }
    try {
      return this.settleSend(run, await this.write(run));
    } finally {
      locks.release(lockKey, record.id);
    }
  }

  /** The structured write in place of S0 to S2: read the state, name the turn, write once, read the answer. */
  private async write(run: SendRun): Promise<SendEnd> {
    const { request, target } = run;
    const started = this.now();
    const before = this.view(target.paneId);
    run.s0 = markOf(before);
    run.gaps.s0 = this.now() - started;
    if (request.mode !== "send" && request.mode !== "command") return { outcome: "refused", reason: "not_free", detail: NO_BOX };
    // A program's turn takes no steer through this driver (M69): its pane view never says `canSteer`.
    if (request.when === "steer") return { outcome: "refused", reason: "steer_unsupported", detail: NO_STEER };
    if (!before.ready) return { outcome: "refused", reason: "not_free", detail: NOT_READ };
    if (before.status === undefined) return { outcome: "refused", reason: "pane_gone", detail: PANE_GONE };
    if (before.asks.length > 0) return { outcome: "refused", reason: "not_free", detail: ASK_OPEN };
    const turn = turnOfStatus(before.status);
    if (turn === "unknown" || before.turnId === undefined || before.turnId === "") return { outcome: "refused", reason: "not_free", detail: NOT_READ };
    // The phone names the turn it saw by the Surface revision (ADR 0101). 0 names none.
    const seen = request.revision ?? 0;
    if (seen !== 0 && seen !== programRevision(before.turnId)) return { outcome: "refused", reason: "stale_surface", detail: TURN_MOVED };

    // The record says the write may have left before it leaves, so a crash after it reads as unknown.
    this.deps.store.markSubmitSent(request.id);
    const wrote = this.now();
    const control: ControlRequest = { act: "send", requestId: request.id, target: { kind: "turn", id: before.turnId }, text: request.text, steer: false };
    let outcome: MuxControlOutcome;
    try {
      outcome = await this.deps.port.controlTurn(target.paneId, control);
    } catch (err) {
      outcome = { kind: "unknown", detail: err instanceof Error ? err.message : String(err) };
    }
    run.gaps.write = this.now() - wrote;
    const after = this.view(target.paneId);
    run.s2 = markOf(after);
    switch (outcome.kind) {
      case "ok":
        // WIRE.md 7.4: a send with no steer during a turn waits for the next turn. The read after the
        // write decides: the turn the send named still runs, so the program keeps the text for after it.
        // A turn that ended during the write takes the text as a new turn, which is not queued.
        return turn === "running" && turnOfStatus(after.status) === "running" && after.turnId === before.turnId
          ? { outcome: "sent", queued: true, acknowledged: true, detail: QUEUED }
          : { outcome: "sent", acknowledged: true };
      case "stale":
        return { outcome: "refused", reason: "stale_surface", detail: TURN_MOVED };
      case "gone":
        return { outcome: "refused", reason: "pane_gone", detail: outcome.detail };
      case "unknown":
        return { outcome: "unknown", reason: "no_evidence", detail: NOT_ACKED };
      case "unsupported":
      case "refused":
      case "unreachable":
        return { outcome: "refused", reason: "write_failed", detail: outcome.detail };
    }
  }

  private sendReceipt(run: SendRun, end: SendEnd): SendReceipt {
    const { record, target } = run;
    const receipt: SendReceiptDraft = {
      requestId: record.id,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: record.paneGeneration,
      harness: target.harness,
      version: null,
      profileId: null,
      profileStatus: null,
      textHash: record.textHash,
      textLength: record.textLength,
      s0: run.s0,
      s1: null,
      s2: run.s2,
      gapsMs: { ...run.gaps },
      keys: [],
      outcome: end.outcome,
    };
    if (end.reason !== undefined) receipt.reason = end.reason;
    if (end.queued === true) receipt.queued = true;
    if (end.acknowledged === true) receipt.acknowledged = record.id;
    return receipt;
  }

  private settleSend(run: SendRun, given: SendEnd, replayed = false): SendAnswer {
    // The program's item came in while the write ran: a `sent` or `unknown` end is `effective` now.
    const early = this.early.delete(run.record.id);
    const end: SendEnd = early && (given.outcome === "sent" || given.outcome === "unknown") ? effectiveEnd(given) : given;
    const receipt = this.sendReceipt(run, end);
    this.deps.store.settle(run.record.id, receipt);
    try {
      this.deps.ledger?.send(PROGRAM_COUNTER_KEY, { outcome: receipt.outcome, reason: receipt.reason, probed: false });
    } catch (err) {
      console.warn(`[send] program count failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // No offer is a key or a box: a program pane has neither. The person reads the chat and decides.
    let answer: SendAnswer = { receipt, offers: offersFor(receipt.outcome, receipt.reason, false).filter((offer) => offer !== "keys" && offer !== "submit" && offer !== "discard") };
    if (end.detail !== undefined) answer = { ...answer, detail: end.detail };
    if (replayed) answer = { ...answer, replayed: true };
    const surface = this.surfaceOf(run.target.paneId);
    return surface === undefined || receipt.outcome === "sent" || receipt.outcome === "effective" ? answer : { ...answer, surface };
  }

  // ── Ask ──

  /** One answer to a program ask, start to receipt. Never throws for the program's state; every end is a reply. */
  async answer(answer: Answer, target: SendTarget): Promise<AskReply> {
    const running = this.answering.get(answer.askId);
    if (running !== undefined) {
      await running;
      return this.answer(answer, target);
    }
    const entry = this.book.entry(answer.askId);
    const stored = this.deps.store.getAsk(answer.askId);
    if (stored === null && (entry === undefined || entry.paneId !== target.paneId)) {
      // Never minted here, or forgotten after a restart: nothing is stored under an id the bridge does not know.
      return this.askReply(answer, target, entry ?? null, { outcome: "refused", reason: "ask_unknown", detail: "Collie does not know this question. The card shows the question open now.", ask: this.liveAsk(target.paneId) }, null, false);
    }
    const accepted = this.deps.store.acceptAsk({ id: answer.askId, session: target.session, paneId: target.paneId, paneGeneration: PROGRAM_GENERATION, hash: answer.hash, optionId: answer.optionId });
    if (accepted.kind === "answered") {
      return this.askReply(answer, target, entry ?? null, { outcome: "refused", reason: "ask_answered", detail: "This question was answered with another option.", ask: this.liveAsk(target.paneId) }, null, false);
    }
    if (accepted.kind === "replay") {
      const kept = accepted.record.receipt;
      if (kept !== undefined) return { receipt: kept, replayed: true };
      return this.settleAsk(answer, target, accepted.record, entry ?? null, { outcome: "unknown", reason: "crash", detail: ASK_CRASHED }, null, true);
    }
    if (entry !== undefined) this.book.spend(answer.askId);
    const work = this.runAnswer(answer, target, accepted.record, entry ?? null);
    this.answering.set(answer.askId, work);
    try {
      return await work;
    } finally {
      this.answering.delete(answer.askId);
    }
  }

  /** The ask the pane shows now, published so it carries its own id. */
  private liveAsk(paneId: string): Ask | null {
    const surface = this.surfaceOf(paneId);
    return surface === undefined ? null : askOf(surface.modal);
  }

  private async runAnswer(answer: Answer, target: SendTarget, record: AskRecord, entry: ProgramAskEntry | null): Promise<AskReply> {
    const lockKey = `${target.session}\u0000${target.paneId}`;
    const { locks } = this.deps;
    if (!locks.acquire(lockKey, record.id, record.acceptedAt + PROGRAM_LOCK_MS, this.now())) {
      return this.settleAsk(answer, target, record, entry, { outcome: "refused", reason: "busy", detail: BUSY }, null);
    }
    try {
      const view = this.view(target.paneId);
      return this.settleAsk(answer, target, record, entry, await this.answerOnce(answer, target, entry, view), view);
    } finally {
      locks.release(lockKey, record.id);
    }
  }

  /** The check and the one answer: the hash against the ask the program lists now, then the program's own channel. */
  private async answerOnce(answer: Answer, target: SendTarget, entry: ProgramAskEntry | null, view: ProgramView): Promise<AskEnd> {
    if (entry === null || entry.state === "voided") return { outcome: "refused", reason: "ask_gone", detail: "The question is closed.", ask: this.liveAsk(target.paneId) };
    if (!view.ready || view.status === undefined) return { outcome: "refused", reason: "pane_gone", detail: view.ready ? PANE_GONE : NOT_READ };
    const listed = view.asks.find((ask) => ask.id === entry.programAskId);
    if (listed === undefined) return { outcome: "refused", reason: "ask_gone", detail: "The question is closed.", ask: this.liveAsk(target.paneId) };
    const now = contractAsk(listed);
    if (answer.hash !== entry.ask.hash || listed.revision !== entry.revision || now === null || now.hash !== entry.ask.hash) {
      return { outcome: "refused", reason: "ask_changed", detail: "The question changed after you looked. The card shows it as it is now.", ask: this.liveAsk(target.paneId) };
    }
    const index = Number.parseInt(answer.optionId, 10) - 1;
    const optionId = entry.optionIds[index];
    if (optionId === undefined) return { outcome: "refused", reason: "no_plan", detail: "This question has no such option." };
    let result: MuxOutcome<MuxAnswerResult>;
    try {
      result = await this.deps.port.answerAsk(target.paneId, { requestId: answer.askId, askId: entry.programAskId, revision: entry.revision, optionId });
    } catch (err) {
      result = { ok: true, value: { kind: "unknown", detail: err instanceof Error ? err.message : String(err) } };
    }
    if (!result.ok) {
      if (result.reason === "gone") return { outcome: "refused", reason: "pane_gone", detail: result.detail };
      // It left and was not confirmed: it may have landed, never "failed" (MuxRefusal, `unconfirmed`).
      if (result.reason === "unconfirmed") return { outcome: "unknown", reason: "no_evidence", detail: ASK_NOT_ACKED };
      return { outcome: "refused", reason: "write_failed", detail: result.detail };
    }
    const said = result.value;
    switch (said.kind) {
      case "taken":
        return { outcome: "sent" };
      case "too-late":
        return said.decided?.by === "phone"
          ? { outcome: "refused", reason: "ask_answered", detail: "Another tap answered this question first." }
          : { outcome: "refused", reason: "ask_gone", detail: "The question closed before the answer reached the durable agent." };
      case "stale":
        return { outcome: "refused", reason: "ask_changed", detail: "The question changed after you looked. The card shows it as it is now.", ask: said.ask === null ? this.liveAsk(target.paneId) : this.book.publish(target.paneId, said.ask) };
      case "unknown":
        return { outcome: "unknown", reason: "no_evidence", detail: ASK_NOT_ACKED };
    }
  }

  private askReceipt(answer: Answer, target: SendTarget, entry: ProgramAskEntry | null, end: AskEnd, check: ProgramView | null): AskReceipt {
    const receipt: AskReceiptDraft = {
      askId: answer.askId,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: PROGRAM_GENERATION,
      harness: target.harness,
      kind: entry?.ask.kind ?? "permission",
      hash: entry?.ask.hash ?? answer.hash,
      optionId: answer.optionId,
      origin: "person_tap",
      check: check === null ? null : markOf(check),
      readBack: null,
      after: null,
      keys: [],
      outcome: end.outcome,
      channel: "program",
    };
    if (end.reason !== undefined) receipt.reason = end.reason;
    return receipt;
  }

  /** A reply that stores nothing: a refusal of an id the bridge never minted, or one already spent. */
  private askReply(answer: Answer, target: SendTarget, entry: ProgramAskEntry | null, end: AskEnd, check: ProgramView | null, replayed: boolean): AskReply {
    let reply: AskReply = { receipt: this.askReceipt(answer, target, entry, end, check) };
    if (end.detail !== undefined) reply = { ...reply, detail: end.detail };
    if (end.ask !== undefined && end.ask !== null) reply = { ...reply, ask: end.ask };
    if (replayed) reply = { ...reply, replayed: true };
    return reply;
  }

  private settleAsk(answer: Answer, target: SendTarget, record: AskRecord, entry: ProgramAskEntry | null, end: AskEnd, check: ProgramView | null, replayed = false): AskReply {
    const reply = this.askReply(answer, target, entry, end, check, replayed);
    // Not counted: a terminal answer is not counted either (spec 09 counts reads and sends).
    if (reply.receipt !== undefined) this.deps.store.settleAsk(record.id, reply.receipt);
    return reply;
  }
}
