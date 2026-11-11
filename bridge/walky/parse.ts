// The ONE file under bridge/walky/ that reads an unvalidated value: a request line on the local
// socket, a phone's POST body, and the log and inbox files on disk. Every reader is total over
// garbage: there is no input for which one throws, and a field that fails its rule fails the record.

import type { JsonObject, JsonValue } from "../json.ts";
import { readMarkers } from "../beacon/parse.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { MEMBER_ID_RE } from "../crew/identity.ts";
import { HILL_ID_RE, isHillCrewState, type HillCrewState } from "../../web/src/lib/hill/wire.ts";
import { HILL_BAD_ID } from "../hill/parse.ts";
import { LOCAL_MEMBER, parseAddress } from "./address.ts";
import type { WalkySpace } from "./space.ts";
import { BAD_ACK_IDS, BAD_MESSAGE_ID, BAD_REQUEST_LINE, bodyOverRaw, NO_ADDRESS, unknownOp, unreadAddress } from "./refusals.ts";
import {
  BORDER_VERDICTS,
  isPrintableAscii,
  RECEIPT_REASON_MAX,
  RECEIPT_STATES,
  SEND_ID,
  WALKY_ID,
  type WalkyKind,
  type WalkyMessage,
  type WalkyReceipt,
  type WalkyReceiptState,
  type WalkySender,
  type WalkyTarget,
  type WalkyVerified,
} from "./types.ts";

/** The longest request line the socket reads. A body of 4,000 characters fits many times over. */
export const WALKY_LINE_MAX = 64 * 1024;

/**
 * The longest `trick.propose` line (crew slice 8): a trick's files, at most 5 MB, written as base64 (about
 * 6.7 MB), with up to 300 paths and the frame. The socket reads this much only for a line that opens with
 * {@link PROPOSE_LINE_PREFIX}, at most two at a time.
 */
export const PROPOSE_LINE_MAX = 8 * 1024 * 1024;
/** How a `trick.propose` line opens, as `collie trick propose` writes it: the socket raises its cap for it. */
export const PROPOSE_LINE_PREFIX = '{"op":"trick.propose",';

/** The longest raw body a request may carry before cleaning. Longer is refused, not cut. */
export const RAW_BODY_MAX = 32 * 1024;

function text(row: JsonObject, key: string): string | null {
  return asJsonString(row[key]) ?? null;
}

function textOrNull(row: JsonObject, key: string): string | null | undefined {
  if (row[key] === null) return null;
  return asJsonString(row[key]);
}

export function isWalkyId(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && WALKY_ID.test(value);
}

/** The longest space key or label a message may carry (M98). A space name is far shorter. */
export const WALKY_SPACE_MAX = 1024;

/** The separator of an unnamed space key (space.ts). */
const UNNAMED_SEPARATOR = "\u0000";

/**
 * A sender's space (M98) as the wire or the log carries it: the space, null (an operator's), undefined
 * when the field is absent (a bridge before 1.29.0), or false when it is there and not one. A space is
 * `{ key, named, label }`, both strings within {@link WALKY_SPACE_MAX}. `named` must be the key's form:
 * a named key holds no NUL, an unnamed key is `<member id>\u0000<space id>` with one NUL and a member
 * id before it (space.ts `spaceOf`). Whose member id it is, is the crew check's (crew.ts).
 */
export function readSpace(value: JsonValue | undefined): WalkySpace | null | undefined | false {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const row = asJsonObject(value);
  if (row === undefined) return false;
  const key = asJsonString(row.key);
  const named = asJsonBoolean(row.named);
  const label = asJsonString(row.label);
  if (key === undefined || named === undefined || label === undefined) return false;
  if (key === "" || key.length > WALKY_SPACE_MAX || label.length > WALKY_SPACE_MAX) return false;
  const parts = key.split(UNNAMED_SEPARATOR);
  if (named && parts.length !== 1) return false;
  if (!named && (parts.length !== 2 || !(parts[0] === LOCAL_MEMBER || MEMBER_ID_RE.test(parts[0]!)))) return false;
  return { key, named, label };
}

