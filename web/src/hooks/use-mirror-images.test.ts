import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchHistory } from "@/lib/api";
import type { PaneHistoryResponse, TranscriptEntry } from "@/lib/types";
import { finishedTurnKey, useMirrorImages } from "./use-mirror-images";

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
    await waitFor(() => expect(result.current.images).toEqual([BLOB_A]));
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
    await waitFor(() => expect(result.current.images).toEqual([BLOB_B]));

    await act(async () => {
      slow.answer(pageWith([BLOB_A]));
    });
    expect(result.current.images).toEqual([BLOB_B]);
  });

  it("resets on a pane switch and reads the new pane once", async () => {
    history.mockResolvedValueOnce(pageWith([BLOB_A]));
    const { result, rerender } = renderHook(
      ({ paneId }) => useMirrorImages({ paneId, enabled: true, clusterCount: 1 }),
      { initialProps: { paneId: "w1:p1" } },
    );
    await waitFor(() => expect(result.current.images).toEqual([BLOB_A]));

    const second = held();
    history.mockReturnValueOnce(second.promise);
    rerender({ paneId: "w1:p2" });
    // The first pane's pictures are gone the moment the address changes, before any answer.
    expect(result.current.images).toEqual([]);
    expect(history).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenLastCalledWith("w1:p2", { limit: 40 }, undefined, expect.anything());

    await act(async () => {
      second.answer(pageWith([BLOB_B]));
    });
    await waitFor(() => expect(result.current.images).toEqual([BLOB_B]));
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("reads nothing when the count shrinks", async () => {
    history.mockResolvedValue(pageWith([BLOB_A]));
    const { result, rerender } = renderHook(
      ({ clusterCount }) => useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount }),
      { initialProps: { clusterCount: 3 } },
    );
    await waitFor(() => expect(result.current.images).toEqual([BLOB_A]));
    expect(history).toHaveBeenCalledTimes(1);

    // The image scrolled off. The images in hand still cover what is left, and the alignment runs
    // from the end, so there is nothing to ask for.
    rerender({ clusterCount: 1 });
    expect(history).toHaveBeenCalledTimes(1);
  });
});

// ── Trigger two: a finished turn on an agent that draws off the grid (#292) ─────────────────────
//
// pi draws by direct placement, which leaves no placeholder, so no cluster count ever grows. The
// pane view passes a key that changes when the agent's status leaves `working`; each new key costs
// one read, and the newest turn's picture comes back as the card unless a cluster already shows it.

/** A page in the shape pi 0.87.1 writes: prompt, the read tool's result carrying the picture, reply. */
function turnPage(entries: TranscriptEntry[]): PaneHistoryResponse {
  return { paneId: "w1:p1", available: true, entries, hasMore: false, total: entries.length, fileTruncated: false };
}
const prompt = (uuid: string): TranscriptEntry => ({
  uuid,
  ts: "",
  role: "user",
  parts: [{ kind: "text", text: "Read ./dot.png and reply OK" }],
});
const readTool = (uuid: string, url: string): TranscriptEntry => ({
  uuid,
  ts: "",
  role: "assistant",
  parts: [{ kind: "tool", name: "read", summary: "./dot.png", result: { text: "Read image file [image/png]", imageUrl: url } }],
});
const reply = (uuid: string): TranscriptEntry => ({ uuid, ts: "", role: "assistant", parts: [{ kind: "text", text: "OK" }] });
const PICTURE_TURN = turnPage([prompt("u1"), readTool("a1", BLOB_A), reply("a2")]);
/** The props a turn case renders with: a finished turn's key, or `null` while the agent works. */
interface TurnProps {
  finishedTurn: string | null;
}
/** The props a case starts from: a turn that finished. */
const firstTurn = (): TurnProps => ({ finishedTurn: "1000" });

