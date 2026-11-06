// `/api/pane/:id/pins` (M90): the pins of the pane's session, listed, added and dropped. The handler
// is a pure function of its inputs and answers a status with an optional body, so a test calls it as
// it is and `bridge/server.ts` only turns the answer into a Response and builds `PinsSession`.
//
//   GET                -> 200 { pins }  newest first, each with `excerpt` and `textLength`, no `text`  (read gate)
//   GET ?pin=<id>      -> 200 { pin }   the one pin with its whole `text`, or 404 `pin.not_found`      (read gate)
//   POST { itemId }    -> 201 { pin }   | 200 { pin } when the block is already pinned: one pin per item id  (write gate)
//   DELETE ?pin=<id>   -> 204, whether or not the pin existed                                              (write gate)
//
// Refusals carry `{ error, code, message }` with `error` and `code` the same `pin.*` word, so the phone
// tells them from the plain-text 404 an older bridge answers for a route it lacks: 409 `pin.no_session`
// (a pane with no journal session: a shell, a harness with no reader), 404 `pin.item_not_found`, 404
// `pin.not_found`, 409 `pin.not_pinnable` (an image, a compaction marker), 409 `pin.not_settled` (an
// entry the program is still writing), 409 `pin.cap`. A bad body or
// query is a 400 and a failed write a 500, both plain text.
//
// The phone names a block by its Chat item id and nothing else. The text comes from the journal the
// pane's Chat reads (`PinsSession.entries`), so a pin never holds a word the phone sent.

import type { JsonValue } from "../../web/src/lib/json.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import type { AuditEntry } from "../audit.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import { maskPin } from "../answer-mask.ts";
import { findPinnable } from "./lookup.ts";
import { MAX_PINS, type Pin, type PinStore } from "./store.ts";

/** How much of a pin's text a list row carries. The whole text is one `GET ?pin=<id>` away. */
export const EXCERPT_CHARS = 400;

/** A pin as the list shows it: everything but `text`, with the first {@link EXCERPT_CHARS} of it and its length. */
export type PinRow = Omit<Pin, "text"> & { readonly excerpt: string; readonly textLength: number };

export type PinReason = "pin.no_session" | "pin.item_not_found" | "pin.not_found" | "pin.not_pinnable" | "pin.not_settled" | "pin.cap";

const SENTENCES = {
  "pin.no_session": "this pane has no session to keep pins for",
  "pin.item_not_found": "that block is not in this session's log any more",
  "pin.not_found": "that pin does not exist",
  "pin.not_settled": "that reply is still being written, pin it when it settles",
  "pin.not_pinnable": "that block cannot be pinned",
  "pin.cap": `a session keeps at most ${MAX_PINS} pins; unpin one first`,
} satisfies Record<PinReason, string>;

/** The longest item id the route reads; a Claude tool id and `<uuid>:<n>` are far shorter. */
const MAX_ITEM_ID = 300;

/** The session a pane's pins hang on, as the Chat reader keys it. */
export interface PinsSession {
  /** The key the pins are filed under (./key.ts). */
  readonly key: string;
  /** The entries the journal reader holds for the session, or null when its log cannot be read now. */
  readonly entries: () => Promise<readonly TranscriptEntry[] | null>;
}

export interface PinsRequest {
  readonly method: string;
  /** The `pin` query parameter of a DELETE. */
  readonly pin: string | null;
  /** The parsed body of a POST; undefined when it did not parse. */
  readonly body: JsonValue | undefined;
}

export interface PinsDeps {
  readonly store: PinStore;
  /** The pane's session, or null when it has none (a shell, a harness with no journal reader). */
  readonly journal: PinsSession | null;
  /** Mask secrets in the text that leaves, as Chat does (`COLLIE_REDACT`); the file keeps the copy. */
  readonly redact: boolean;
  readonly audit: { record(entry: AuditEntry): void };
  readonly device: string | null;
  /** The multiplexer session name and the pane, for the audit line. */
  readonly session: string;
  readonly paneId: string;
}

export type PinsAnswer =
  | { readonly status: 200 | 201; readonly body: { readonly pins: readonly PinRow[] } | { readonly pin: Pin } }
  | { readonly status: 204 }
  | { readonly status: 400 | 405 | 500; readonly text: string }
  | { readonly status: 404 | 409; readonly body: { readonly error: PinReason; readonly code: PinReason; readonly message: string } };

function refusal(status: 404 | 409, code: PinReason): PinsAnswer {
  return { status, body: { error: code, code, message: SENTENCES[code] } };
}

function shown(pin: Pin, redact: boolean): Pin {
  return redact ? maskPin(pin) : pin;
}

/** Masked first and cut after, so a secret the cut would split is still masked. */
function rowOf(pin: Pin): PinRow {
  const { text, ...rest } = pin;
  return { ...rest, excerpt: text.slice(0, EXCERPT_CHARS), textLength: text.length };
}

function list(deps: PinsDeps, journal: PinsSession, pinId: string | null): PinsAnswer {
  if (pinId === null) return { status: 200, body: { pins: deps.store.list(journal.key).map((held) => rowOf(shown(held, deps.redact))) } };
  const one = deps.store.get(journal.key, pinId);
  if (one === undefined) return refusal(404, "pin.not_found");
  return { status: 200, body: { pin: shown(one, deps.redact) } };
}

async function add(deps: PinsDeps, journal: PinsSession, body: JsonValue | undefined): Promise<PinsAnswer> {
  const itemId = asJsonString(asJsonObject(body)?.itemId);
  if (itemId === undefined || itemId === "" || itemId.length > MAX_ITEM_ID) return { status: 400, text: "bad body" };
  const entries = await journal.entries();
  // A log that cannot be read now holds no block to copy: the same answer as a block that is not in it.
  if (entries === null) return refusal(404, "pin.item_not_found");
  const found = findPinnable(entries, itemId);
  if (!found.ok) return found.reason === "not_found" ? refusal(404, "pin.item_not_found") : refusal(409, `pin.${found.reason}`);
  const added = deps.store.add(journal.key, found.draft);
  if (!added.ok) return added.reason === "cap" ? refusal(409, "pin.cap") : { status: 500, text: "could not keep the pin" };
  if (added.created) {
    deps.audit.record({ action: "pin.add", session: deps.session, paneId: deps.paneId, device: deps.device, detail: { pin: added.pin.id, kind: added.pin.kind } });
  }
  return { status: added.created ? 201 : 200, body: { pin: shown(added.pin, deps.redact) } };
}

function drop(deps: PinsDeps, journal: PinsSession, pin: string | null): PinsAnswer {
  if (pin === null || pin === "") return { status: 400, text: "bad pin" };
  const removed = deps.store.remove(journal.key, pin);
  if (!removed.ok) return { status: 500, text: "could not drop the pin" };
  if (removed.removed) {
    deps.audit.record({ action: "pin.remove", session: deps.session, paneId: deps.paneId, device: deps.device, detail: { pin } });
  }
  return { status: 204 };
}

/** Answer one request on the pane's pins. */
export async function pinsRoute(deps: PinsDeps, req: PinsRequest): Promise<PinsAnswer> {
  if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") return { status: 405, text: "method not allowed" };
  if (deps.journal === null) return refusal(409, "pin.no_session");
  if (req.method === "GET") return list(deps, deps.journal, req.pin);
  if (req.method === "POST") return add(deps, deps.journal, req.body);
  return drop(deps, deps.journal, req.pin);
}