function readSender(value: JsonValue | undefined): WalkySender | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const memberId = textOrNull(row, "memberId");
  const address = textOrNull(row, "address");
  const harness = textOrNull(row, "harness");
  const label = text(row, "label");
  const space = readSpace(row.space);
  if (memberId === undefined || address === undefined || harness === undefined || label === null || space === false) return null;
  if (address !== null && parseAddress(address)?.kind !== "pane") return null;
  if (harness !== null && !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(harness)) return null;
  const sender: WalkySender = { memberId, address, harness, label: label.slice(0, 200) };
  // Absent stays absent: a message from an older bridge has no space, and its canonical string no line.
  return space === undefined ? sender : { ...sender, space };
}

/** A message as the log stored it, or as a crew hop carries it (spec 03). Null when any field fails. */
export function readMessage(value: JsonValue | undefined): WalkyMessage | null {
  const row = asJsonObject(value);
  if (row === undefined || row.v !== 1) return null;
  const id = text(row, "id");
  const kindText = text(row, "kind");
  const kind: WalkyKind | null = kindText === "agent" || kindText === "operator" ? kindText : null;
  const from = readSender(row.from);
  const to = text(row, "to");
  const replyTo = textOrNull(row, "replyTo");
  const at = asJsonNumber(row.at);
  const body = text(row, "body");
  const signer = textOrNull(row, "signer");
  const signature = textOrNull(row, "signature");
  if (!isWalkyId(id) || kind === null || from === null || to === null || parseAddress(to) === null) return null;
  if (replyTo === undefined || (replyTo !== null && !isWalkyId(replyTo))) return null;
  if (at === undefined || !Number.isSafeInteger(at) || body === null || signer === undefined || signature === undefined) return null;
  const message: WalkyMessage = { v: 1, id, kind, from, to, replyTo, at, body, signer, signature };
  const woken: WalkyMessage = asJsonBoolean(row.wake) === true ? { ...message, wake: true } : message;
  return asJsonBoolean(row.outside) === true ? { ...woken, outside: true } : woken;
}

const VERIFIED: readonly WalkyVerified[] = ["origin", "lead", "local", "none"];

/** A receipt as the log stored it. */
export function readReceipt(value: JsonValue | undefined): WalkyReceipt | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const id = text(row, "id");
  const target = text(row, "target");
  const stateText = text(row, "state");
  const state: WalkyReceiptState | undefined = RECEIPT_STATES.find((candidate) => candidate === stateText);
  const verifiedText = text(row, "verified");
  const verified = VERIFIED.find((candidate) => candidate === verifiedText);
  const at = asJsonNumber(row.at);
  const by = text(row, "by");
  // `by` names a member (or `solo`), or is the log's own `-` for a line it rebuilt (log.ts).
  if (!isWalkyId(id) || target === null || state === undefined || verified === undefined || at === undefined || by === null) return null;
  if (by !== "-" && !MEMBER_ID_RE.test(by)) return null;
  const receipt: WalkyReceipt = { id, target, state, verified, at, by };
  // A receipt crosses machines and is printed into an agent's terminal: a reason that is not short
  // printable ASCII, or a send id not in `sendIdOf`'s form, is dropped, and the receipt still reads.
  const rawReason = text(row, "reason");
  const reason = rawReason !== null && rawReason !== "" && rawReason.length <= RECEIPT_REASON_MAX && isPrintableAscii(rawReason) ? rawReason : null;
  const rawSendId = text(row, "sendId");
  const sendId = rawSendId !== null && SEND_ID.test(rawSendId) ? rawSendId : null;
  const withReason = reason === null ? receipt : { ...receipt, reason };
  const withSend = sendId === null ? withReason : { ...withReason, sendId };
  // How the message passed the space border (M98): one of the five words, or dropped.
  const via = BORDER_VERDICTS.find((candidate) => candidate === row.via);
  return via === undefined ? withSend : { ...withSend, via };
}

