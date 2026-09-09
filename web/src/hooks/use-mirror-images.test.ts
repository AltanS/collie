import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchHistory } from "@/lib/api";
import type { PaneHistoryResponse } from "@/lib/types";
import { useMirrorImages } from "./use-mirror-images";

// What this hook owes the pane view, beyond "read the images once": it must not turn a burst of
// growth events into a burst of history reads, and it must never let a slow answer from a request
// that has been superseded put the wrong pane's pictures on screen.
//
// `fetchHistory` is mocked and the rest of the API module is the real one, so `imageSrc` still
// applies its own blob/data check to every reference the fixtures name.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fetchHistory: vi.fn(),
}));

const history = vi.mocked(fetchHistory);

/** A blob reference the phone will accept: 64 hex characters. */
const blob = (digit: string): string => `/api/blobs/${digit.repeat(64)}`;
const BLOB_A = blob("a");
const BLOB_B = blob("b");

/** A history page whose turns carry exactly these images, oldest-first. */
function pageWith(urls: readonly string[]): PaneHistoryResponse {
  return {
    paneId: "w1:p1",
    available: true,
    entries: urls.map((url, i) => ({
      uuid: `t${i}`,
      ts: "2026-09-09T06:00:00.000Z",
      role: "assistant" as const,
      parts: [{ kind: "image" as const, url }],
    })),
    hasMore: false,
    total: urls.length,
    fileTruncated: false,
  };
}

/** A promise this test resolves by hand, so a read can be held in flight. */
function held() {
  let answer!: (p: PaneHistoryResponse) => void;
  const promise = new Promise<PaneHistoryResponse>((resolve) => {
    answer = resolve;
  });
  return { promise, answer };
}

describe("useMirrorImages", () => {
  // Call counts are the assertion in most of these, so the mock starts every case at zero.
  beforeEach(() => {
    history.mockReset();
  });

  it("reads once when the mirror first reports a placeholder", async () => {
    history.mockResolvedValue(pageWith([BLOB_A]));
    const { result } = renderHook(() =>
      useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount: 1 }),
    );
    await waitFor(() => expect(result.current).toEqual([BLOB_A]));
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("coalesces a burst of growth into ONE follow-up read", async () => {
    // A tall image lands as several polls in a row, each showing one more cluster. Three growth
    // events during one flight must cost one extra read, not three.
    const first = held();
    history.mockReturnValueOnce(first.promise).mockResolvedValue(pageWith([BLOB_A, BLOB_B]));
    const { rerender } = renderHook(
      ({ clusterCount }) => useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount }),
      { initialProps: { clusterCount: 1 } },
    );
    expect(history).toHaveBeenCalledTimes(1);

    rerender({ clusterCount: 2 });
    rerender({ clusterCount: 3 });
    rerender({ clusterCount: 4 });
    expect(history).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.answer(pageWith([BLOB_A]));
    });
    await waitFor(() => expect(history).toHaveBeenCalledTimes(2));
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("drops an older answer that arrives after a newer one", async () => {
    const slow = held();
    const fast = held();
    history.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const { result, rerender } = renderHook(
      ({ paneId }) => useMirrorImages({ paneId, enabled: true, clusterCount: 1 }),
      { initialProps: { paneId: "w1:p1" } },
    );
    rerender({ paneId: "w1:p2" });
    expect(history).toHaveBeenCalledTimes(2);

    await act(async () => {
      fast.answer(pageWith([BLOB_B]));
    });
    await waitFor(() => expect(result.current).toEqual([BLOB_B]));

    await act(async () => {
      slow.answer(pageWith([BLOB_A]));
    });
    expect(result.current).toEqual([BLOB_B]);
  });

  it("resets on a pane switch and reads the new pane once", async () => {
    history.mockResolvedValueOnce(pageWith([BLOB_A]));
    const { result, rerender } = renderHook(
      ({ paneId }) => useMirrorImages({ paneId, enabled: true, clusterCount: 1 }),
      { initialProps: { paneId: "w1:p1" } },
    );
    await waitFor(() => expect(result.current).toEqual([BLOB_A]));

    const second = held();
    history.mockReturnValueOnce(second.promise);
    rerender({ paneId: "w1:p2" });
    // The first pane's pictures are gone the moment the address changes, before any answer.
    expect(result.current).toEqual([]);
    expect(history).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenLastCalledWith("w1:p2", { limit: 40 }, undefined, expect.anything());

    await act(async () => {
      second.answer(pageWith([BLOB_B]));
    });
    await waitFor(() => expect(result.current).toEqual([BLOB_B]));
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("reads nothing when the count shrinks", async () => {
    history.mockResolvedValue(pageWith([BLOB_A]));
    const { result, rerender } = renderHook(
      ({ clusterCount }) => useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount }),
      { initialProps: { clusterCount: 3 } },
    );
    await waitFor(() => expect(result.current).toEqual([BLOB_A]));
    expect(history).toHaveBeenCalledTimes(1);

    // The image scrolled off. The images in hand still cover what is left, and the alignment runs
    // from the end, so there is nothing to ask for.
    rerender({ clusterCount: 1 });
    expect(history).toHaveBeenCalledTimes(1);
  });
});
