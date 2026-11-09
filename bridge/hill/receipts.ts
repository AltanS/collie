import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { asJsonNumber, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { HILL_DEVICE_ID_RE, HILL_STATES, HILL_TRICK_DELIVERIES, type HillReceipt, type HillState } from "../../web/src/lib/hill/wire.ts";
import { isRequestId, memoryReceipts, payloadDigest, ReceiptFileStore, type ReceiptSurface } from "../worktree-receipts.ts";
import { hillDir } from "./store.ts";

// ── One receipt per answer from the phone, so a retried tap never answers twice (the hill, M96) ─────
//
// The launch receipts' pattern (ADR 0091, `launch-receipts.ts`) over `ReceiptFileStore`: the phone
// mints a UUID per tap (`rid`), and the bridge keeps the receipt it wrote under it in
// `<stateDir>/hill/receipts.json`. A request that names a known `rid` with the same payload gets the
// stored receipt back and runs nothing; with another payload it is refused (409), as the worktree and
// launch routes refuse a reused id. The digest is over `[node, intent, text]`, so the receipt keeps no
// word the person typed.
//
// Written on the first answer and on nothing else, so a bridge nobody answers on writes no file.

/** The receipt file's name inside the hill folder. */
export const HILL_RECEIPTS_FILE = "receipts.json";

/** One stored receipt: the `rid` as the store's key, the payload's digest, and the receipt itself. */
export interface HillReceiptRecord {
  /** The answer's `rid`; the store keys every receipt on this field. */
  requestId: string;
  /** {@link hillAnswerDigest} of what the answer asked for. */
  payloadDigest: string;
  receipt: HillReceipt;
}

/** What one answer asks for, as a digest: the node, the intent and the text (an absent text as the empty one). */
export function hillAnswerDigest(node: string, intent: string, text: string | null): string {
  return payloadDigest([node, intent, text ?? ""]);
}

const CODES = ["ok", "rejected", "gone", "denied", "unknown"] as const;
const DELIVERIES = ["typed", "held", "unknown", "none"] as const;

function isState(value: string | undefined): value is HillState {
  return HILL_STATES.some((state) => state === value);
}

/** One record read off disk, or null when the entry is not one. */
export function coerceHillReceipt(raw: JsonValue): HillReceiptRecord | null {
  const row = asJsonObject(raw);
  const receipt = asJsonObject(row?.receipt);
  if (row === undefined || receipt === undefined) return null;
  const requestId = asJsonString(row.requestId);
  const digest = asJsonString(row.payloadDigest);
  const rid = asJsonString(receipt.rid);
  const codeText = asJsonString(receipt.code);
  const code = CODES.find((candidate) => candidate === codeText);
  const reason = receipt.reason === null ? null : asJsonString(receipt.reason);
  const stateText = receipt.state === null ? null : asJsonString(receipt.state);
  const deliveryText = receipt.delivery === null ? null : asJsonString(receipt.delivery);
  const delivery = deliveryText === null ? null : DELIVERIES.find((candidate) => candidate === deliveryText);
  // Absent on a receipt written before tricks posted (M94): an agent's, so "none" beside a delivery.
  const trickText = receipt.trick === undefined ? (delivery === null ? null : "none") : receipt.trick === null ? null : asJsonString(receipt.trick);
  const trick = trickText === null ? null : HILL_TRICK_DELIVERIES.find((candidate) => candidate === trickText);
  const at = asJsonNumber(receipt.at);
  if (trick === undefined) return null;
  if (!isRequestId(requestId) || digest === undefined || rid !== requestId || code === undefined || reason === undefined) return null;
  if (stateText === undefined || (stateText !== null && !isState(stateText)) || delivery === undefined || at === undefined) return null;
  // Absent on a receipt written before receipts carried the device's record id.
  const deviceId = receipt.deviceId === undefined ? undefined : asJsonString(receipt.deviceId);
  if (receipt.deviceId !== undefined && (deviceId === undefined || !HILL_DEVICE_ID_RE.test(deviceId))) return null;
  const read: HillReceipt = { rid, code, reason, state: stateText, delivery, trick, at };
  return { requestId, payloadDigest: digest, receipt: deviceId === undefined ? read : { ...read, deviceId } };
}

/**
 * What one answer comes to: a receipt the bridge wrote (any code), a `rid` already used for another
 * payload (409, nothing written), or a first receipt that could not be saved (503, nothing closed and
 * nothing typed).
 */
export type HillAnswerOutcome = { readonly kind: "receipt"; readonly receipt: HillReceipt } | { readonly kind: "reused" } | { readonly kind: "unsaved" };

/** What the answer path needs of the store: the surface, plus the write that comes before the close. */
export type HillReceiptSurface = ReceiptSurface<HillReceiptRecord, HillAnswerOutcome> & {
  /** Store one record and say whether it reached disk. False: nothing is closed and nothing is typed. */
  recordFirst(record: HillReceiptRecord): Promise<boolean>;
};

/** The file-backed store `bridge/index.ts` builds once per bridge. */
export class HillReceiptStore extends ReceiptFileStore<HillReceiptRecord, HillAnswerOutcome> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line)) {
    super(hillDir(stateDir), join(hillDir(stateDir), HILL_RECEIPTS_FILE), coerceHillReceipt, warn, "hill");
  }
}

/** A store with no file, for a test or a server built without one. Its first write never fails. */
export function memoryHillReceipts(): HillReceiptSurface {
  const store = memoryReceipts<HillReceiptRecord, HillAnswerOutcome>();
  return {
    ...store,
    recordFirst: async (record) => {
      await store.record(record);
      return true;
    },
  };
}
