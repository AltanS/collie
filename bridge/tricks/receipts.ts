import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { TAP_CODES, type TapCode, type TrickTapReply } from "../../web/src/lib/tricks/schema.ts";
import { isRequestId, memoryReceipts, ReceiptFileStore, type ReceiptSurface } from "../worktree-receipts.ts";
import { tricksStateDir } from "./paths.ts";

// ── One receipt per tap, on disk, so a retried tap never runs a trick twice (M94) ───────────────────
//
// The hill's pattern (bridge/hill/receipts.ts) over the same `ReceiptFileStore`: a tap's `rid` keys one
// record in `<stateDir>/tricks/receipts.json`. The record is written BEFORE the program runs, as an
// in-flight marker (`pending: true`), and completed with the receipt after. A bridge that restarts in
// between finds only the marker: a retry of that `rid` answers `unknown` (the run may have done its
// work) and runs nothing. The digest is over the tap's payload, so the record keeps no word the person
// typed. The receipt kept is the frame only (`rid`, `code`, `message`, `rev`), never the parts.
//
// Written on the first tap and on nothing else, so a bridge nobody taps on writes no file.

/** The receipt file's name inside `<stateDir>/tricks/`. */
export const TRICK_RECEIPTS_FILE = "receipts.json";

/** One stored record: the `rid`, the payload's digest, and the receipt once the run ended. */
export interface TrickReceiptRecord {
  /** The tap's `rid`; the store keys every record on this field. */
  requestId: string;
  payloadDigest: string;
  /** Epoch ms the marker was written. */
  at: number;
  /** True while the run has not ended: the marker. */
  pending: boolean;
  /** The receipt's frame, once the run ended. */
  reply: { code: TapCode; message?: string; rev?: number } | null;
}

function isTapCode(text: string | undefined): text is TapCode {
  return TAP_CODES.some((code) => code === text);
}

/** One record read off disk, or null when the entry is not one. */
export function coerceTrickReceipt(raw: JsonValue): TrickReceiptRecord | null {
  const row = asJsonObject(raw);
  if (row === undefined) return null;
  const requestId = asJsonString(row.requestId);
  const digest = asJsonString(row.payloadDigest);
  const at = asJsonNumber(row.at);
  const pending = asJsonBoolean(row.pending);
  if (!isRequestId(requestId) || digest === undefined || at === undefined || pending === undefined) return null;
  if (row.reply === null || row.reply === undefined) return pending ? { requestId, payloadDigest: digest, at, pending, reply: null } : null;
  const reply = asJsonObject(row.reply);
  const code = asJsonString(reply?.code);
  if (reply === undefined || !isTapCode(code)) return null;
  const out: TrickReceiptRecord["reply"] = { code };
  const message = asJsonString(reply.message);
  if (message !== undefined) out.message = message;
  const rev = asJsonNumber(reply.rev);
  if (rev !== undefined) out.rev = rev;
  return { requestId, payloadDigest: digest, at, pending, reply: out };
}

/** The frame of a tap reply as the record keeps it. */
export function receiptFrame(reply: TrickTapReply): NonNullable<TrickReceiptRecord["reply"]> {
  const out: NonNullable<TrickReceiptRecord["reply"]> = { code: reply.code };
  if (reply.message !== undefined) out.message = reply.message;
  if (reply.rev !== undefined) out.rev = reply.rev;
  return out;
}

/** What the tap path needs of the store: the surface, plus the write that comes before the run. */
export type TrickReceiptSurface = ReceiptSurface<TrickReceiptRecord, TrickTapReply> & {
  /** Store one record and say whether it reached disk. False: the program does not run. */
  recordFirst(record: TrickReceiptRecord): Promise<boolean>;
  /** Read the file once, before the first lookup. */
  load(): Promise<void>;
};

/** The file-backed store the tricks runner builds once per bridge. */
export class TrickReceiptStore extends ReceiptFileStore<TrickReceiptRecord, TrickTapReply> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line)) {
    super(tricksStateDir(stateDir), join(tricksStateDir(stateDir), TRICK_RECEIPTS_FILE), coerceTrickReceipt, warn, "tricks");
  }
}

/** A store with no file, for a test. Its first write never fails. */
export function memoryTrickReceipts(): TrickReceiptSurface {
  const store = memoryReceipts<TrickReceiptRecord, TrickTapReply>();
  return {
    ...store,
    recordFirst: async (record) => {
      await store.record(record);
      return true;
    },
    load: () => Promise.resolve(),
  };
}
