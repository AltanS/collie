// The named errors of the wire (WIRE.md section 3), and the request id memory (WIRE.md 7.6).
// No runtime import: the digest is the core's own SHA-256.

import { sha256Hex } from "./hash.ts";
import { LIMITS } from "./rules.ts";

/** A digest of what a request asks for. The same request id with another digest is `request-id-reused`. */
export const digestOf = (payload: unknown): string => sha256Hex(JSON.stringify(payload));

/** An error the server answers with a status and a `Problem` body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** More fields of the `Problem`: `message`, `turnId`, `askIds`, `ask`, `range`. */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/** One finished request: the digest of its payload and the reply it got. Never the payload itself. */
export interface ReceiptRecord {
  digest: string;
  reply: object;
}

/**
 * Where finished request ids are kept. The wire asks for at least the last 500 of an epoch, and SHOULD keep them
 * across a restart: a store on disk or in a database does, the memory store does not. Either method may return a
 * promise. Only successes reach `put`.
 */
export interface ReceiptStore {
  get(requestId: string): ReceiptRecord | undefined | Promise<ReceiptRecord | undefined>;
  put(requestId: string, record: ReceiptRecord): void | Promise<void>;
}

/** The default store: a map that drops its oldest ids past `limit`. Gone when the process ends. */
export class MemoryReceiptStore implements ReceiptStore {
  private readonly map = new Map<string, ReceiptRecord>();
  /** Never below 500 (WIRE.md 7.6). */
  constructor(private readonly limit = LIMITS.requestIds * 2) {
    if (limit < LIMITS.requestIds) throw new RangeError(`the request id memory must hold at least ${LIMITS.requestIds} ids`);
  }
  get size() {
    return this.map.size;
  }
  get(requestId: string) {
    return this.map.get(requestId);
  }
  put(requestId: string, record: ReceiptRecord) {
    this.map.set(requestId, record);
    for (const id of this.map.keys()) {
      if (this.map.size <= this.limit) return;
      this.map.delete(id);
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
  constructor(private readonly store: ReceiptStore = new MemoryReceiptStore()) {}

  async run<T extends object>(requestId: string, digest: string, act: () => Promise<T>): Promise<T & { replayed?: true }> {
    const have = this.flying.get(requestId);
    if (have) {
      if (have.digest !== digest) throw new HttpError(409, "request-id-reused");
      return { ...((await have.promise).reply as T), replayed: true };
    }
    // The entry is in the map before the first await, so a repeat that arrives a moment later waits for this one.
    const entry: Flying = { digest, promise: this.first(requestId, digest, act) };
    this.flying.set(requestId, entry);
    try {
      const { reply, replayed } = await entry.promise;
      return replayed ? { ...(reply as T), replayed: true } : (reply as T);
    } finally {
      if (this.flying.get(requestId) === entry) this.flying.delete(requestId);
    }
  }

  private async first(requestId: string, digest: string, act: () => Promise<object>) {
    const kept = await this.store.get(requestId);
    if (kept) {
      if (kept.digest !== digest) throw new HttpError(409, "request-id-reused");
      return { reply: kept.reply, replayed: true };
    }
    const reply = await act();
    await this.store.put(requestId, { digest, reply });
    return { reply, replayed: false };
  }
}
