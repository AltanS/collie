// The ONE file under bridge/walky/ that reads an unvalidated value: a request line on the local
// socket, a phone's POST body, and the log and inbox files on disk. Every reader is total over
// garbage: there is no input for which one throws, and a field that fails its rule fails the record.

import type { JsonObject, JsonValue } from "../json.ts";
import { readMarkers } from "../beacon/parse.ts";
import type { BeaconMarker } from "../beacon/types.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { MEMBER_ID_RE } from "../crew/identity.ts";
import { parseAddress } from "./address.ts";
import {
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
  type WalkyVerified,
} from "./types.ts";

/** The longest request line the socket reads. A body of 4,000 characters fits many times over. */
export const WALKY_LINE_MAX = 64 * 1024;

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

function readSender(value: JsonValue | undefined): WalkySender | null {
  const row = asJsonObject(value);
  if (row === undefined) return null;
  const memberId = textOrNull(row, "memberId");
  const address = textOrNull(row, "address");
  const harness = textOrNull(row, "harness");
  const label = text(row, "label");
  if (memberId === undefined || address === undefined || harness === undefined || label === null) return null;
  if (address !== null && parseAddress(address)?.kind !== "pane") return null;
  if (harness !== null && !/^[a-z0-9][a-z0-9._-]{0,31}$/u.test(harness)) return null;
  return { memberId, address, harness, label: label.slice(0, 200) };
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
  return { v: 1, id, kind, from, to, replyTo, at, body, signer, signature };
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
  return sendId === null ? withReason : { ...withReason, sendId };
}

// ── The local socket's requests ──────────────────────────────────────────────────────────────────

export type WalkyOp = "send" | "inbox" | "who" | "status" | "ack" | "cancel";

export type WalkyRequest =
  | { readonly op: "send"; readonly markers: readonly BeaconMarker[]; readonly id: string; readonly to: string | null; readonly body: string; readonly replyTo: string | null }
  | { readonly op: "inbox"; readonly markers: readonly BeaconMarker[]; readonly all: boolean; readonly ack: boolean; readonly id: string | null }
  | { readonly op: "who"; readonly markers: readonly BeaconMarker[] }
  | { readonly op: "status"; readonly markers: readonly BeaconMarker[]; readonly id: string }
  | { readonly op: "ack"; readonly markers: readonly BeaconMarker[]; readonly ids: readonly string[] | null }
  | { readonly op: "cancel"; readonly markers: readonly BeaconMarker[]; readonly id: string };

/** One request line, or null. `v` must be 1; an unknown op, a bad id or a bad address fails. */
export function parseWalkyRequest(line: string): WalkyRequest | null {
  if (line.length > WALKY_LINE_MAX) return null;
  let parsed: JsonValue;
  try {
    // SAFETY: `JSON.parse` output IS a JsonValue by construction.
    parsed = JSON.parse(line) as JsonValue;
  } catch {
    return null;
  }
  const row = asJsonObject(parsed);
  if (row === undefined || row.v !== 1) return null;
  const markers = readMarkers(row.markers);
  const op = text(row, "op");
  if (op === "who") return { op, markers };
  if (op === "status" || op === "cancel") {
    const id = text(row, "id");
    return isWalkyId(id) ? { op, markers, id } : null;
  }
  if (op === "inbox") {
    const id = textOrNull(row, "id") ?? null;
    if (id !== null && !isWalkyId(id)) return null;
    return { op, markers, all: asJsonBoolean(row.all) === true, ack: asJsonBoolean(row.ack) === true, id };
  }
  if (op === "ack") {
    if (row.ids === null || row.ids === undefined) return { op, markers, ids: null };
    if (!Array.isArray(row.ids) || row.ids.length > 200) return null;
    const ids = row.ids.map((entry) => asJsonString(entry) ?? null);
    return ids.every((id) => isWalkyId(id)) ? { op, markers, ids: ids.filter((id): id is string => id !== null) } : null;
  }
  if (op !== "send") return null;
  const id = text(row, "id");
  // The address as the bridge spells it: `parseAddress` reads past blanks, and the signed `to` must not
  // carry them, or a crew leg is logged under one spelling and answered under another.
  const to = text(row, "to")?.trim() ?? null;
  const body = text(row, "body");
  const replyTo = textOrNull(row, "replyTo") ?? null;
  if (replyTo !== null && !isWalkyId(replyTo)) return null;
  // A reply may leave the address out: the bridge sends it to the sender of what it answers.
  if (to === null ? replyTo === null : parseAddress(to) === null) return null;
  if (!isWalkyId(id) || body === null || body.length > RAW_BODY_MAX) return null;
  return { op, markers, id, to, body, replyTo };
}

/** What a phone's `POST /api/walky` carries. */
export interface PhoneSend {
  readonly id: string;
  readonly to: string;
  readonly body: string;
  readonly replyTo: string | null;
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
  return { id, to, body, replyTo };
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
