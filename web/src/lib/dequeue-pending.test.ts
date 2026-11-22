import { claimPendingDequeue, loadPendingDequeue, resetDequeuePendingForTests, savePendingDequeue, settleDequeue } from "./dequeue-pending";
import type { DequeueReceipt } from "./surface/dequeue";

// The lost-answer rule of a take-back (ADR 0122, the 2026-11-22 addendum): the id is kept per pane, the phone asks
// again with it, bounded, as a replay only, and one caller acts on the answer.

class Failed extends Error {
  constructor(readonly status: number | undefined) {
    super("failed");
  }
}
const statusOf = <T,>(error: T): number | undefined => (error instanceof Failed ? error.status : undefined);
const sleep = () => Promise.resolve();
const TAKEN: DequeueReceipt = { requestId: "r1", outcome: "taken", texts: ["a"] };

beforeEach(() => resetDequeuePendingForTests());

describe("settleDequeue", () => {
  it("the first ask is the tap, every later one a replay, until an answer comes", async () => {
    const replays: boolean[] = [];
    const post = (replay: boolean) => {
      replays.push(replay);
      return replays.length < 3 ? Promise.reject(new Failed(undefined)) : Promise.resolve(TAKEN);
    };
    expect(await settleDequeue("r1", true, { post, statusOf, sleep, gaps: [1, 1, 1] })).toEqual({ kind: "receipt", receipt: TAKEN });
    expect(replays).toEqual([false, true, true]);
  });

  it("is bounded: past the last gap it ends `lost`", async () => {
    let asks = 0;
    const post = () => {
      asks++;
      return Promise.reject(new Failed(503));
    };
    expect(await settleDequeue("r2", true, { post, statusOf, sleep, gaps: [1, 1] })).toEqual({ kind: "lost" });
    expect(asks).toBe(3);
  });

  it("a refusal the bridge stated (a 4xx) ends it at once", async () => {
    let asks = 0;
    const post = () => {
      asks++;
      return Promise.reject(new Failed(409));
    };
    expect((await settleDequeue("r3", true, { post, statusOf, sleep, gaps: [1, 1] })).kind).toBe("stated");
    expect(asks).toBe(1);
  });

  it("an ask on its own (a resume) is a replay from the first", async () => {
    const replays: boolean[] = [];
    await settleDequeue("r4", false, { post: (replay) => (replays.push(replay), Promise.resolve(TAKEN)), statusOf, sleep });
    expect(replays).toEqual([true]);
  });

  it("two calls for one id share one loop", async () => {
    let asks = 0;
    let open: (receipt: DequeueReceipt) => void = () => undefined;
    const post = () => {
      asks++;
      return new Promise<DequeueReceipt>((resolve) => (open = resolve));
    };
    const one = settleDequeue("r5", true, { post, statusOf, sleep });
    const two = settleDequeue("r5", false, { post, statusOf, sleep });
    open(TAKEN);
    expect(await one).toEqual(await two);
    expect(asks).toBe(1);
  });
});

describe("the pending id", () => {
  it("is kept per pane, and only the caller that claims it may act", () => {
    savePendingDequeue(undefined, "w1:p1", "r1");
    expect(loadPendingDequeue(undefined, "w1:p2")).toBeNull();
    expect(claimPendingDequeue(undefined, "w1:p1", "other")).toBe(false);
    expect(claimPendingDequeue(undefined, "w1:p1", "r1")).toBe(true);
    expect(claimPendingDequeue(undefined, "w1:p1", "r1")).toBe(false);
  });

  it("is written to sessionStorage, where a reload finds it", () => {
    savePendingDequeue(undefined, "w1:p1", "r9");
    expect(sessionStorage.length).toBeGreaterThan(0);
    expect(loadPendingDequeue(undefined, "w1:p1")).toBe("r9");
  });
});
