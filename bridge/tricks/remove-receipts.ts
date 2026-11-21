import { join } from "node:path";

import type { JsonValue } from "../json.ts";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { isTrickId } from "../../web/src/lib/tricks/schema.ts";
import { isRequestId, memoryReceipts, ReceiptFileStore, type ForgettingReceiptSurface } from "../worktree-receipts.ts";
import { tricksStateDir } from "./paths.ts";
import { REMOVE_LINK_LINE, REMOVE_ON_LINE, REMOVE_RUNNING_LINE, type RemoveRefusal } from "./remove.ts";

// ── One receipt per remove, on disk, so a retried remove never deletes twice (ADR 0168) ─────────────
//
// The tap's pattern (receipts.ts) over the same `ReceiptFileStore`: a remove's `rid` keys one record in
// `<stateDir>/tricks/remove-receipts.json`, written BEFORE anything is renamed, as an in-flight marker
// (`pending: true`), and completed with the outcome after. A bridge that restarts in between finds only the
// marker: a retry of that `rid` answers `unknown` and removes nothing. A completed record answers the same
// answer again, also after a restart, and never acts again: an old `rid` cannot remove a different trick added
// later under the same id. The record keeps the trick id, the device label and the outcome, never content.
//
// Written on the first remove and on nothing else, so a bridge nobody removes a trick on writes no file.
//
// Each record carries `v`. A record of a later version, or with an outcome this build does not know, is KEPT as it
// is (a rewrite of the file keeps it whole) and answers `unknown`: it never acts. The file keeps the newest
// {@link MAX_RECEIPTS} records (worktree-receipts.ts), so "an old `rid` never acts again" holds while its record
// is among them; an id older than that needs the write right to be sent at all, which could send a new id anyway.

/** The receipt file's name inside `<stateDir>/tricks/`. */
export const REMOVE_RECEIPTS_FILE = "remove-receipts.json";

/** The version of a record this build writes. */
export const REMOVE_RECEIPT_V = 1;

/** How a remove ended: removed, or the refusal it met. */
export type RemoveOutcome = "removed" | RemoveRefusal;

const OUTCOMES: readonly RemoveOutcome[] = ["removed", "unknown-trick", "on", "running", "link"];

function isOutcome(text: string | undefined): text is RemoveOutcome {
  return OUTCOMES.some((one) => one === text);
}

/** One stored record. */
export interface RemoveReceipt {
  /** {@link REMOVE_RECEIPT_V} for a record this build wrote. */
  v: number;
  requestId: string;
  /** The digest of what was asked (the trick id), so the same `rid` for another trick is told apart. */
  payloadDigest: string;
  /** Epoch ms the marker was written. */
  at: number;
  trick: string;
  /** The paired device's label, or null when the gate named none. */
  device: string | null;
  /** True while the remove has not ended: the marker. */
  pending: boolean;
  /** How it ended, once it did: a {@link RemoveOutcome}, or a word of a later build, kept as it is. */
  outcome: string | null;
}

/** One record read off disk, or null when the entry is not one. */
export function coerceRemoveReceipt(raw: JsonValue): RemoveReceipt | null {
  const row = asJsonObject(raw);
  if (row === undefined) return null;
  const requestId = asJsonString(row.requestId);
  const digest = asJsonString(row.payloadDigest);
  const at = asJsonNumber(row.at);
  const trick = asJsonString(row.trick);
  const pending = asJsonBoolean(row.pending);
  const device = row.device === null ? null : asJsonString(row.device);
  const outcome = row.outcome === null ? null : asJsonString(row.outcome);
  // A record of this branch before `v` existed reads as version 1.
  const v = row.v === undefined ? REMOVE_RECEIPT_V : asJsonNumber(row.v);
  if (v === undefined || !isRequestId(requestId) || digest === undefined || at === undefined || trick === undefined || !isTrickId(trick) || pending === undefined || device === undefined || outcome === undefined) return null;
  if (outcome === null && !pending) return null;
  return { v, requestId, payloadDigest: digest, at, trick, device, pending: outcome === null ? true : pending, outcome };
}

