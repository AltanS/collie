import { act, renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { useCacheWatchList } from "./use-cache-watch-list";
import type { CacheWatchListEntry } from "@/lib/types";

// The Settings card's watched-pane list (ADR 0042): loads once, and removal is optimistic with a
// server-reconciled last word. `lib/mutate` is what publishes the error sentence on a failed forget —
// that behaviour is already pinned by mutate's own tests, so this file only asserts the REVERT.

const ENTRIES: CacheWatchListEntry[] = [
  { id: "e1", label: "web-worker" },
  { id: "e2", label: "backend", host: "minibuch" },
];

describe("useCacheWatchList", () => {
  it("loads the list", async () => {
    server.use(http.get("/api/notifications/cache-watch/list", () => HttpResponse.json({ entries: ENTRIES })));

    const { result } = renderHook(() => useCacheWatchList());

    expect(result.current.entries).toBeNull();
    await waitFor(() => expect(result.current.entries).toEqual(ENTRIES));
  });

  it("forget removes optimistically and reconciles with the server's returned list", async () => {
    server.use(
      http.get("/api/notifications/cache-watch/list", () => HttpResponse.json({ entries: ENTRIES })),
      http.post<never, { id: string }>("/api/notifications/cache-watch/forget", async ({ request }) => {
        const { id } = await request.json();
        // The server's answer is the last word: it drops the requested id AND relabels the survivor,
        // so a test that only checked "id gone" could not tell an optimistic filter from a reconcile.
        return HttpResponse.json({
          entries: ENTRIES.filter((e) => e.id !== id).map((e) => Object.assign({}, e, { label: "renamed-by-server" })),
        });
      }),
    );

    const { result } = renderHook(() => useCacheWatchList());
    await waitFor(() => expect(result.current.entries).toEqual(ENTRIES));

    let outcome: Promise<void> = Promise.resolve();
    act(() => {
      outcome = result.current.forget("e1");
    });
    // Optimistic: the row is gone before the server has answered.
    expect(result.current.entries?.find((e) => e.id === "e1")).toBeUndefined();
    await act(async () => {
      await outcome;
    });

    await waitFor(() =>
      expect(result.current.entries).toEqual([{ id: "e2", host: "minibuch", label: "renamed-by-server" }]),
    );
    expect(result.current.busy).toBe(false);
  });

  it("a failing forget puts the row back", async () => {
    server.use(
      http.get("/api/notifications/cache-watch/list", () => HttpResponse.json({ entries: ENTRIES })),
      http.post("/api/notifications/cache-watch/forget", () => new HttpResponse(null, { status: 500 })),
    );

    const { result } = renderHook(() => useCacheWatchList());
    await waitFor(() => expect(result.current.entries).toEqual(ENTRIES));

    let outcome: Promise<void> = Promise.resolve();
    act(() => {
      outcome = result.current.forget("e1");
    });
    expect(result.current.entries?.find((e) => e.id === "e1")).toBeUndefined(); // optimistic

    await act(async () => {
      await outcome;
    });

    // The revert: "e1" is back, in its original place — not just present, but the same list it was.
    await waitFor(() => expect(result.current.entries).toEqual(ENTRIES));
    expect(result.current.busy).toBe(false);
  });
});
