// THE "FIT TO PHONE" LEASE — the policy half of ADR 0049.
//
// The port's `holdSize` is the mechanism: it holds a pane's terminal at a size until the hold is
// released. This file is WHEN it is released, and it is the only caller of `holdSize` in the bridge.
//
//   • A lease starts only from `POST /api/pane/:id/fit`, which the phone sends on the operator's
//     "Fit to phone" tap. Nothing here starts one on its own, and a renewal never starts one: a
//     lease that has lapsed stays lapsed until the operator taps again (ADR 0031's named-tap rule).
//   • It lapses {@link FIT_LAPSE_MS} after the last take or renewal. The phone renews while its pane
//     view is open and stops when the page is hidden, so a pocketed phone lets go on its own.
//   • It is released when the phone says so (`/unfit`), when it lapses, when the bridge stops, or
//     when the hold is lost underneath it (another controller took the terminal).
//
// Releasing is ending the hold and nothing else. The multiplexer restores the size; Collie never
// writes a "previous" one back, because it cannot know it (ADR 0049).

import { muxOk, muxUnreachable, type MuxAdapter, type MuxOutcome, type MuxSize, type MuxSizeHold } from "./mux/types.ts";

/** The one port method a lease uses. Narrowed so the lease cannot reach for anything else. */
export type SizeHolder = Pick<MuxAdapter, "holdSize">;

/** How long a lease outlives its last renewal. The operator chose two minutes (ADR 0049). */
export const FIT_LAPSE_MS = 120_000;

/**
 * The sizes a phone may ask for. The floor keeps a mis-measured phone from handing a TUI a terminal
 * it cannot draw in; the ceiling keeps a hostile body from asking for an absurd PTY.
 */
export const FIT_BOUNDS = { minCols: 20, maxCols: 500, minRows: 8, maxRows: 300 } as const;

/** How long a re-fit waits for Collie's own previous hold to detach before taking the new size. */
const REPLACE_WAIT_MS = 3000;

/** A clock the tests can drive. `schedule` answers the function that cancels what it scheduled. */
export interface FitClock {
  schedule(run: () => void, ms: number): () => void;
}

