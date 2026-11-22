// Shared by the tricks tests: wait for the thing itself, not for a fixed time. Not a test file.

import type { TricksService } from "./service.ts";

/**
 * Wait until `ready()` holds, looking every 5 ms; at `ms` throw with `what`, the thing that never
 * happened. A fixed sleep that stands in for "until X happened" holds only on a fast machine:
 * GitHub's Windows runner missed a 50 ms one and a 60 ms one (2026-11-22). The deadline is far
 * above what X takes and below the 5 s test limit, so a miss names X instead of a timeout.
 *
 * For a positive expectation only. "X did NOT happen" needs a settle point (`service.idle()`, a run's
 * end, a fake timer the test fires), never a wait that would also pass if X came late.
 */
export async function until(ready: () => boolean, what: string, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`waited ${String(ms)} ms for ${what}, and it did not happen`);
    await Bun.sleep(5);
  }
}

/** A phone's tap waits in the trick's one queue slot. No door shows it, so the test reads the service's own field. */
export const tapQueued = (service: TricksService, id: string): boolean => (service["runtimes"].get(id)?.queued ?? null) !== null;
