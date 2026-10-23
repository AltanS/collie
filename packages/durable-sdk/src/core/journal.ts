// The journal of a host with no process of its own: the facts that are not in any other log (asks, their answers,
// request ids), as one append-only list of records, and the pure fold that reads them back. A host that rebuilds its
// state from a durable log on every request appends these records to a stream and folds the stream into the core's
// seams (`Pane.seedAsk`, `Pane.seedDecided`, `ReceiptStore.claim`). The memory path of the core never writes one.
// WIRE.md appendix "A host with no process" describes the schema for the durable-harness host.
// No runtime import, like the rest of core/.

import { isRecord, isSafeInteger, isText } from "./rules.ts";
import type { Answer, Ask, AskOutcome, Json, JsonObject } from "./types.ts";

/** An ask was raised. The first record for an ask id fixes its text, its options and its `expiresAt`. */
export interface JournalAsk {
  t: "ask";
  askId: string;
  /** The tool call the ask stands for. The same across a rerun. */
  toolCallId: string;
  /** A hash of the call's arguments, so a rerun that asks about other arguments is told apart. */
  argsHash: string;
  /** The ask as the wire shows it, with its arguments already redacted by the ask policy. */
  ask: Ask;
  /** ISO 8601. */
  openedAt: string;
  /** ISO 8601, the same as `ask.expiresAt`. Absent: the ask does not expire. */
  expiresAt?: string;
}

/** The phone answered. Whether it won is decided by the order of the stream, not by the record. */
export interface JournalAnswer {
  t: "answer";
  askId: string;
  /** The revision the phone saw. */
  revision: number;
  answer: Answer;
  /** The request id the answer came with. */
  requestId: string;
  /** Minted per attempt: the writer reads the stream back and compares it to the winner to know it won. */
  nonce: string;
  /** ISO 8601. */
  at: string;
}

/** An ask closed with no answer from the phone: the clock passed `expiresAt`, or the turn was stopped. */
export interface JournalExpire {
  t: "expire";
  askId: string;
  /** ISO 8601. */
  at: string;
  /** Who closed it. Absent reads as `timeout`. A stop of the turn writes `program`. */
  decidedBy?: "timeout" | "program";
}

/**
 * The memory of one request id. `pending` is written before the act, `done` after it. `failed` is written after an act
 * that refused (a stale turn, a bad option): the request id is free again, as the memory path keeps no failure.
 */
export interface JournalReceipt {
  t: "receipt";
  phase: "pending" | "done" | "failed";
  /** The receipt group: the pane id, or one of the named groups. */
  group: string;
  requestId: string;
  digest: string;
  /** Only a `done` carries the reply. */
  reply?: object;
  /**
   * Minted per `pending`, so two writers that append a `pending` for one request id at once can read the stream back and
   * tell whose stands. A `done` or `failed` carries the nonce of the `pending` it closes. Optional: a record without one
   * folds as before.
   */
  nonce?: string;
  /** ISO 8601. */
  at: string;
}

export type JournalRecord = JournalAsk | JournalAnswer | JournalExpire | JournalReceipt;

/** An ask the fold found open: its record without the tag, ready for `Pane.seedAsk`. */
export type SeededAsk = Omit<JournalAsk, "t">;

/** What the fold keeps of a receipt: the record without the tag. */
export type FoldedReceipt = Omit<JournalReceipt, "t">;

/** The result of {@link foldJournal}. */
export interface FoldedJournal {
  /** The asks no terminal record has closed, in the order of their `ask` records. */
  open: SeededAsk[];
  /** The first outcome of every ask a terminal record closed, in the order of those records. Ready for `Pane.seedDecided`. */
  decided: Map<string, AskOutcome>;
  /** The terminal record that won each decided ask, so a writer can tell whether its own record is the one that stands. */
  winners: Map<string, JournalAnswer | JournalExpire>;
  /** The request ids: `done` once a `done` record closed the `pending`, else `pending`. */
  receipts: Map<string, FoldedReceipt>;
}

/** Is this a terminal record: one that closes an ask? */
export const isTerminal = (r: JournalRecord): r is JournalAnswer | JournalExpire => r.t === "answer" || r.t === "expire";