// ── The local socket's requests ──────────────────────────────────────────────────────────────────

export type WalkyOp = "send" | "inbox" | "who" | "status" | "ack" | "cancel" | "off" | "on" | "pane" | HillOp | "trick.propose";

/** What a `hill.state` request with a word that is no crew state is refused with. */
export const HILL_BAD_CREW_STATE = "bad request: the crew state is here, quiet or away";

/** The hill's operations (M96), beside walky's own. Added, never a change to one of them. */
export type HillOp = "hill.post" | "hill.status" | "hill.withdraw" | "hill.list" | "hill.clear" | "hill.state" | "hill.spoken.clear";

export type WalkyRequest =
  | {
      readonly op: "send";
      readonly markers: readonly BeaconMarker[];
      readonly id: string;
      readonly to: string | null;
      readonly body: string;
      readonly replyTo: string | null;
      readonly wake: boolean;
      /** M98: the message may leave the sender's space. Absent or anything but `true` reads as false. */
      readonly outside: boolean;
    }
  | { readonly op: "inbox"; readonly markers: readonly BeaconMarker[]; readonly all: boolean; readonly ack: boolean; readonly id: string | null }
  | { readonly op: "who" | "off" | "on" | "pane"; readonly markers: readonly BeaconMarker[] }
  | { readonly op: "status"; readonly markers: readonly BeaconMarker[]; readonly id: string }
  | { readonly op: "ack"; readonly markers: readonly BeaconMarker[]; readonly ids: readonly string[] | null }
  | { readonly op: "cancel"; readonly markers: readonly BeaconMarker[]; readonly id: string }
  // The hill (M96): a post's fields are read by bridge/hill/parse.ts, which owns their shape.
  | { readonly op: "hill.post"; readonly markers: readonly BeaconMarker[]; readonly fields: JsonObject }
  | { readonly op: "hill.status" | "hill.withdraw"; readonly markers: readonly BeaconMarker[]; readonly id: string }
  | { readonly op: "hill.list"; readonly markers: readonly BeaconMarker[] }
  // Clear every closed decision, from the person's terminal: it names no pane and no id.
  | { readonly op: "hill.clear"; readonly markers: readonly BeaconMarker[] }
  // The second Clear (1.29.0): withdraw and clear the open cards answered in the session. A new op, not a
  // flag on `hill.clear`, so a bridge before it refuses it as unknown instead of clearing the closed ones.
  | { readonly op: "hill.spoken.clear"; readonly markers: readonly BeaconMarker[] }
  // The crew state (1.29.0): a read with no `state`, a person's write with one. A new op, so a bridge
  // before it answers it as unknown and never takes a write it cannot read.
  | { readonly op: "hill.state"; readonly markers: readonly BeaconMarker[]; readonly state: HillCrewState | null }
  // A trick handed to the lead (crew slice 8): its fields are read by bridge/tricks/propose-wire.ts.
  | { readonly op: "trick.propose"; readonly markers: readonly BeaconMarker[]; readonly fields: JsonObject };

/** Whether a request is one of the hill's operations (M96). */
export function isHillOp(op: string | null): op is HillOp {
  return op === "hill.post" || op === "hill.status" || op === "hill.withdraw" || op === "hill.list" || op === "hill.clear" || op === "hill.state" || op === "hill.spoken.clear";
}

/**
 * One request line read, or why it is not one (added 2026-10-30). An unread request keeps the markers
 * it carried when they parse: a bridge whose panes they do not name answers `not here`, so the CLI asks
 * the next bridge instead of stopping at one that cannot read a newer request. The reason opens with
 * `bad request:` and names what failed (refusals.ts).
 */
export type WalkyRequestRead =
  | { readonly ok: true; readonly request: WalkyRequest }
  | { readonly ok: false; readonly markers: readonly BeaconMarker[]; readonly reason: string };

