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

import type { JsonObject, JsonValue } from "../json.ts";
import type { AnswerRequest, Ask } from "../types.ts";
import { isRequestId } from "../worktree-receipts.ts";
import type { AnswerReceipt, AnswerState } from "./answer.ts";
import type { GuardAsk, GuardEntry } from "./guard.ts";

const STATES: ReadonlySet<string> = new Set(["pending", "taken", "too-late", "stale", "refused"]);

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

/** One answer receipt read off disk, or `null` when the entry is not one. */
export function coerceAnswerReceipt(raw: JsonValue): AnswerReceipt | null {
  const r = asRecord(raw);
  if (r === null) return null;
  const { requestId, at, paneId, askId, revision, optionId, state, detail, reason } = r;
  if (!isRequestId(requestId) || !isState(state) || !isTime(at)) return null;
  if (!isText(paneId) || !isText(askId) || !isText(optionId)) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision)) return null;
  const receipt: AnswerReceipt = { requestId, at, paneId, askId, revision, optionId, state };
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

/** The push guard's file, `{ "entries": [...] }`. Anything else is an empty memory; a broken entry is left out. */
export function readGuardFile(parsed: JsonValue): GuardEntry[] {
  const list = asRecord(parsed)?.entries;
  if (!Array.isArray(list)) return [];
  const out: GuardEntry[] = [];
  for (const raw of list) {
    const entry = readGuardEntry(raw);
    if (entry !== null) out.push(entry);
  }
  return out;
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
