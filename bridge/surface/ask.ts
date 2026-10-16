// Ask v1 (M56 spec 08; the contract is in the M56 README, "Ask", and
// experiments/reader-stability/ARCHITECTURE.md section 3). Every dialog the phone can answer is an
// `Ask` with a single-use id and a content hash. Two parts:
//
//  - `AskBook`: the bridge mints an ask when a read lifts a dialog. The id is bound to the ask's
//    content hash, the pane generation and the literal text of the lifted block, never to the read
//    revision: Herdr reads every pane at revision 0. The same dialog on the same pane keeps its id
//    across polls until the id is spent (answered) or voided (replaced, or gone from the screen past
//    the profile's ask lifetime); after that the same screen gets a new id.
//  - `AskAnswerer`: `POST /api/ask/<id>`. The answer is written to disk before any key. The bridge
//    reads the screen again, lifts the dialog again and requires the same binding; else it refuses
//    `ask_changed`, publishes the new ask with a new id, and the old tap sends nothing. Walk, read
//    back, commit (ADR 0080 stays): the arrows through the key gate, then a read that shows the
//    pointer on the chosen option with the same label, then the commit keys through the gate on that
//    read's revision. A mismatch refuses `ask_mismatch` with no Enter.
//
// Every key leaves through the key gate (key-gate.ts) on a token with origin `person_tap`: the answer
// is a person's tap, bound to the read the bridge checked it on. Receipts go to the same store as the
// send receipts (requests.ts). No harness name lives here (no-harness-names.test.ts scans this folder).