function unread(reason: string, markers: readonly BeaconMarker[] = []): WalkyRequestRead {
  return { ok: false, markers, reason };
}

function done(request: WalkyRequest): WalkyRequestRead {
  return { ok: true, request };
}

/** One request line: `v` must be 1; an unknown op, a bad id or a bad address fails with its reason. */
export function readWalkyRequest(line: string, max: number = WALKY_LINE_MAX): WalkyRequestRead {
  if (line.length > max) return unread(BAD_REQUEST_LINE);
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    parsed = JSON.parse(line) as JsonValue;
  } catch {
    return unread(BAD_REQUEST_LINE);
  }
  const row = asJsonObject(parsed);
  if (row === undefined) return unread(BAD_REQUEST_LINE);
  const markers = readMarkers(row.markers);
  if (row.v !== 1) return unread(BAD_REQUEST_LINE, markers);
  const op = text(row, "op");
  if (op === "who" || op === "off" || op === "on" || op === "pane") return done({ op, markers });
  if (op === "status" || op === "cancel") {
    const id = text(row, "id");
    return isWalkyId(id) ? done({ op, markers, id }) : unread(BAD_MESSAGE_ID, markers);
  }
  if (op === "inbox") {
    const id = textOrNull(row, "id") ?? null;
    if (id !== null && !isWalkyId(id)) return unread(BAD_MESSAGE_ID, markers);
    return done({ op, markers, all: asJsonBoolean(row.all) === true, ack: asJsonBoolean(row.ack) === true, id });
  }
  if (op === "ack") {
    if (row.ids === null || row.ids === undefined) return done({ op, markers, ids: null });
    if (!Array.isArray(row.ids) || row.ids.length > 200) return unread(BAD_ACK_IDS, markers);
    const ids = row.ids.map((entry) => asJsonString(entry) ?? null);
    return ids.every((id) => isWalkyId(id)) ? done({ op, markers, ids: ids.filter((id): id is string => id !== null) }) : unread(BAD_MESSAGE_ID, markers);
  }
  // The hill (M96). A bridge built without it answers these as it answers any op it does not know.
  if (op === "hill.post") return done({ op, markers, fields: row });
  if (op === "hill.status" || op === "hill.withdraw") {
    const id = text(row, "id");
    return id !== null && HILL_ID_RE.test(id) ? done({ op, markers, id }) : unread(HILL_BAD_ID, markers);
  }
  if (op === "hill.list" || op === "hill.clear" || op === "hill.spoken.clear") return done({ op, markers });
  if (op === "hill.state") {
    const state = row.state ?? null;
    if (state !== null && !isHillCrewState(state)) return unread(HILL_BAD_CREW_STATE, markers);
    return done({ op, markers, state });
  }
  if (op === "trick.propose") return done({ op, markers, fields: row });
  if (op !== "send") return unread(op === null ? BAD_REQUEST_LINE : unknownOp(op), markers);
  const id = text(row, "id");
  // The address as the bridge spells it: `parseAddress` reads past blanks, and the signed `to` must not
  // carry them, or a crew leg is logged under one spelling and answered under another.
  const to = text(row, "to")?.trim() ?? null;
  const body = text(row, "body");
  const replyTo = textOrNull(row, "replyTo") ?? null;
  if (!isWalkyId(id) || (replyTo !== null && !isWalkyId(replyTo))) return unread(BAD_MESSAGE_ID, markers);
  // A reply may leave the address out: the bridge sends it to the sender of what it answers.
  if (to === null && replyTo === null) return unread(NO_ADDRESS, markers);
  if (to !== null && parseAddress(to) === null) return unread(unreadAddress(to), markers);
  if (body === null) return unread(BAD_REQUEST_LINE, markers);
  if (body.length > RAW_BODY_MAX) return unread(bodyOverRaw(RAW_BODY_MAX), markers);
  return done({ op, markers, id, to, body, replyTo, wake: asJsonBoolean(row.wake) === true, outside: asJsonBoolean(row.outside) === true });
}

