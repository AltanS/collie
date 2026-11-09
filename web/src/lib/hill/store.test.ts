import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { HILL_T0, hillDecision, hillReceipt } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

import { __resetHill, __settleHill, noteHillAnswer, syncHill, useHillAnswerHeld, useHillCount, useHillKept, useHillOpen } from "./store";
import type { HillDecision } from "./wire";

// The snapshot's hillRev says when to read. The same number reads nothing, a higher one reads with
// `since`, a lower one is a restarted bridge and reads the whole list, and no number empties the store.

/** Every GET /api/hill the store made, as its `since` (null for a whole read). */
let reads: (string | null)[] = [];

function serve(answer: (since: string | null) => object | Response) {
  server.use(
    http.get("/api/hill", ({ request }) => {
      const since = new URL(request.url).searchParams.get("since");
      reads.push(since);
      const got = answer(since);
      return got instanceof Response ? got : HttpResponse.json(got);
    }),
  );
}

function list(rev: number, open: HillDecision[], closed: HillDecision[] = []) {
  return { v: 1, rev, open, closed };
}

async function sync(rev: number | undefined) {
  await act(async () => {
    syncHill(rev);
    await __settleHill();
  });
}

beforeEach(() => {
  reads = [];
  __resetHill();
});

describe("the hill store", () => {
  it("reads the whole list on the first number, sorted most urgent first", async () => {
    const later = hillDecision({ priority: "later", title: "later" });
    const now = hillDecision({ priority: "now", title: "now" });
    serve(() => list(4, [later, now]));
    const { result } = renderHook(() => ({ open: useHillOpen(), count: useHillCount() }));
    await sync(4);
    expect(reads).toEqual([null]);
    expect(result.current.open.map((d) => d.title)).toEqual(["now", "later"]);
    expect(result.current.count).toBe(2);
  });

  it("reads nothing when the number did not move", async () => {
    serve(() => list(4, [hillDecision()]));
    await sync(4);
    await sync(4);
    expect(reads).toEqual([null]);
  });

  it("reads with since when the number went up, and keeps the list on unchanged", async () => {
    const one = hillDecision({ title: "one" });
    serve((since) => (since === null ? list(4, [one]) : { v: 1, rev: 6, unchanged: true }));
    const { result } = renderHook(() => useHillOpen());
    await sync(4);
    await sync(6);
    expect(reads).toEqual([null, "4"]);
    expect(result.current.map((d) => d.title)).toEqual(["one"]);
  });

  it("reads the whole list when the number went down (a restarted bridge)", async () => {
    serve((since) => (since === null && reads.length > 1 ? list(1, [hillDecision({ title: "fresh" })]) : list(9, [hillDecision({ title: "old" })])));
    const { result } = renderHook(() => useHillOpen());
    await sync(9);
    await sync(1);
    expect(reads).toEqual([null, null]);
    expect(result.current.map((d) => d.title)).toEqual(["fresh"]);
  });

  it("empties the store when the snapshot carries no number", async () => {
    serve(() => list(4, [hillDecision()]));
    const { result } = renderHook(() => useHillCount());
    await sync(4);
    expect(result.current).toBe(1);
    await sync(undefined);
    expect(result.current).toBe(0);
  });

  it("keeps the held list when a read fails, and asks again on the next snapshot", async () => {
    serve(() => list(4, [hillDecision({ title: "kept" })]));
    const { result } = renderHook(() => useHillOpen());
    await sync(4);
    server.use(http.get("/api/hill", () => HttpResponse.error()));
    await sync(5);
    expect(result.current.map((d) => d.title)).toEqual(["kept"]);
    serve(() => list(5, []));
    await sync(5);
    expect(result.current).toEqual([]);
  });

  it("holds a receipt until the next changed list, but keeps the words of a gone answer", async () => {
    const decision = hillDecision();
    serve((since) => (since === null ? list(1, [decision]) : list(2, [])));
    const { result } = renderHook(() => ({ held: useHillAnswerHeld(decision.id), kept: useHillKept() }));
    await sync(1);
    act(() => noteHillAnswer(decision.id, { receipt: hillReceipt({ code: "gone", state: null, delivery: null }), intent: "yes", text: "my words" }));
    expect(result.current.held?.receipt.code).toBe("gone");
    expect(result.current.kept.get(decision.id)).toBe("my words");
    await sync(2);
    expect(result.current.held).toBeNull();
    expect(result.current.kept.get(decision.id)).toBe("my words");
  });

  it("keeps no words for an answer that reached its target", () => {
    const { result } = renderHook(() => useHillKept());
    act(() => noteHillAnswer("dc_x", { receipt: hillReceipt({ at: HILL_T0 }), intent: "yes", text: "fine" }));
    expect(result.current.size).toBe(0);
  });
});
