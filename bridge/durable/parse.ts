// THE ONE FILE UNDER bridge/durable/ THAT READS AN UNVALIDATED FIELD (ADR 0100).
//
// Asks as data meet untrusted JSON in four places, and each is read here, so no feature module
// needs a `typeof`:
//
//   • the `POST /api/pane/:id/answer` body, the phone's claim (`readAnswerBody`);
//   • `<stateDir>/answer-receipts.json`, the answer receipts (`coerceAnswerReceipt`);
//   • `<stateDir>/durable-asks.json`, the push guard's memory (`readGuardFile`);
//   • the asks on a peer's pane, which the lead's merge passes through as the member listed them,
//     before the guard keys them (`keyableAsks`).
//
// Guarded controls (ADR 0101) add two more:
//
//   • the `POST /api/pane/:id/send` and `/abort` bodies (`readControlBody`);
//   • `<stateDir>/control-receipts.json`, their receipts (`coerceControlReceipt`).

import type { JsonObject, JsonValue } from "../json.ts";
import type { AnswerRequest, Ask, ControlRequest, ControlTarget } from "../types.ts";
import { isRequestId } from "../worktree-receipts.ts";
import type { AnswerReceipt, AnswerState } from "./answer.ts";
import type { ControlAct, ControlReceipt, ControlState } from "./control.ts";
import type { GuardAsk, GuardEntry } from "./guard.ts";

const STATES: ReadonlySet<string> = new Set(["pending", "unknown", "unsent", "taken", "too-late", "stale", "refused", "maybe-applied"]);

/** The longest note the route accepts, in UTF-16 units; the adapter checks the wire's byte cap. */
const NOTE_MAX_CHARS = 2048;

function isState(value: JsonValue | undefined): value is AnswerState {
  return typeof value === "string" && STATES.has(value);
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

function isText(value: JsonValue | undefined): value is string {
  return typeof value === "string";
}

/** A payload digest as a receipt keeps it: SHA-256, lowercase hex. A receipt without one is not read. */
export function isDigest(value: JsonValue | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isTime(value: JsonValue | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The answer body, checked. Every field is the phone's claim until this says otherwise. */
export function readAnswerBody(body: JsonValue | undefined): AnswerRequest | null {
  const fields = asRecord(body);
  if (fields === null) return null;
  const { requestId, askId, revision, optionId, note } = fields;
  if (!isRequestId(requestId)) return null;
  if (!isText(askId) || askId === "" || !isText(optionId) || optionId === "") return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) return null;
  if (note !== undefined && (!isText(note) || note.length > NOTE_MAX_CHARS)) return null;
  const request: AnswerRequest = { requestId, askId, revision, optionId };
  if (isText(note) && note !== "") request.note = note;
  return request;
}

/** The most text one send may carry, in UTF-8 bytes (WIRE.md section 6, `SendRequest.text`). */
export const SEND_TEXT_MAX_BYTES = 32768;

const CONTROL_STATES: ReadonlySet<string> = new Set(["pending", "unknown", "unsent", "ok", "stale", "refused", "maybe-applied"]);

function isControlState(value: JsonValue | undefined): value is ControlState {
  return typeof value === "string" && CONTROL_STATES.has(value);
}

/**
 * What a control names. Exactly one of `turnId` and `askId`, each a non-empty string; both, neither,
 * or a present field of another type is no name at all. The id rule is the adapter's to check.
 */
function readTarget(turnId: JsonValue | undefined, askId: JsonValue | undefined): ControlTarget | null {
  const namesTurn = turnId !== undefined;
  if (namesTurn === (askId !== undefined)) return null;
  if (namesTurn) return isText(turnId) && turnId !== "" ? { kind: "turn", id: turnId } : null;
  return isText(askId) && askId !== "" ? { kind: "ask", id: askId } : null;
}

/**
 * A send or abort body, checked (ADR 0101). Every field is the phone's claim until this says
 * otherwise. A send carries 1 to {@link SEND_TEXT_MAX_BYTES} bytes of text; an abort ignores any.
 */
export function readControlBody(act: ControlAct, body: JsonValue | undefined): ControlRequest | null {
  const fields = asRecord(body);
  if (fields === null) return null;
  const { requestId, turnId, askId, text, steer } = fields;
  if (!isRequestId(requestId)) return null;
  const target = readTarget(turnId, askId);
  if (target === null) return null;
  if (act === "abort") return { act, requestId, target };
  if (!isText(text) || text === "" || Buffer.byteLength(text, "utf8") > SEND_TEXT_MAX_BYTES) return null;
  if (steer !== undefined && typeof steer !== "boolean") return null;
  return { act, requestId, target, text, steer: steer === true };
}

/** One control receipt read off disk, or `null` when the entry is not one. */
export function coerceControlReceipt(raw: JsonValue): ControlReceipt | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { requestId, at, paneId, act, target, targetId, steer, digest, state, detail, reason, currentTurnId, currentAskIds } = r;
  if (!isRequestId(requestId) || !isTime(at) || !isText(paneId) || !isText(targetId) || !isDigest(digest)) return null;
  if (act !== "send" && act !== "abort") return null;
  if (target !== "turn" && target !== "ask") return null;
  if (!isControlState(state)) return null;
  const receipt: ControlReceipt = { requestId, at, paneId, act, target, targetId, digest, state };
  if (typeof steer === "boolean") receipt.steer = steer;
  if (isText(detail)) receipt.detail = detail;
  if (reason === "unsupported" || reason === "refused") receipt.reason = reason;
  if (isText(currentTurnId)) receipt.currentTurnId = currentTurnId;
  if (Array.isArray(currentAskIds)) receipt.currentAskIds = currentAskIds.filter(isText);
  return receipt;
}

/** One answer receipt read off disk, or `null` when the entry is not one. */
export function coerceAnswerReceipt(raw: JsonValue): AnswerReceipt | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { requestId, at, paneId, askId, revision, optionId, digest, state, detail, reason } = r;
  if (!isRequestId(requestId) || !isState(state) || !isTime(at)) return null;
  if (!isText(paneId) || !isText(askId) || !isText(optionId) || !isDigest(digest)) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision)) return null;
  const receipt: AnswerReceipt = { requestId, at, paneId, askId, revision, optionId, digest, state };
  if (isText(detail)) receipt.detail = detail;
  if (reason === "unsupported" || reason === "refused") receipt.reason = reason;
  return receipt;
}