/** One request line, or null. `v` must be 1; an unknown op, a bad id or a bad address fails. */
export function parseWalkyRequest(line: string): WalkyRequest | null {
  const read = readWalkyRequest(line);
  return read.ok ? read.request : null;
}

/** What a phone's `POST /api/walky` carries. */
export interface PhoneSend {
  readonly id: string;
  readonly to: string;
  readonly body: string;
  readonly replyTo: string | null;
  /** M85: a fan-out also types into resting panes. */
  readonly wake: boolean;
}

/** The phone's body, or a word for the 400. */
export function parsePhoneSend(value: JsonValue | undefined): PhoneSend | { readonly error: string } {
  const row = asJsonObject(value);
  if (row === undefined) return { error: "bad body" };
  const id = text(row, "id");
  const to = text(row, "to")?.trim() ?? null;
  const body = text(row, "body");
  const replyTo = textOrNull(row, "replyTo") ?? null;
  if (!isWalkyId(id)) return { error: "bad id" };
  if (to === null || parseAddress(to) === null) return { error: "bad to" };
  if (body === null || body.length > RAW_BODY_MAX) return { error: "bad body" };
  if (replyTo !== null && !isWalkyId(replyTo)) return { error: "bad replyTo" };
  return { id, to, body, replyTo, wake: asJsonBoolean(row.wake) === true };
}

// ── The crew hops (CREW_PROTOCOL §21) ────────────────────────────────────────────────────────────

/** The most receipts one answer or one snapshot report is read for. More are dropped, not refused. */
export const CREW_RECEIPTS_MAX = 100;

/** A list of receipts, as a crew answer or a snapshot report carries it. Bad entries are dropped. */
export function readReceiptList(value: JsonValue | undefined): WalkyReceipt[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, CREW_RECEIPTS_MAX).flatMap((entry) => {
    const receipt = readReceipt(entry);
    return receipt === null ? [] : [receipt];
  });
}

/** `{ receipts }`, the answer of both crew routes, or an empty list. */
export function readReceiptsAnswer(value: JsonValue | undefined): WalkyReceipt[] {
  return readReceiptList(asJsonObject(value)?.receipts);
}

/**
 * The lead's outcomes push, `{ receipts }` (§21, added 2026-10-18): the receipts, bad entries
 * dropped, or null when the body is not an object with a `receipts` list.
 */
export function readOutcomesPush(value: JsonValue | undefined): WalkyReceipt[] | null {
  const row = asJsonObject(value);
  if (row === undefined || !Array.isArray(row.receipts)) return null;
  return readReceiptList(row.receipts);
}

/** The most panes a lead's `who` answer holds. Far above any crew's agent panes. */
export const WHO_ROWS_MAX = 2000;

/**
 * The lead's answer to a member's `who` (M98 spec 04, `POST /crew/v1/walky/who`): `{ targets }`, each row
 * as `collie walky who` lists it. A row that is not a pane address, or has no well formed space, is
 * dropped: it is display data, and the receiving bridge decides every send itself. Null when the body is
 * not an object with a `targets` list.
 */
export function readWhoAnswer(value: JsonValue | undefined): WalkyTarget[] | null {
  const row = asJsonObject(value);
  if (row === undefined || !Array.isArray(row.targets)) return null;
  const out: WalkyTarget[] = [];
  for (const entry of row.targets.slice(0, WHO_ROWS_MAX)) {
    const target = asJsonObject(entry);
    if (target === undefined) continue;
    const address = text(target, "address");
    const memberId = text(target, "memberId");
    const machine = text(target, "machine");
    const label = text(target, "label");
    const state = text(target, "state");
    const harness = textOrNull(target, "harness");
    const space = readSpace(target.space);
    if (address === null || memberId === null || machine === null || label === null || state === null || harness === undefined) continue;
    if (space === undefined || space === null || space === false || parseAddress(address)?.kind !== "pane") continue;
    const base: WalkyTarget = { address, memberId, machine, harness, label, state, space };
    out.push(target.walky === "off" ? { ...base, walky: "off" } : base);
  }
  return out;
}