const realClock: FitClock = {
  schedule(run, ms) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** What a take or a renewal answers: the size held and how long it lasts without another renewal. */
export interface FitHeld {
  readonly size: MuxSize;
  readonly lapseMs: number;
}

/** Whether `size` is inside {@link FIT_BOUNDS}. The body decoder has already made it whole cells. */
export function fitSizeInBounds(size: MuxSize): boolean {
  const { cols, rows } = size;
  return (
    cols >= FIT_BOUNDS.minCols &&
    cols <= FIT_BOUNDS.maxCols &&
    rows >= FIT_BOUNDS.minRows &&
    rows <= FIT_BOUNDS.maxRows
  );
}

interface Lease {
  readonly hold: MuxSizeHold;
  readonly size: MuxSize;
  /** Cancels the pending lapse. */
  cancelLapse: () => void;
}

/** Every lease this bridge holds, one per `(session, pane)`. */
export class FitLeases {
  private readonly leases = new Map<string, Lease>();
  /** The last take per key, so two takes for one pane run one after the other rather than racing. */
  private readonly queue = new Map<string, Promise<unknown>>();
  /**
   * How many times each key has been released. A take reads it before it starts the hold and again
   * after: a release that arrived in between (the phone left while the hold was starting) wins, and
   * the new hold is let go at once instead of outliving the pane view by a whole lapse.
   */
  private readonly releases = new Map<string, number>();
  private closed = false;

  constructor(
    private readonly clock: FitClock = realClock,
    private readonly lapseMs: number = FIT_LAPSE_MS,
  ) {}

  /**
   * Take a lease at `size`, or move Collie's own lease on this pane to it.
   *
   * The same size again is a renewal. A different size releases Collie's own hold FIRST and waits
   * for it to detach, because the multiplexer admits one controller per terminal and would refuse
   * Collie's new hold as held by somebody else — somebody who is Collie.
   */
  take(adapter: SizeHolder, session: string, paneId: string, size: MuxSize): Promise<MuxOutcome<FitHeld>> {
    const key = leaseKey(session, paneId);
    const previous = this.queue.get(key) ?? Promise.resolve();
    const next = previous.then(
      () => this.takeNow(adapter, key, paneId, size),
      () => this.takeNow(adapter, key, paneId, size),
    );
    this.queue.set(key, next);
    void next.finally(() => {
      if (this.queue.get(key) === next) this.queue.delete(key);
    });
    return next;
  }

  /** Extend a lease that is still held. `null` when there is none: a renewal never takes one. */
  renew(session: string, paneId: string): FitHeld | null {
    const lease = this.leases.get(leaseKey(session, paneId));
    if (lease === undefined) return null;
    this.arm(leaseKey(session, paneId), lease);
    return { size: lease.size, lapseMs: this.lapseMs };
  }

  /** Let go of a pane's lease. Idempotent: releasing nothing is a success. */
  release(session: string, paneId: string): void {
    const key = leaseKey(session, paneId);
    this.releases.set(key, (this.releases.get(key) ?? 0) + 1);
    this.drop(key);
  }

  /** Let go of every lease, and refuse new ones. For the bridge's shutdown. */
  closeAll(): void {
    this.closed = true;
    // Deleting the entry being visited is safe in a Map iteration; later keys are still visited.
    for (const key of this.leases.keys()) this.drop(key);
  }

  /** How many leases are held. For tests and diagnostics. */
  get size(): number {
    return this.leases.size;
  }

  private async takeNow(adapter: SizeHolder, key: string, paneId: string, size: MuxSize): Promise<MuxOutcome<FitHeld>> {
    if (this.closed) return muxUnreachable("the bridge is shutting down");
    const releasedBefore = this.releases.get(key) ?? 0;
    const current = this.leases.get(key);
    if (current !== undefined && sameSize(current.size, size)) {
      this.arm(key, current);
      return muxOk({ size, lapseMs: this.lapseMs });
    }
    if (current !== undefined) {
      this.drop(key);
      await settledWithin(current.hold.ended, REPLACE_WAIT_MS);
    }
    const held = await adapter.holdSize(paneId, size);
    if (!held.ok) return held;
    if (this.closed) {
      held.value.release();
      return muxUnreachable("the bridge is shutting down");
    }
    if ((this.releases.get(key) ?? 0) !== releasedBefore) {
      held.value.release();
      return muxUnreachable("the fit was released while it was being taken");
    }
    const lease: Lease = { hold: held.value, size, cancelLapse: () => undefined };
    this.leases.set(key, lease);
    this.arm(key, lease);
    // A hold lost underneath the lease (another controller took the terminal, the child died) ends
    // the lease too, so a renewal after it answers "lapsed" instead of extending a hold that is gone.
    void held.value.ended.then(() => this.forget(key, lease));
    return muxOk({ size, lapseMs: this.lapseMs });
  }

  /** Drop a lease whose hold has already ended, without releasing it again. True when it was current. */
  private forget(key: string, lease: Lease): boolean {
    if (this.leases.get(key) !== lease) return false;
    lease.cancelLapse();
    this.leases.delete(key);
    return true;
  }

  private arm(key: string, lease: Lease): void {
    lease.cancelLapse();
    lease.cancelLapse = this.clock.schedule(() => {
      if (this.leases.get(key) === lease) this.drop(key);
    }, this.lapseMs);
  }

  private drop(key: string): void {
    const lease = this.leases.get(key);
    if (lease === undefined) return;
    this.leases.delete(key);
    lease.cancelLapse();
    lease.hold.release();
  }
}

function leaseKey(session: string, paneId: string): string {
  return `${session}\0${paneId}`;
}

function sameSize(a: MuxSize, b: MuxSize): boolean {
  return a.cols === b.cols && a.rows === b.rows;
}

/** Wait for `ended`, but no longer than `ms`. `ended` never rejects (MuxSizeHold). */
async function settledWithin(ended: Promise<string>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<string>((resolve) => {
    timer = setTimeout(() => resolve("timed out"), ms);
  });
  await Promise.race([ended, timeout]);
  clearTimeout(timer);
}