function readGuardEntry(value: JsonValue): GuardEntry | null {
  const r = asRecord(value);
  if (r === null) return null;
  const { host, toolCallId, paneId, askId, firstSeenAt, pushedAt, closedAt } = r;
  if (!isText(host) || !isText(toolCallId) || toolCallId === "" || !isText(paneId) || !isText(askId)) return null;
  if (!isTime(firstSeenAt)) return null;
  if ((pushedAt !== undefined && !isTime(pushedAt)) || (closedAt !== undefined && !isTime(closedAt))) return null;
  let entry: GuardEntry = { host, toolCallId, paneId, askId, firstSeenAt };
  if (isTime(pushedAt)) entry = { ...entry, pushedAt };
  if (isTime(closedAt)) entry = { ...entry, closedAt };
  return entry;
}

/** What the push guard's file holds: its keys, and per host the time its breaker tripped. */
export interface GuardFile {
  readonly entries: GuardEntry[];
  readonly breakers: [string, number][];
}

/**
 * The push guard's file, `{ "entries": [...], "breakers": [{ "host", "trippedAt" }] }`. Anything else
 * is an empty memory; a broken entry is left out.
 */
export function readGuardFile(parsed: JsonValue): GuardFile {
  const root = asRecord(parsed);
  const list = root?.entries;
  const entries: GuardEntry[] = [];
  if (Array.isArray(list)) {
    for (const raw of list) {
      const entry = readGuardEntry(raw);
      if (entry !== null) entries.push(entry);
    }
  }
  const breakers: [string, number][] = [];
  const trips = root?.breakers;
  if (Array.isArray(trips)) {
    for (const raw of trips) {
      const r = asRecord(raw);
      if (r !== null && isText(r.host) && isTime(r.trippedAt)) breakers.push([r.host, r.trippedAt]);
    }
  }
  return { entries, breakers };
}

/**
 * The asks of a pane that the guard can key. A peer's asks crossed a link and the lead's merge kept
 * them whole, so the `Ask` type is the member's claim here. Each must carry a string `id` and a
 * non-empty string `toolCallId`; anything else is left out of the guard and pushes nothing.
 */
export function keyableAsks(asks: readonly Ask[]): GuardAsk[] {
  const out: GuardAsk[] = [];
  for (const ask of asks) {
    // The claim is checked before any field is read: a peer may send `null` or a number here.
    if (typeof ask !== "object" || ask === null) continue;
    const { id, toolCallId } = ask;
    if (typeof id === "string" && typeof toolCallId === "string" && toolCallId !== "") out.push({ id, toolCallId });
  }
  return out;
}