/** The longest `sender.certPem` a delivery may carry. A P-256 certificate is well under 1,000. */
export const SENDER_CERT_MAX = 4096;
/** The longest `attest` or `sender.voucher` a delivery may carry. A base64 P-256 signature is under 100. */
export const SIGNATURE_MAX = 512;

/** The sender block of a delivery (§21, added 2026-10-18): the sender's pinned certificate and the lead's voucher for it. */
export interface CrewSenderBlock {
  readonly certPem: string;
  readonly voucher: string;
}

/** A lead-to-member body as `readCrewDelivery` reads it. `sender` is absent when the body carried none. */
export interface CrewDelivery {
  readonly message: WalkyMessage;
  readonly attest: string;
  readonly sender?: CrewSenderBlock;
}

function boundedText(value: JsonValue | undefined, max: number): string | null {
  const read = asJsonString(value);
  return read === undefined || read === "" || read.length > max ? null : read;
}

/**
 * The lead-to-member body, `{ message, attest, sender? }`, or null when any part is not one. An absent
 * or null `sender` reads as none (§7.1); one that is there must be whole, within its caps, or the body
 * is malformed.
 */
export function readCrewDelivery(value: JsonValue | undefined): CrewDelivery | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const message = readMessage(row.message);
  const attest = boundedText(row.attest, SIGNATURE_MAX);
  if (message === null || attest === null) return null;
  if (row.sender === undefined || row.sender === null) return { message, attest };
  const block = asJsonObject(row.sender);
  const certPem = boundedText(block?.certPem, SENDER_CERT_MAX);
  const voucher = boundedText(block?.voucher, SIGNATURE_MAX);
  if (certPem === null || voucher === null) return null;
  return { message, attest, sender: { certPem, voucher } };
}

// ── The report's ack cursor (§21, added 2026-10-18) ─────────────────────────────────────────────

/** A report cursor: `<epoch>.<seq>`, the epoch 8 lowercase hex characters, the seq a whole number. */
const CURSOR = /^([0-9a-f]{8})\.(\d{1,15})$/u;

/** A cursor read apart, or null for anything that is not one. */
export function readWalkyCursor(value: string | null | undefined): { readonly epoch: string; readonly seq: number } | null {
  if (value === null || value === undefined) return null;
  const match = CURSOR.exec(value.trim());
  if (match === null) return null;
  const seq = Number(match[2]);
  return Number.isSafeInteger(seq) ? { epoch: match[1]!, seq } : null;
}

/** What a member's report carries: its receipts and the cursor of the newest one. */
export interface WalkyReportBody {
  readonly receipts: WalkyReceipt[];
  /** `<epoch>.<seq>`, or null when the report named none (a member before the ack, §7.1). */
  readonly cursor: string | null;
}

/**
 * A member's walky report off its `/crew/v1/snapshot` answer: the `walky` sibling of the body,
 * `{ receipts, cursor }`. Absent or malformed reads as no report (§7.1's absent-means-closed); a
 * cursor that is not one reads as none, and the lead then acks nothing.
 */
export function readWalkyReport(answer: JsonValue | undefined, field: string): WalkyReportBody {
  const row = asJsonObject(asJsonObject(answer)?.[field]);
  const receipts = readReceiptList(row?.receipts);
  const raw = asJsonString(row?.cursor);
  const cursor = raw !== undefined && readWalkyCursor(raw) !== null ? raw.trim() : null;
  return { receipts, cursor };
}

/** The English `error` of a refusal body, or null. */
export function readErrorText(value: JsonValue | undefined): string | null {
  return asJsonString(asJsonObject(value)?.error) ?? null;
}