describe("useMirrorImages — the newest turn's picture", () => {
  beforeEach(() => {
    history.mockReset();
  });

  it("reads once for a session pane whose finished turn holds a picture, with no cluster on screen", async () => {
    history.mockResolvedValue(PICTURE_TURN);
    const { result } = renderHook(() =>
      useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount: 0, finishedTurn: "1000" }),
    );
    await waitFor(() => expect(result.current.turnImage).toBe(BLOB_A));
    expect(history).toHaveBeenCalledTimes(1);
    expect(history).toHaveBeenLastCalledWith("w1:p1", { limit: 40 }, undefined, expect.anything());
  });

  it("reads nothing for a pane with no session", async () => {
    history.mockResolvedValue(PICTURE_TURN);
    const { result } = renderHook(() =>
      useMirrorImages({ paneId: "w1:p1", enabled: false, clusterCount: 0, finishedTurn: "1000" }),
    );
    await act(async () => {});
    expect(history).not.toHaveBeenCalled();
    expect(result.current.turnImage).toBeNull();
  });

  it("reads nothing per turn for an agent that draws no picture off the grid", async () => {
    history.mockResolvedValue(PICTURE_TURN);
    const { result } = renderHook(() =>
      useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount: 0, finishedTurn: undefined }),
    );
    await act(async () => {});
    expect(history).not.toHaveBeenCalled();
    expect(result.current.turnImage).toBeNull();
  });

  it("does not show a picture twice when a placeholder cluster of the same turn shows it", async () => {
    // Oh My Pi with PI_KITTY_PLACEHOLDERS=1: both sources carry the picture. The cluster takes it.
    history.mockResolvedValue(PICTURE_TURN);
    const { result } = renderHook(() =>
      useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount: 1, finishedTurn: "1000" }),
    );
    await waitFor(() => expect(result.current.images).toEqual([BLOB_A]));
    expect(result.current.turnImage).toBeNull();
    // One read answered both triggers: the cluster's read was already out for this turn.
    expect(history).toHaveBeenCalledTimes(1);
  });

  it("does not read the same turn's picture again", async () => {
    history.mockResolvedValue(PICTURE_TURN);
    const { result, rerender } = renderHook(
      ({ finishedTurn }: TurnProps) =>
        useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount: 0, finishedTurn }),
      { initialProps: firstTurn() },
    );
    await waitFor(() => expect(result.current.turnImage).toBe(BLOB_A));
    const shown = result.current;

    // A poll that changes nothing, and the same key again: no read, and the same object back.
    rerender({ finishedTurn: "1000" });
    rerender({ finishedTurn: "1000" });
    expect(history).toHaveBeenCalledTimes(1);
    expect(result.current).toBe(shown);

    // The agent starts a new turn: nothing is read while it works, and the old card stands down.
    rerender({ finishedTurn: null });
    expect(history).toHaveBeenCalledTimes(1);
    expect(result.current.turnImage).toBeNull();
  });

  it("removes the card when a later turn finishes without a picture", async () => {
    history.mockResolvedValueOnce(PICTURE_TURN);
    const { result, rerender } = renderHook(
      ({ finishedTurn }: TurnProps) =>
        useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount: 0, finishedTurn }),
      { initialProps: firstTurn() },
    );
    await waitFor(() => expect(result.current.turnImage).toBe(BLOB_A));

    const later = held();
    history.mockReturnValueOnce(later.promise);
    rerender({ finishedTurn: null });
    rerender({ finishedTurn: "2000" });
    expect(history).toHaveBeenCalledTimes(2);
    // Until the new turn's read answers, the older turn's picture is not shown as this turn's.
    expect(result.current.turnImage).toBeNull();

    await act(async () => {
      later.answer(turnPage([prompt("u1"), readTool("a1", BLOB_A), reply("a2"), prompt("u2"), reply("a3")]));
    });
    expect(result.current.turnImage).toBeNull();
  });

  it("shows the next turn's picture when that turn has one", async () => {
    history
      .mockResolvedValueOnce(PICTURE_TURN)
      .mockResolvedValueOnce(turnPage([prompt("u1"), readTool("a1", BLOB_A), reply("a2"), prompt("u2"), readTool("a3", BLOB_B), reply("a4")]));
    const { result, rerender } = renderHook(
      ({ finishedTurn }: TurnProps) =>
        useMirrorImages({ paneId: "w1:p1", enabled: true, clusterCount: 0, finishedTurn }),
      { initialProps: firstTurn() },
    );
    await waitFor(() => expect(result.current.turnImage).toBe(BLOB_A));
    rerender({ finishedTurn: null });
    rerender({ finishedTurn: "2000" });
    await waitFor(() => expect(result.current.turnImage).toBe(BLOB_B));
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("drops the card on a pane switch and reads the new pane's turn once", async () => {
    history.mockResolvedValueOnce(PICTURE_TURN);
    const { result, rerender } = renderHook(
      ({ paneId }) => useMirrorImages({ paneId, enabled: true, clusterCount: 0, finishedTurn: "1000" }),
      { initialProps: { paneId: "w1:p1" } },
    );
    await waitFor(() => expect(result.current.turnImage).toBe(BLOB_A));

    const second = held();
    history.mockReturnValueOnce(second.promise);
    rerender({ paneId: "w1:p2" });
    expect(result.current.turnImage).toBeNull();
    expect(history).toHaveBeenCalledTimes(2);
    expect(history).toHaveBeenLastCalledWith("w1:p2", { limit: 40 }, undefined, expect.anything());
  });
});

describe("finishedTurnKey", () => {
  it("is undefined for an agent that draws no picture off the grid, or no agent", () => {
    expect(finishedTurnKey({ agent: "claude", status: "idle", lastActiveAt: 5 })).toBeUndefined();
    expect(finishedTurnKey(undefined)).toBeUndefined();
  });

  it("is null while a pi or omp agent works, and its last transition once it stops", () => {
    expect(finishedTurnKey({ agent: "pi", status: "working", lastActiveAt: 5 })).toBeNull();
    expect(finishedTurnKey({ agent: "pi", status: "done", lastActiveAt: 7 })).toBe("7");
    expect(finishedTurnKey({ agent: "omp", status: "idle", lastActiveAt: 9 })).toBe("9");
  });

  it("is one constant key on a bridge too old to send lastActiveAt: one read on open", () => {
    expect(finishedTurnKey({ agent: "pi", status: "idle" })).toBe("0");
  });
});
