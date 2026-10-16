// The named errors of the wire (WIRE.md section 3), and the request id memory (WIRE.md 7.6).
// No runtime import: the digest is the core's own SHA-256.

import { sha256Hex } from "./hash.ts";
import { LIMITS } from "./rules.ts";
import type { Json, Problem } from "./types.ts";

/** A digest of what a request asks for. The same request id with another digest is `request-id-reused`. */
export const digestOf = (payload: Json): string => sha256Hex(JSON.stringify(payload));

/** An error the server answers with a status and a `Problem` body. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** More fields of the `Problem`: `message`, `turnId`, `askIds`, `ask`, `range`. */
  readonly extra: Omit<Problem, "code">;
  constructor(status: number, code: string, extra: Omit<Problem, "code"> = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** One finished request: the digest of its payload and the reply it got. Never the payload itself. */
export interface ReceiptRecord {
  digest: string;
  reply: object;
}

/**
 * What a store answers for a request id it dropped past its cap: the digest the id was used for, and no reply.
 * A repeat of that id is refused with an unknown outcome (a 5xx, WIRE.md 7.6) and never runs again.
 */
export interface DroppedReceipt {
  dropped: true;
  digest: string;
}

/** The receipts of one pane share a cap. A starter's receipts share the group `starter`. */
export const STARTER_GROUP = "starter";

/** A rename's receipts share the group `rename`. */
export const RENAME_GROUP = "rename";

/** A close's receipts share the group `close`. */
export const CLOSE_GROUP = "close";

/** A reopen's receipts share the group `reopen` (WIRE.md 7.16). */
export const REOPEN_GROUP = "reopen";

/** How many receipts a store keeps per group (per pane, the starters, the renames, the closes and the reopens), newest first. */
export const RECEIPTS_PER_GROUP = 1000;

/**
 * Where finished request ids are kept. The wire asks for at least the last 500 of an epoch, and SHOULD keep them
 * across a restart: a store on disk or in a database does, the memory store does not. Either method may return a
 * promise. Only successes reach `put`.
 *
 * A store with a cap keeps the newest {@link RECEIPTS_PER_GROUP} per `group` (the pane id, or {@link STARTER_GROUP}),
 * drops the older ones in the same write, and remembers each dropped id as a {@link DroppedReceipt}.
 */
export interface ReceiptStore {
  get(requestId: string): ReceiptRecord | DroppedReceipt | undefined | Promise<ReceiptRecord | DroppedReceipt | undefined>;
  put(requestId: string, record: ReceiptRecord, group: string): void | Promise<void>;
}

/** Is this what a store answers for an id it dropped? */
export const isDropped = (kept: ReceiptRecord | DroppedReceipt | undefined): kept is DroppedReceipt => kept !== undefined && "dropped" in kept;

/**
 * The default store: a map per group that drops its oldest receipts past `limit` (per group). Gone when the process
 * ends. The ids it dropped are kept as their digest only, at most `limit * 10` per group, so a repeat of one is
 * refused; past that the oldest of them go too, and the act's own check (a closed ask, a turn that moved) is
 * what is left.
 */
export class MemoryReceiptStore implements ReceiptStore {
  private readonly groups = new Map<string, Map<string, ReceiptRecord>>();
  private readonly dropped = new Map<string, Map<string, string>>();
  private readonly where = new Map<string, string>();
  private readonly limit: number;
  /** Never below 500 (WIRE.md 7.6). */
  constructor(limit = RECEIPTS_PER_GROUP) {
    this.limit = limit;
    if (limit < LIMITS.requestIds) throw new RangeError(`the request id memory must hold at least ${LIMITS.requestIds} ids`);
  }
  /** Receipts kept, over every group. Dropped ids do not count. */
  get size() {
    let n = 0;
    for (const group of this.groups.values()) n += group.size;
    return n;
  }
  get(requestId: string): ReceiptRecord | DroppedReceipt | undefined {
    const group = this.where.get(requestId);
    if (group === undefined) return undefined;
    const kept = this.groups.get(group)?.get(requestId);
    if (kept !== undefined) return kept;
    const digest = this.dropped.get(group)?.get(requestId);
    return digest === undefined ? undefined : { dropped: true, digest };
  }
  put(requestId: string, record: ReceiptRecord, group = "") {
    const live = this.groups.get(group) ?? new Map<string, ReceiptRecord>();
    this.groups.set(group, live);
    const gone = this.dropped.get(group) ?? new Map<string, string>();
    this.dropped.set(group, gone);
    live.set(requestId, record);
    this.where.set(requestId, group);
    for (const [id, old] of live) {
      if (live.size <= this.limit) break;
      live.delete(id);
      gone.set(id, old.digest);
    }
    for (const id of gone.keys()) {
      if (gone.size <= this.limit * 10) break;
      gone.delete(id);
      this.where.delete(id);
    }
  }
}

interface Flying {
  /** Digest of the payload the id was first used for. */
  digest: string;
  promise: Promise<{ reply: object; replayed: boolean }>;
}

/**
 * The request id memory. A repeat of a `requestId` returns the first reply with `replayed: true` and runs nothing.
 * A repeat that arrives while the first still runs waits for it. Only a success is kept: a failure leaves nothing
 * behind, so the same id may run again. The same id with a different payload (another route, pane, ask, revision,
 * option, note, turn, text or starter) is `request-id-reused`, also while the first is still running.
 *
 * The ids in flight live in memory. Finished ones go to the `ReceiptStore`.
 */
export class Receipts {
  private readonly flying = new Map<string, Flying>();
  private readonly store: ReceiptStore;
  constructor(store: ReceiptStore = new MemoryReceiptStore()) {
    this.store = store;
  }

  /** `group`: the pane id, or {@link STARTER_GROUP}. The store caps its receipts per group. */
  async run<T extends object>(requestId: string, digest: string, act: () => Promise<T>, group = ""): Promise<T & { replayed?: true }> {
    const have = this.flying.get(requestId);
    if (have) {
      if (have.digest !== digest) throw new HttpError(409, "request-id-reused");
      // SAFETY: the digest names the route and the payload, so the reply under this id and digest came from the same act, which returns T.
      return { ...((await have.promise).reply as T), replayed: true };
    }
    // The entry is in the map before the first await, so a repeat that arrives a moment later waits for this one.
    const entry: Flying = { digest, promise: this.first(requestId, digest, act, group) };
    this.flying.set(requestId, entry);
    try {
      const { reply, replayed } = await entry.promise;
      // SAFETY: a replayed reply was kept under this id and digest, and the digest names the route, so the act that made it returns T too.
      return replayed ? { ...(reply as T), replayed: true } : (reply as T);
    } finally {
      if (this.flying.get(requestId) === entry) this.flying.delete(requestId);
    }
  }

  private async first(requestId: string, digest: string, act: () => Promise<object>, group: string) {
    const kept = await this.store.get(requestId);
    if (kept) {
      if (kept.digest !== digest) throw new HttpError(409, "request-id-reused");
      // Dropped past the cap: the reply is gone, so it cannot be replayed, and running it again could run it
      // twice. A 5xx leaves the outcome unknown (WIRE.md 7.6): the phone offers the same id again, and it is
      // refused again, never run.
      if (isDropped(kept)) throw new HttpError(500, "receipt-dropped", { message: "this request id is older than the receipts this durable agent keeps; it does not run again" });
      return { reply: kept.reply, replayed: true };
    }
    const reply = await act();
    await this.store.put(requestId, { digest, reply }, group);
    return { reply, replayed: false };
  }
}