import { randomUUID } from "node:crypto";
import type { MuxGrid, MuxGridRequest, MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { DIALOG_CONTRACT, dialogModelOf } from "../../web/src/lib/harness/dialog-contract.ts";
import { commitKeysFor, splitWalk } from "../../web/src/lib/harness/prompt-model.ts";
import type { AskReason, AskReceipt, AskReply, Answer, AskOutcome } from "../../web/src/lib/surface/ask.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { rowText } from "../../web/src/lib/surface/frame.ts";
import { askOfLift, liftDialog, readerBlocks, type LiftedDialog } from "../../web/src/lib/surface/lift.ts";
import type { ProfileMatch } from "../../web/src/lib/surface/profile.ts";
import type { ReadMark } from "../../web/src/lib/surface/send.ts";
import { askOf, shortHash, type Ask, type Surface } from "../../web/src/lib/surface/surface.ts";
import type { KeyGate } from "./key-gate.ts";
import type { RowRing, SessionLocks } from "./protocol.ts";
import type { AskRecord, RequestStore } from "./requests.ts";

/** An ask's lifetime when its profile names none: older than this and off the screen, it is voided. */
export const ASK_LIFETIME_MS = 5000;

/** The answer's step bounds, written as (max reads, max ms). */
export const ASK_BOUNDS = {
  check: { reads: 1, ms: 1200 },
  readBack: { reads: 4, ms: 1500 },
  after: { reads: 6, ms: 3000 },
} as const;

/** The pane lock an answer holds at most: the sum of its step bounds. */
export const ASK_LOCK_MS = ASK_BOUNDS.check.ms + ASK_BOUNDS.readBack.ms + ASK_BOUNDS.after.ms;

/** Rows one answer read asks for, as the Send Protocol reads them. */
const ASK_READ_LINES = 120;
/** The gap before the first poll of a step; each later gap doubles. */
const FIRST_GAP_MS = 80;
/** How many ids the book remembers, newest kept. An id it forgot answers `ask_unknown`. */
const BOOK_SIZE = 512;

/** The binding an ask id is minted for: the pane generation, the content hash and the block's literal text. */
export function askBinding(generation: string, dialog: LiftedDialog): string {
  return shortHash(`${generation}\n${dialog.hash}\n${dialog.region}`);
}

/** The lifetime an ask on this harness gets: its profile's, else the default. */
export function askLifetimeOf(match: ProfileMatch | null): number {
  return match?.profile.ask?.lifetimeMs ?? ASK_LIFETIME_MS;
}

type EntryState = "live" | "spent" | "voided";

/** One minted ask and what it is bound to. */
export interface AskEntry {
  readonly ask: Ask;
  readonly paneId: string;
  readonly generation: string;
  readonly binding: string;
  readonly mintedAt: number;
  readonly lifetimeMs: number;
  state: EntryState;
}

/**
 * The bridge's single-use ask ids, one book per session. The poll's Surface, the Send Protocol's reads
 * and the answerer all lift through it, so the id on the phone is the id the answer route knows.
 */
export class AskBook {
  private readonly byId = new Map<string, AskEntry>();
  private readonly current = new Map<string, string>();
  private serial = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    /** Random per book, so a restart never mints an id a stored receipt already holds. */
    private readonly salt: string = randomUUID(),
  ) {}

  /**
   * One read of a pane lifted `dialog` (or nothing): the ask with its id. The same binding on a live
   * entry keeps the id; any other dialog voids the live entry and mints a new id; a spent or voided
   * entry never comes back. With nothing lifted, a live ask older than its lifetime is voided; a
   * younger one is kept, since one read can miss a dialog that is still up.
   */
  publish(paneId: string, generation: string, dialog: LiftedDialog | null, lifetimeMs: number = ASK_LIFETIME_MS): Ask | null {
    const now = this.now();
    const live = this.liveEntry(paneId);
    if (dialog === null) {
      if (live !== null && now - live.mintedAt > live.lifetimeMs) live.state = "voided";
      return null;
    }
    const binding = askBinding(generation, dialog);
    if (live !== null && live.binding === binding) return live.ask;
    if (live !== null) live.state = "voided";
    this.serial++;
    const id = `ask-${shortHash(`${this.salt}\n${String(this.serial)}\n${binding}`)}`;
    const entry: AskEntry = { ask: askOfLift(dialog, id), paneId, generation, binding, mintedAt: now, lifetimeMs, state: "live" };
    this.byId.set(id, entry);
    this.current.set(paneId, id);
    while (this.byId.size > BOOK_SIZE) {
      const oldest = this.byId.keys().next().value;
      if (oldest === undefined) break;
      this.byId.delete(oldest);
    }
    return entry.ask;
  }

  /** The entry an id names, or undefined when the book never minted it or forgot it. */
  entry(id: string): AskEntry | undefined {
    return this.byId.get(id);
  }

  /** The pane's live ask, or null. */
  currentAsk(paneId: string): Ask | null {
    return this.liveEntry(paneId)?.ask ?? null;
  }

  private liveEntry(paneId: string): AskEntry | null {
    const id = this.current.get(paneId);
    const entry = id === undefined ? undefined : this.byId.get(id);
    return entry !== undefined && entry.state === "live" ? entry : null;
  }

  /** An answer took the id: it is never live again. */
  spend(id: string): void {
    const entry = this.byId.get(id);
    if (entry !== undefined && entry.state === "live") entry.state = "spent";
  }

  /** The id's dialog is gone or replaced. */
  void(id: string): void {
    const entry = this.byId.get(id);
    if (entry !== undefined && entry.state !== "spent") entry.state = "voided";
  }
}

// ── Plans ──────────────────────────────────────────────────────────────────────────────────────

/** How one option is answered: the walk's arrows (maybe none), then the commit keys. */
export interface AskPlan {
  readonly walk: readonly string[];
  readonly commit: readonly string[];
  readonly label: string;
}

/**
 * The keys of option `index` on the lifted dialog, or null when the bridge does not send it: a dialog
 * whose text field has focus (keys would be typed into it), and the kinds whose answer is a multi-step
 * flow (the preview note, the multi-select toggles and Submit walk), which keep their guarded path on
 * the phone. A plan is the option's own keys as the grammar built them (ADR 0080 point 5): a walk
 * splits into arrows and the commit; a pointed row's commit is the contract's `commitKeysFor`.
 */
