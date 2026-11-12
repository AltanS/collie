import { act, renderHook } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { HILL_T0, hillDecision, hillReceipt } from "@/test/hill-fixtures";
import { server } from "@/test/setup";

import { __resetHill, __settleHill, clearClosedLocally, noteHillAnswer, readHillNow, syncHill, useHillAnswerHeld, useHillClosed, useHillClosedTotal, useHillCount, useHillKept, useHillOpen } from "./store";
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

  it("keeps the receipt of a decision the next list serves as closed, so its card leaves showing it", async () => {
    const decision = hillDecision();
    const other = hillDecision({ title: "refused, open again" });
    serve((since) => (since === null ? list(1, [decision, other]) : list(2, [other], [{ ...decision, state: "answered" }])));
    const { result } = renderHook(() => ({ closed: useHillAnswerHeld(decision.id), open: useHillAnswerHeld(other.id) }));
    await sync(1);
    act(() => noteHillAnswer(decision.id, { receipt: hillReceipt(), intent: "yes", text: null }));
    act(() => noteHillAnswer(other.id, { receipt: hillReceipt({ code: "rejected", state: null, delivery: null }), intent: "yes", text: null }));
    await sync(2);
    expect(result.current.closed?.receipt.code).toBe("ok");
    // An open card has nothing to say after a new list: it takes a new answer.
    expect(result.current.open).toBeNull();
  });

  it("reads the list at once on readHillNow, with since, whatever the last snapshot said", async () => {
    const decision = hillDecision();
    serve((since) => (since === null ? list(1, [decision]) : list(2, [])));
    const { result } = renderHook(() => useHillOpen());
    await sync(1);
    await act(async () => {
      readHillNow();
      await __settleHill();
    });
    expect(reads).toEqual([null, "1"]);
    expect(result.current).toEqual([]);
    // The snapshot that names the number the read already brought reads nothing more.
    await sync(2);
    expect(reads).toEqual([null, "1"]);
  });

  it("reads nothing on readHillNow while no snapshot named a hill", async () => {
    serve(() => list(1, []));
    await act(async () => {
      readHillNow();
      await __settleHill();
    });
    expect(reads).toEqual([]);
  });

  it("does not read again and again for a snapshot older than the list it holds", async () => {
    // The bridge is at 3 after the answer; only the very first read saw 1.
    serve(() => (reads.length === 1 ? list(1, [hillDecision()]) : list(3, [])));
    await sync(1);
    await act(async () => {
      readHillNow();
      await __settleHill();
    });
    // A snapshot that was on its way before the forced read lands with the older number 2.
    await sync(2);
    // One whole read to be sure (a lower number may be a restarted bridge), then it stops: the list it
    // holds is newer than the snapshot. Before, it read until its four passes ran out.
    expect(reads).toEqual([null, "1", null]);
  });

  it("keeps no words for an answer that reached its target", () => {
    const { result } = renderHook(() => useHillKept());
    act(() => noteHillAnswer("dc_x", { receipt: hillReceipt({ at: HILL_T0 }), intent: "yes", text: "fine" }));
    expect(result.current.size).toBe(0);
  });

  it("keeps the words of a gone answer when the snapshot carries no number, and drops the lists and receipts", async () => {
    const decision = hillDecision();
    serve(() => list(1, [decision], [hillDecision({ title: "closed" })]));
    const { result } = renderHook(() => ({ held: useHillAnswerHeld(decision.id), kept: useHillKept(), open: useHillOpen(), count: useHillCount() }));
    await sync(1);
    act(() => noteHillAnswer(decision.id, { receipt: hillReceipt({ code: "gone", state: null, delivery: null }), intent: "yes", text: "my words" }));
    await sync(undefined);
    expect(result.current.count).toBe(0);
    expect(result.current.open).toEqual([]);
    expect(result.current.held).toBeNull();
    expect(result.current.kept.get(decision.id)).toBe("my words");
  });

  it("drops a read that lands after the store was emptied, and reads again for the number that came after", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get("/api/hill", async ({ request }) => {
        reads.push(new URL(request.url).searchParams.get("since"));
        const first = reads.length === 1;
        if (first) await gate;
        return HttpResponse.json(list(4, [hillDecision({ title: first ? "from the old bridge" : "from the new one" })]));
      }),
    );
    const { result } = renderHook(() => useHillOpen());
    let settled: Promise<void> = Promise.resolve();
    act(() => {
      syncHill(4);
      settled = __settleHill();
    });
    // The snapshot lost its number while the read was out, then a bridge came back with the same one.
    act(() => syncHill(undefined));
    act(() => syncHill(4));
    act(() => {
      release();
    });
    await act(async () => {
      await settled;
    });
    expect(result.current.map((d) => d.title)).toEqual(["from the new one"]);
    expect(reads).toEqual([null, null]);
  });
});

describe("clearing the closed rows on the phone", () => {
  const closedRows = () => [hillDecision({ state: "answered", closedAt: 5 }), hillDecision({ state: "dismissed", closedAt: 4 })];

  it("holds how many closed decisions the bridge has, never fewer than the rows it served", async () => {
    serve(() => ({ ...list(1, [], closedRows()), closedTotal: 40 }));
    const { result } = renderHook(() => ({ closed: useHillClosed(), total: useHillClosedTotal() }));
    await sync(1);
    expect(result.current.closed).toHaveLength(2);
    expect(result.current.total).toBe(40);
    serve(() => list(2, [], closedRows()));
    await sync(2);
    expect(result.current.total).toBe(2);
  });

  it("takes the rows off at once, and the way back puts them and the count back", async () => {
    serve(() => ({ ...list(1, [], closedRows()), closedTotal: 9 }));
    const { result } = renderHook(() => ({ closed: useHillClosed(), total: useHillClosedTotal() }));
    await sync(1);
    let putBack: () => void = () => undefined;
    act(() => {
      putBack = clearClosedLocally();
    });
    expect(result.current).toEqual({ closed: [], total: 0 });
    act(() => putBack());
    expect(result.current.closed).toHaveLength(2);
    expect(result.current.total).toBe(9);
  });

  it("does not put old rows over a list that arrived while the clear was out", async () => {
    serve((since) => (since === null ? list(1, [], closedRows()) : list(2, [hillDecision()], [])));
    const { result } = renderHook(() => ({ closed: useHillClosed(), open: useHillOpen() }));
    await sync(1);
    let putBack: () => void = () => undefined;
    act(() => {
      putBack = clearClosedLocally();
    });
    await sync(2);
    act(() => putBack());
    expect(result.current.closed).toEqual([]);
    expect(result.current.open).toHaveLength(1);
  });

  it("with nothing closed it changes nothing and its way back does nothing", async () => {
    serve(() => list(1, [hillDecision()]));
    const { result } = renderHook(() => useHillClosed());
    await sync(1);
    const before = result.current;
    let putBack: () => void = () => undefined;
    act(() => {
      putBack = clearClosedLocally();
    });
    act(() => putBack());
    expect(result.current).toBe(before);
  });
});
