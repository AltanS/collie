// The named errors of the wire (WIRE.md section 3), and the request id memory.

import { createHash } from "node:crypto";
import { LIMITS } from "./rules.ts";

/** A digest of what a request asks for. The same request id with another digest is `request-id-reused`. */
export const digestOf = (payload: unknown): string => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

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

interface Receipt {
  /** Digest of the payload the id was first used for, kept with the id. */
  digest: string;
  done: boolean;
  promise: Promise<object>;
}

/**
 * The request id memory of one epoch. A repeat of a `requestId` returns the first reply with
 * `replayed: true` and runs nothing. A repeat that arrives while the first still runs waits for it.
 * Only a success is kept: a failure leaves nothing behind, so the same id may run again. The same id
 * with a different payload (another route, pane, ask, revision, option, note, turn, text or starter) is
 * `request-id-reused`, also while the first is still running.
 */
export class Receipts {
  private readonly map = new Map<string, Receipt>();
  /** Never below 500 (WIRE.md 7.6). */
  constructor(private readonly limit = LIMITS.requestIds * 2) {
    if (limit < LIMITS.requestIds) throw new RangeError(`the request id memory must hold at least ${LIMITS.requestIds} ids`);
  }

  get size() {
    return this.map.size;
  }

  async run<T extends object>(requestId: string, digest: string, act: () => Promise<T>): Promise<T & { replayed?: true }> {
    const have = this.map.get(requestId);
    if (have) {
      if (have.digest !== digest) throw new HttpError(409, "request-id-reused");
      return { ...((await have.promise) as T), replayed: true };
    }
    const entry: Receipt = { digest, done: false, promise: act() };
    this.map.set(requestId, entry);
    try {
      const reply = (await entry.promise) as T;
      entry.done = true;
      this.evict();
      return reply;
    } catch (e) {
      if (this.map.get(requestId) === entry) this.map.delete(requestId);
      throw e;
    }
  }

  private evict() {
    for (const [id, r] of this.map) {
      if (this.map.size <= this.limit) return;
      if (r.done) this.map.delete(id);
    }
  }
}