export function planFor(dialog: LiftedDialog, index: number): AskPlan | null {
  const block = dialog.block;
  switch (dialog.blockKind) {
    case "prompt-select": {
      const m = dialogModelOf(block, "prompt-select");
      const option = m?.options[index];
      if (m === null || m === undefined || option === undefined || m.feedback?.focused === true) return null;
      const split = splitWalk(option.keys);
      if (split === null) return { walk: [], commit: option.keys, label: option.label };
      return { walk: split.walk, commit: commitKeysFor(m, index), label: option.label };
    }
    case "wizard": {
      const m = dialogModelOf(block, "wizard");
      if (m === null || m.phase !== "question") return null;
      const option = m.options[index];
      if (option === undefined) return null;
      const split = splitWalk(option.keys);
      return split === null ? { walk: [], commit: option.keys, label: option.label } : { walk: split.walk, commit: split.commit, label: option.label };
    }
    case "menu": {
      const m = dialogModelOf(block, "menu");
      const action = m?.actions[index];
      if (action === undefined || action.keys.length === 0) return null;
      return { walk: [], commit: action.keys, label: action.label };
    }
    case "preview-select":
    case "multi-select":
    case "unread-dialog":
      return null;
  }
}

/** Whether two lifts are the same dialog, by the contract's identity (the pointer may have moved). */
export function sameDialog(a: LiftedDialog, b: LiftedDialog): boolean {
  if (a.blockKind !== b.blockKind) return false;
  switch (a.blockKind) {
    case "prompt-select": {
      const [x, y] = [dialogModelOf(a.block, "prompt-select"), dialogModelOf(b.block, "prompt-select")];
      return x !== null && y !== null && DIALOG_CONTRACT["prompt-select"].identity(x, y);
    }
    case "wizard": {
      const [x, y] = [dialogModelOf(a.block, "wizard"), dialogModelOf(b.block, "wizard")];
      return x !== null && y !== null && DIALOG_CONTRACT.wizard.identity(x, y);
    }
    case "menu": {
      const [x, y] = [dialogModelOf(a.block, "menu"), dialogModelOf(b.block, "menu")];
      return x !== null && y !== null && DIALOG_CONTRACT.menu.identity(x, y);
    }
    case "preview-select": {
      const [x, y] = [dialogModelOf(a.block, "preview-select"), dialogModelOf(b.block, "preview-select")];
      return x !== null && y !== null && DIALOG_CONTRACT["preview-select"].identity(x, y);
    }
    case "multi-select": {
      const [x, y] = [dialogModelOf(a.block, "multi-select"), dialogModelOf(b.block, "multi-select")];
      return x !== null && y !== null && DIALOG_CONTRACT["multi-select"].identity(x, y);
    }
    case "unread-dialog":
      return false;
  }
}

/**
 * The read back: the highlighted row is option `index` with the chosen label, which the grammar
 * says by giving that row a plan with no walk left (the pointer stands on it, ADR 0080).
 */
export function pointerOn(dialog: LiftedDialog, index: number, label: string): boolean {
  const options =
    dialog.blockKind === "prompt-select"
      ? dialogModelOf(dialog.block, "prompt-select")?.options
      : dialog.blockKind === "wizard"
        ? (() => {
            const m = dialogModelOf(dialog.block, "wizard");
            return m !== null && m.phase === "question" ? m.options : undefined;
          })()
        : undefined;
  const option = options?.[index];
  if (option === undefined || option.label !== label) return false;
  const split = splitWalk(option.keys);
  return split !== null && split.walk.length === 0;
}

// ── The answer ─────────────────────────────────────────────────────────────────────────────────

