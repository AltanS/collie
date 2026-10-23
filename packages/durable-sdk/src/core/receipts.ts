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

/**
 * What {@link ReceiptStore.claim} answers for a request id and a digest:
 *
 * - `new`: nobody has used the id. The caller now owns it and runs the act. A store that writes a `pending` record does
 *   so before it answers `new`, so two requests with one id cannot both be told `new`.
 * - `pending`: another request is running the act under this id. `digest` is the one it claimed the id for.
 * - `done`: the act ran. `digest` and `reply` are what it was given and what it answered.
 * - `dropped`: the store kept the id's digest and forgot its reply ({@link DroppedReceipt}).
 */
export type Claim =
  | { state: "new" }
  | { state: "pending"; digest: string }
  | { state: "done"; digest: string; reply: object }
  | { state: "dropped"; digest: string };

const DROPPED_MESSAGE = "this request id is older than the receipts this durable agent keeps; it does not run again";

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
  /**
   * Optional. For a store shared by several processes that serve the same program, where "get, then act, then put" lets
   * two of them run one request. `claim` is the atomic first step: it answers {@link Claim} for the id and, for `new`,
   * has already recorded that this caller owns the act (a `pending` record). When a store has `claim`, {@link Receipts}
   * calls it instead of `get`, runs the act on `new`, and calls `put` after a success as before. A failure leaves the
   * claim as it is: the store decides when a `pending` that never finished may be claimed again.
   */
  claim?(requestId: string, digest: string, group: string): Claim | Promise<Claim>;
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
  /** The memory store has no other process to race: `new`, `done` or `dropped`, never `pending`. The ids in flight are {@link Receipts}'s. */
  claim(requestId: string, _digest: string, _group: string): Claim {
    const kept = this.get(requestId);
    if (kept === undefined) return { state: "new" };
    return isDropped(kept) ? { state: "dropped", digest: kept.digest } : { state: "done", digest: kept.digest, reply: kept.reply };
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

/** How long a repeat waits for another process's `pending` act before it answers 500 `receipt-dropped`: under the 5000 ms the adapter allows over TLS (WIRE.md 7.6). */
export const PENDING_WAIT_MS = 4000;
const PENDING_POLL_MS = 100;

export interface ReceiptsOptions {
  /** Only for a store with `claim`. Default {@link PENDING_WAIT_MS}. */
  pendingWaitMs?: number;
  /** How often the wait asks the store again. Default 100 ms. */
  pollMs?: number;
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
  private readonly pendingWaitMs: number;
  private readonly pollMs: number;
  constructor(store: ReceiptStore = new MemoryReceiptStore(), o: ReceiptsOptions = {}) {
    this.store = store;
    this.pendingWaitMs = o.pendingWaitMs ?? PENDING_WAIT_MS;
    this.pollMs = o.pollMs ?? PENDING_POLL_MS;
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

  /**
   * `claim` of a store that has one, asked again while another process's `pending` stands, until it is `done`, or the
   * store hands the id over (`new`), or the wait is over. A `pending` that outlasts the wait is an unknown outcome: the
   * same answer as an id the store dropped, a 5xx the phone offers again with the same id, and the act is not run twice.
   */
  private async claim(claim: NonNullable<ReceiptStore["claim"]>, requestId: string, digest: string, group: string) {
    const until = Date.now() + this.pendingWaitMs;
    for (;;) {
      const claimed = await claim.call(this.store, requestId, digest, group);
      if (claimed.state === "new") return undefined;
      if (claimed.digest !== digest) throw new HttpError(409, "request-id-reused");
      if (claimed.state === "done") return { reply: claimed.reply, replayed: true };
      if (claimed.state === "dropped") throw new HttpError(500, "receipt-dropped", { message: DROPPED_MESSAGE });
      const left = until - Date.now();
      if (left <= 0) throw new HttpError(500, "receipt-dropped", { message: "this request id is still being written; its outcome is unknown, and it does not run again" });
      await new Promise((resolve) => setTimeout(resolve, Math.min(this.pollMs, left)));
    }
  }

  private async first(requestId: string, digest: string, act: () => Promise<object>, group: string) {
    if (this.store.claim !== undefined) {
      const seen = await this.claim(this.store.claim, requestId, digest, group);
      if (seen !== undefined) return seen;
      const reply = await act();
      await this.store.put(requestId, { digest, reply }, group);
      return { reply, replayed: false };
    }
    const kept = await this.store.get(requestId);
    if (kept) {
      if (kept.digest !== digest) throw new HttpError(409, "request-id-reused");
      // Dropped past the cap: the reply is gone, so it cannot be replayed, and running it again could run it
      // twice. A 5xx leaves the outcome unknown (WIRE.md 7.6): the phone offers the same id again, and it is
      // refused again, never run.
      if (isDropped(kept)) throw new HttpError(500, "receipt-dropped", { message: DROPPED_MESSAGE });
      return { reply: kept.reply, replayed: true };
    }
    const reply = await act();
    await this.store.put(requestId, { digest, reply }, group);
    return { reply, replayed: false };
  }
}
