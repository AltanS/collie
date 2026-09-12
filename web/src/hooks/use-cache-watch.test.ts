import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { useCacheWatch } from "./use-cache-watch";
import type { CacheWatchState } from "@/lib/types";

// One pane's own switch (ADR 0042): read once when the sheet opens — not before, because the answer
// moves (the global switch, the bridge's own warnSeconds) — then toggle optimistically with a loud
// revert on failure. `lib/mutate` is what publishes the error sentence; its own tests already pin
// that behaviour, so this file only asserts the revert.

const state = (over: Partial<CacheWatchState> = {}): CacheWatchState => ({
  on: false,
  global: false,
  watchable: true,
  warnSeconds: 300,
  ...over,
});

/** Count reads, keeping the given response. */
function countReads(response: CacheWatchState) {
  let hits = 0;
  server.use(
    http.get("/api/notifications/cache-watch", () => {
      hits += 1;
      return HttpResponse.json(response);
    }),
  );
  return { hits: () => hits };
}

describe("useCacheWatch", () => {
  it("reads nothing while the sheet is closed", async () => {
    const reads = countReads(state());
    const { result } = renderHook(() => useCacheWatch("w1:p1", false));

    // Give any errant fetch a tick to have fired.
    await Promise.resolve();
    expect(result.current.state).toBeNull();
    expect(reads.hits()).toBe(0);
  });

  it("reads on open", async () => {
    const reads = countReads(state({ warnSeconds: 300 }));
    const { result, rerender } = renderHook(({ open }) => useCacheWatch("w1:p1", open), {
      initialProps: { open: false },
    });
    expect(reads.hits()).toBe(0);

    rerender({ open: true });

    await waitFor(() => expect(result.current.state).toEqual(state({ warnSeconds: 300 })));
    expect(reads.hits()).toBe(1);
  });

  it("toggles optimistically and reconciles with the bridge's merged view", async () => {
    server.use(
      http.get("/api/notifications/cache-watch", () => HttpResponse.json(state())),
      http.post<never, { on: boolean }>("/api/notifications/cache-watch", async ({ request }) => {
        const { on } = await request.json();
        // The reconciled view is not a bare echo — it also reports what only the server knows, so
        // the assertion below can tell a reconcile from a locally-guessed value.
        return HttpResponse.json(state({ on, warnSeconds: 600 }));
      }),
    );
    const { result } = renderHook(() => useCacheWatch("w1:p1", true));
    await waitFor(() => expect(result.current.state).toEqual(state()));

    let outcome: Promise<void> = Promise.resolve();
    act(() => {
      outcome = result.current.toggle(true);
    });
    expect(result.current.state?.on).toBe(true); // optimistic, before the server answered

    await act(async () => {
      await outcome;
    });

    await waitFor(() => expect(result.current.state).toEqual(state({ on: true, warnSeconds: 600 })));
    expect(result.current.busy).toBe(false);
  });

  it("reverts loudly when the toggle fails", async () => {
    server.use(
      http.get("/api/notifications/cache-watch", () => HttpResponse.json(state({ on: false }))),
      http.post("/api/notifications/cache-watch", () => new HttpResponse(null, { status: 500 })),
    );
    const { result } = renderHook(() => useCacheWatch("w1:p1", true));
    await waitFor(() => expect(result.current.state).toEqual(state({ on: false })));

    let outcome: Promise<void> = Promise.resolve();
    act(() => {
      outcome = result.current.toggle(true);
    });
    expect(result.current.state?.on).toBe(true); // optimistic

    await act(async () => {
      await outcome;
    });

    // The revert: back to off, exactly as it read before the tap.
    await waitFor(() => expect(result.current.state?.on).toBe(false));
    expect(result.current.busy).toBe(false);
  });
});