/** What the answerer needs of a multiplexer besides keys (which only the gate sends). */
export interface AskMux {
  readGrid(paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>>;
}

/** The pane an answer is for, as the bridge's own snapshot names it. */
export interface AskTarget {
  readonly session: string;
  readonly paneId: string;
  readonly harness: string;
}

export interface AskDeps {
  readonly mux: AskMux;
  readonly gate: KeyGate;
  readonly store: RequestStore;
  readonly locks: SessionLocks;
  readonly book: AskBook;
  readonly ring?: RowRing;
  readonly profile: (harness: string) => Promise<ProfileMatch | null>;
  readonly generation: (paneId: string) => string | null;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** One read as the answerer sees it. */
interface AskSnap {
  readonly revision: number;
  readonly gateRevision: number;
  readonly hash: string;
  readonly dialog: LiftedDialog | null;
  readonly surface: Surface;
}

interface AskRun {
  readonly answer: Answer;
  readonly target: AskTarget;
  readonly record: AskRecord;
  readonly entry: AskEntry | undefined;
  readonly match: ProfileMatch | null;
  readonly lockKey: string;
  readonly deadline: number;
  readonly marks: { check: AskSnap | null; readBack: AskSnap | null; after: AskSnap | null };
  readonly keys: string[];
}

class AskEnded extends Error {
  constructor(
    readonly outcome: AskOutcome,
    readonly reason: AskReason | undefined,
    readonly extra: { detail?: string; snap?: AskSnap | null; ask?: Ask | null } = {},
  ) {
    super(`${outcome}${reason === undefined ? "" : `(${reason})`}`);
  }
}

function markOf(snap: AskSnap | null): ReadMark | null {
  return snap === null ? null : { revision: snap.revision, hash: snap.hash };
}

/** The sentence a refusal carries for the person, or undefined when the step names its own. */
function sentenceOf(reason: AskReason): string | undefined {
  switch (reason) {
    case "ask_unknown":
      return "Collie does not know this dialog any more. Check the screen and tap again.";
    case "ask_answered":
      return "This dialog was already answered with another choice.";
    case "ask_changed":
      return "The dialog changed since you looked. Nothing was sent; check the new one.";
    case "ask_gone":
      return "This dialog is gone from the screen. Nothing was sent.";
    case "ask_mismatch":
      return "The highlight did not reach your choice, so Enter was not sent.";
    case "no_plan":
      return "Collie does not answer this choice from here. Use the screen and the keys.";
    case "busy":
      return "Another send on this pane is still running.";
    case "pane_gone":
      return "The pane holds another program now, or cannot be read.";
    default:
      return undefined;
  }
}

export class AskAnswerer {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly inFlight = new Map<string, Promise<AskReply>>();