/**
 * The answer a stored record gives again: its own for a completed record of this version with an outcome this build
 * knows; `unknown` (nothing is done) for a marker, a later version or an unknown outcome; `request-id-reused` for a
 * record of another trick.
 */
export function storedAnswer(rid: string, digest: string, id: string, stored: RemoveReceipt): RemoveAnswer {
  if (stored.payloadDigest !== digest) return { status: 409, body: { error: "request-id-reused", rid } };
  if (stored.v !== REMOVE_RECEIPT_V || stored.outcome === null || !isOutcome(stored.outcome)) return { status: 409, body: { error: "unknown", message: REMOVE_UNKNOWN_LINE, rid } };
  return removeAnswerOf(rid, id, stored.outcome);
}

/** The answer of the remove route. */
export type RemoveAnswer =
  | { status: 200; body: { rid: string; code: "removed"; id: string } }
  | { status: 400; body: { error: "remove-invalid" } }
  | { status: 404; body: { error: "unknown-host" | "unknown-trick"; rid?: string } }
  | { status: 409; body: { error: "on" | "running" | "link" | "windows" | "tricks-off" | "request-id-reused" | "unknown"; message?: string; rid?: string } }
  | { status: 503; body: { error: "write-failed"; message: string } };

/** What a retry of a remove whose bridge stopped mid-way answers. Nothing is removed for it. */
export const REMOVE_UNKNOWN_LINE = "It is not known whether this remove went through. Read the list of tricks.";
/** What a remove answers when its receipt or its rename could not be written. */
export const REMOVE_WRITE_FAILED_LINE = "The trick could not be removed on this machine. Nothing was removed.";

/** The answer an outcome stands for, the first time and on every replay. */
export function removeAnswerOf(rid: string, id: string, outcome: RemoveOutcome): RemoveAnswer {
  switch (outcome) {
    case "removed":
      return { status: 200, body: { rid, code: "removed", id } };
    case "unknown-trick":
      return { status: 404, body: { error: "unknown-trick", rid } };
    case "on":
      return { status: 409, body: { error: "on", message: REMOVE_ON_LINE, rid } };
    case "running":
      return { status: 409, body: { error: "running", message: REMOVE_RUNNING_LINE, rid } };
    case "link":
      return { status: 409, body: { error: "link", message: REMOVE_LINK_LINE, rid } };
  }
}

/** What the remove route needs of the store. */
export type RemoveReceiptSurface = ForgettingReceiptSurface<RemoveReceipt, RemoveAnswer> & {
  /** Store one record and say whether it reached disk. False: nothing is removed. */
  recordFirst(record: RemoveReceipt): Promise<boolean>;
  /** Read the file once, before the first lookup. */
  load(): Promise<void>;
};

/** The file-backed store the tricks service builds once per bridge. */
export class RemoveReceiptStore extends ReceiptFileStore<RemoveReceipt, RemoveAnswer> {
  constructor(stateDir: string, warn: (line: string) => void = (line) => console.warn(line)) {
    super(tricksStateDir(stateDir), join(tricksStateDir(stateDir), REMOVE_RECEIPTS_FILE), coerceRemoveReceipt, warn, "tricks.remove");
  }
}

/** A store with no file, for a test. Its first write never fails unless `failFirst` says so. */
export function memoryRemoveReceipts(opts: { failFirst?: boolean } = {}): RemoveReceiptSurface {
  const store = memoryReceipts<RemoveReceipt, RemoveAnswer>();
  return {
    ...store,
    recordFirst: async (record) => {
      if (opts.failFirst === true) return false;
      await store.record(record);
      return true;
    },
    load: () => Promise.resolve(),
  };
}