/**
 * Fold a journal, in stream order, into the state it describes. Pure: the same records give the same result on every
 * instance.
 *
 * - The first `ask` record of an id stands. A later one is ignored.
 * - The first terminal record (`answer` or `expire`) of an id wins, whatever its `revision`. A later one is ignored.
 * - An `ask` that comes after a terminal record of its id is ignored: the ask is decided and never opens.
 * - A `receipt` with `phase: "done"` closes the `pending` of its request id, when the digest is the same. The first
 *   `pending` of an id stands; a `done` stands once, and a `pending` after it is ignored.
 * - A `receipt` with `phase: "failed"` takes the standing `pending` of its id away, when the nonce is the same: the act
 *   refused, and the next `pending` of the id stands as if it were the first.
 */
export function foldJournal(records: readonly JournalRecord[]): FoldedJournal {
  const asks = new Map<string, JournalAsk>();
  const winners = new Map<string, JournalAnswer | JournalExpire>();
  const receipts = new Map<string, FoldedReceipt>();
  const decidedAsks = new Set<string>();
  const openOrder: string[] = [];
  for (const r of records) {
    if (r.t === "ask") {
      if (asks.has(r.askId)) continue;
      asks.set(r.askId, r);
      // An ask after its own terminal record never opens, but its options still tell the outcome's effect.
      if (!winners.has(r.askId)) openOrder.push(r.askId);
    } else if (isTerminal(r)) {
      if (winners.has(r.askId)) continue;
      winners.set(r.askId, r);
      decidedAsks.add(r.askId);
    } else {
      foldReceipt(receipts, r);
    }
  }
  const open: SeededAsk[] = [];
  for (const id of openOrder) {
    const { t: _t, ...ask } = asks.get(id)!;
    if (!decidedAsks.has(id)) open.push(ask);
  }
  const decided = new Map<string, AskOutcome>();
  for (const [id, record] of winners) decided.set(id, outcomeOf(record, asks.get(id)));
  return { open, decided, winners, receipts };
}

function foldReceipt(receipts: Map<string, FoldedReceipt>, r: JournalReceipt) {
  const { t: _t, ...entry } = r;
  const have = receipts.get(r.requestId);
  if (r.phase === "failed") {
    // Only the writer of the standing `pending` can free it: a `failed` with another nonce changes nothing.
    if (have?.phase === "pending" && have.nonce !== undefined && have.nonce === r.nonce) receipts.delete(r.requestId);
    return;
  }
  if (have === undefined) {
    receipts.set(r.requestId, entry);
    return;
  }
  // Only a `done` of the same digest closes a `pending`. Anything after a `done`, or a second `pending`, is ignored.
  if (have.phase === "pending" && r.phase === "done" && have.digest === r.digest) receipts.set(r.requestId, entry);
}

/** The receipt of a decision (WIRE.md 7.3), as the memory path would have written it when it closed the ask. */
function outcomeOf(record: JournalAnswer | JournalExpire, ask: JournalAsk | undefined): AskOutcome {
  if (record.t === "expire") return { decidedBy: record.decidedBy ?? "timeout", decidedAt: record.at };
  const outcome: AskOutcome = { decidedBy: "phone", decidedAt: record.at };
  const answer = record.answer;
  if ("optionId" in answer) {
    outcome.optionId = answer.optionId;
    const effect = ask?.ask.options.find((o) => o.id === answer.optionId)?.effect;
    if (effect !== undefined) outcome.effect = effect;
  }
  return outcome;
}

const TAGS: ReadonlySet<string> = new Set(["ask", "answer", "expire", "receipt"]);
const PHASES: ReadonlySet<string> = new Set(["pending", "done", "failed"]);

/** Does a parsed line carry the fields its tag needs? The fold reads these and nothing else. */
function isJournalRecord(v: JsonObject): v is JsonObject & JournalRecord {
  if (!isText(v.t) || !TAGS.has(v.t)) return false;
  if (v.t === "receipt") return isText(v.phase) && PHASES.has(v.phase) && isText(v.requestId) && isText(v.digest) && isText(v.group);
  if (!isText(v.askId)) return false;
  if (v.t === "ask") return isText(v.toolCallId) && isText(v.argsHash) && isRecord(v.ask) && isText(v.openedAt);
  if (v.t === "answer") return isSafeInteger(v.revision) && isRecord(v.answer) && isText(v.requestId) && isText(v.nonce) && isText(v.at);
  return isText(v.at);
}

/**
 * The records of a journal from its text: one JSON object per line. A reader splits on newlines, never on the chunks
 * the text came in, and drops a line it cannot parse or whose fields do not fit its tag (WIRE.md appendix A.2), so one
 * bad line costs that line and nothing else.
 */
export function parseJournal(text: string): JournalRecord[] {
  const records: JournalRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: Json;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (isRecord(value) && isJournalRecord(value)) records.push(value);
  }
  return records;
}