  constructor(private readonly deps: AskDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The receipt an answer that never settled gets after a restart (RequestStore.recoverAsks). */
  static crashReceipt(record: AskRecord): AskReceipt {
    return {
      askId: record.id,
      session: record.session,
      paneId: record.paneId,
      paneGeneration: record.paneGeneration,
      harness: "-",
      kind: "permission",
      hash: record.hash,
      optionId: record.optionId,
      origin: "person_tap",
      check: null,
      readBack: null,
      after: null,
      keys: [],
      outcome: "unknown",
      reason: "crash",
    };
  }

  /** One answer, start to receipt. Never throws for a pane's state; every end is a reply. */
  async handle(answer: Answer, target: AskTarget): Promise<AskReply> {
    const running = this.inFlight.get(answer.askId);
    if (running !== undefined) {
      await running;
      return this.handle(answer, target);
    }
    const entry = this.deps.book.entry(answer.askId);
    const stored = this.deps.store.getAsk(answer.askId);
    if (stored === null && (entry === undefined || entry.paneId !== target.paneId)) {
      // Never minted here (or forgotten after a restart): nothing is stored under an id the bridge
      // does not know. The pane's live ask, if any, rides along so the phone draws the new card.
      const ask = this.deps.book.currentAsk(target.paneId);
      const receipt = this.bareReceipt(answer, target, null, "-", "refused", "ask_unknown", []);
      return ask === null ? { receipt, detail: sentenceOf("ask_unknown")! } : { receipt, ask, detail: sentenceOf("ask_unknown")! };
    }
    const accepted = this.deps.store.acceptAsk({
      id: answer.askId,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: entry?.generation ?? stored?.paneGeneration ?? "-",
      hash: answer.hash,
      optionId: answer.optionId,
    });
    if (accepted.kind === "answered") {
      // The id is spent, so the phone must not tap it again: the dialog on the screen now, if any,
      // rides along under its own new id (a look, no key).
      const receipt = this.bareReceipt(answer, target, entry ?? null, accepted.record.paneGeneration, "refused", "ask_answered", []);
      const ask = await this.look(target, entry?.generation ?? accepted.record.paneGeneration);
      return ask === null ? { receipt, detail: sentenceOf("ask_answered")! } : { receipt, ask, detail: sentenceOf("ask_answered")! };
    }
    if (accepted.kind === "replay") {
      const kept = accepted.record.receipt;
      if (kept !== undefined) return { receipt: kept, replayed: true };
      // Unsettled and not running here: the bridge died while it ran. It ends unknown now.
      const receipt = { ...AskAnswerer.crashReceipt(accepted.record), harness: target.harness };
      this.deps.store.settleAsk(answer.askId, receipt);
      return { receipt, replayed: true, detail: "The bridge restarted during this answer, so Collie cannot say whether it went out. Check the screen." };
    }
    if (entry !== undefined) {
      if (entry.state === "voided") this.deps.book.void(answer.askId);
      else this.deps.book.spend(answer.askId);
    }
    const work = this.run(answer, target, accepted.record, entry);
    this.inFlight.set(answer.askId, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(answer.askId);
    }
  }

  private bareReceipt(answer: Answer, target: AskTarget, entry: AskEntry | null, generation: string, outcome: AskOutcome, reason: AskReason | undefined, keys: readonly string[]): AskReceipt {
    const base: AskReceipt = {
      askId: answer.askId,
      session: target.session,
      paneId: target.paneId,
      paneGeneration: entry?.generation ?? generation,
      harness: target.harness,
      kind: entry?.ask.kind ?? "permission",
      hash: entry?.ask.hash ?? answer.hash,
      optionId: answer.optionId,
      origin: "person_tap",
      check: null,
      readBack: null,
      after: null,
      keys: [...keys],
      outcome,
    };
    return reason === undefined ? base : { ...base, reason };
  }

  private async run(answer: Answer, target: AskTarget, record: AskRecord, entry: AskEntry | undefined): Promise<AskReply> {
    const match = await this.deps.profile(target.harness);
    const state: AskRun = {
      answer,
      target,
      record,
      entry,
      match,
      lockKey: `${target.session}\u0000${target.paneId}`,
      deadline: record.acceptedAt + ASK_LOCK_MS,
      marks: { check: null, readBack: null, after: null },
      keys: [],
    };
    const { locks } = this.deps;
    if (!locks.acquire(state.lockKey, record.id, state.deadline, this.now())) {
      return this.settle(state, new AskEnded("refused", "busy"));
    }
    try {
      await this.steps(state);
      return this.settle(state, new AskEnded("sent", undefined));
    } catch (err) {
      if (err instanceof AskEnded) return this.settle(state, err);
      throw err;
    } finally {
      locks.release(state.lockKey, record.id);
    }
  }

  private settle(state: AskRun, end: AskEnded): AskReply {
    const { answer, target, entry } = state;
    const base = this.bareReceipt(answer, target, entry ?? null, state.record.paneGeneration, end.outcome, end.reason, state.keys);
    const receipt: AskReceipt = { ...base, check: markOf(state.marks.check), readBack: markOf(state.marks.readBack), after: markOf(state.marks.after) };
    this.deps.store.settleAsk(answer.askId, receipt);
    let reply: AskReply = { receipt };
    const detail = end.extra.detail ?? (end.reason === undefined ? undefined : sentenceOf(end.reason));
    if (detail !== undefined) reply = { ...reply, detail };
    const snap = end.extra.snap ?? state.marks.after ?? state.marks.readBack ?? state.marks.check;
    if (snap !== null && snap !== undefined) reply = { ...reply, surface: snap.surface };
    if (end.extra.ask !== undefined && end.extra.ask !== null) reply = { ...reply, ask: end.extra.ask };
    return reply;
  }

  private generationOf(state: AskRun): string {
    return state.entry?.generation ?? state.record.paneGeneration;
  }

  // ── The steps ──

  private async steps(state: AskRun): Promise<void> {
    const { answer, entry, target } = state;
    if (entry === undefined || entry.state === "voided") throw new AskEnded("refused", "ask_gone");
    if (answer.hash !== entry.ask.hash) {
      // Not the dialog the id was minted for. The id is spent by now, so the reply carries the
      // screen's ask under a new id (a look, no key), or the phone would tap the spent id again.
      throw new AskEnded("refused", "ask_changed", { ask: await this.look(target, entry.generation) });
    }
    const index = entry.ask.options.findIndex((option) => option.id === answer.optionId);
    if (index < 0) throw new AskEnded("refused", "no_plan", { detail: "This dialog has no such option." });
    if (this.deps.generation(target.paneId) !== entry.generation) throw new AskEnded("refused", "pane_gone");

    // The check: a fresh read, the dialog lifted again, the same binding. Before any key.
    const check = await this.readOnce(state, "check", ASK_BOUNDS.check.ms, "refused");
    state.marks.check = check;
    if (check.dialog === null) {
      this.deps.book.void(answer.askId);
      throw new AskEnded("refused", "ask_gone");
    }
    if (askBinding(this.generationOf(state), check.dialog) !== entry.binding) {
      throw new AskEnded("refused", "ask_changed", { ask: askOf(check.surface.modal) });
    }
    const plan = planFor(check.dialog, index);
    if (plan === null || plan.label !== entry.ask.options[index]!.label) throw new AskEnded("refused", "no_plan");

    let bound = check;
    if (plan.walk.length > 0) {
      await this.keys(state, plan.walk, check, "walk");
      const back = await this.poll(state, "readBack", ASK_BOUNDS.readBack, (snap) => {
        if (snap.dialog === null) return "wait";
        if (!sameDialog(check.dialog!, snap.dialog)) return "fail";
        return pointerOn(snap.dialog, index, plan.label) ? "pass" : "wait";
      });
      state.marks.readBack = back.snap;
      if (back.verdict !== "pass" || back.snap === null) {
        throw new AskEnded("refused", "ask_mismatch", { snap: back.snap, ask: back.snap === null ? null : askOf(back.snap.surface.modal) });
      }
      bound = back.snap;
    } else {
      // No walk: the check read is the read the commit is bound to. A pointed row's plan has no walk
      // only while the pointer stands on it, so this read already shows the highlight on the option.
      state.marks.readBack = check;
    }

    await this.keys(state, plan.commit, bound, "commit");

    const after = await this.poll(state, "after", ASK_BOUNDS.after, (snap) => (snap.dialog === null || snap.dialog.hash !== bound.dialog!.hash ? "pass" : "wait"));
    state.marks.after = after.snap;
    if (after.verdict !== "pass") throw new AskEnded("unknown", "no_evidence", { detail: "The keys went out, but the dialog did not show it was answered." });
  }

  /**
   * The pane's live ask, or one read of the pane lifted and published when the book holds none (the
   * id just spent was the live one). Sends no key and takes no lock; a read that fails or runs past
   * the check's bound is null.
   */
  private async look(target: AskTarget, generation: string): Promise<Ask | null> {
    const live = this.deps.book.currentAsk(target.paneId);
    if (live !== null) return live;
    if (this.deps.generation(target.paneId) !== generation) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ASK_BOUNDS.check.ms);
    });
    try {
      const grid = await Promise.race([this.deps.mux.readGrid(target.paneId, { scope: "viewport", lines: ASK_READ_LINES, styling: "preserve" }), late]);
      if (grid === null || !grid.ok) return null;
      const dialog = liftDialog(readerBlocks(splitLines(parseAnsi(grid.value.text)), target.harness));
      const match = await this.deps.profile(target.harness);
      return this.deps.book.publish(target.paneId, generation, dialog, askLifetimeOf(match));
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private publish(state: AskRun, dialog: LiftedDialog | null): Ask | null {
    return this.deps.book.publish(state.target.paneId, this.generationOf(state), dialog, askLifetimeOf(state.match));
  }

  /**
   * Keys through the gate on a token minted on `snap`'s revision. A gate refusal sends nothing, so it
   * is `refused` (after a walk the arrows moved a highlight at most; nothing was committed). A commit
   * the multiplexer did not answer inside the bound may have gone out: `unknown`.
   */
  private async keys(state: AskRun, keys: readonly string[], snap: AskSnap, step: "walk" | "commit"): Promise<void> {
    this.guard(state, "refused");
    const { gate } = this.deps;
    const token = gate.mint(state.target.paneId, keys, snap.gateRevision, "person_tap");
    const result = await this.within(state, gate.commit(token), state.deadline, step === "commit" ? "unknown" : "refused");
    if (!result.ok) {
      const reason: AskReason = result.reason === "mux" ? "write_failed" : result.reason;
      const detail = result.reason === "mux" ? result.refusal.detail : result.detail;
      throw new AskEnded("refused", reason, { detail });
    }
    state.keys.push(...keys);
  }

  private guard(state: AskRun, outcome: "refused" | "unknown"): void {
    if (this.now() > state.deadline) throw new AskEnded(outcome, "bound", { detail: "The answer ran past its bound." });
  }

  private async within<T>(state: AskRun, work: Promise<T>, until: number, outcome: "refused" | "unknown"): Promise<T> {
    const left = Math.min(until, state.deadline) - this.now();
    const late = (): AskEnded => new AskEnded(outcome, "bound", { detail: "The multiplexer did not answer inside the bound." });
    if (left <= 0) throw late();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(late()), left);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /** One read of the pane, the dialog lifted and published, cut at the bound. */
  private async read(state: AskRun, step: string, until: number, outcome: "refused" | "unknown"): Promise<AskSnap | null> {
    this.guard(state, outcome);
    const { paneId, harness } = state.target;
    const grid = await this.within(state, this.deps.mux.readGrid(paneId, { scope: "viewport", lines: ASK_READ_LINES, styling: "preserve" }), until, outcome);
    const gateRevision = this.deps.gate.noteRead(paneId);
    if (!grid.ok) return null;
    const rows = splitLines(parseAnsi(grid.value.text));
    const texts = rows.map((row) => rowText(row).trimEnd());
    this.deps.ring?.push({ requestId: state.answer.askId, step, at: this.now(), rows: texts });
    const dialog = liftDialog(readerBlocks(rows, harness));
    // Every read publishes what it lifted, like the poll does. The id being answered is spent, so even
    // the same dialog gets a new id here: a tap after a refusal carries the id of the screen it saw.
    const ask = this.publish(state, dialog);
    const idle = state.match?.profile.idle ?? null;
    const { surface } = surfaceOfScreen({ seq: 0, source: "screen", at: this.now(), revision: grid.value.revision, rows, ask }, idle);
    return { revision: grid.value.revision, gateRevision, hash: shortHash(texts.join("\n")), dialog, surface };
  }

  private async readOnce(state: AskRun, step: string, ms: number, outcome: "refused" | "unknown"): Promise<AskSnap> {
    const snap = await this.read(state, step, this.now() + ms, outcome);
    if (snap === null) throw new AskEnded(outcome, "pane_gone");
    return snap;
  }

  /** Reads until the test passes or fails, inside the step's (reads, ms) bound. */
  private async poll(state: AskRun, step: string, bound: { reads: number; ms: number }, test: (snap: AskSnap) => "pass" | "wait" | "fail"): Promise<{ snap: AskSnap | null; verdict: "pass" | "wait" | "fail" }> {
    const until = Math.min(this.now() + bound.ms, state.deadline);
    let gap = FIRST_GAP_MS;
    let last: AskSnap | null = null;
    for (let reads = 0; reads < bound.reads; reads++) {
      const left = until - this.now();
      if (left <= 0) break;
      await this.sleep(Math.min(gap, left));
      gap *= 2;
      let snap: AskSnap | null;
      try {
        snap = await this.read(state, step, until, "unknown");
      } catch (err) {
        // The step's own bound cut the read short: the step ran out. The request's bound ends it.
        if (err instanceof AskEnded && this.now() <= state.deadline) break;
        throw err;
      }
      if (snap === null) continue;
      last = snap;
      const verdict = test(snap);
      if (verdict !== "wait") return { snap, verdict };
    }
    return { snap: last, verdict: "wait" };
  }
}
