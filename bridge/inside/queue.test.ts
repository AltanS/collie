import { describe, expect, test } from "bun:test";

import { CommandQueue, QUEUE_PER_PANE_MAX, QUEUED_TTL_MS, type QueueChange } from "./queue.ts";

const PANE = { session: "main", paneId: "w1:p1" };
const OTHER = { session: "main", paneId: "w1:p2" };
const prompt = (id: string, text = "hello") => ({ id, kind: "prompt" as const, text });

/** A queue on a hand-driven clock and scheduler. */
function rig() {
  let now = 1000;
  const timers: { at: number; run: () => void; live: boolean }[] = [];
  const queue = new CommandQueue({
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
  });
  const changes: QueueChange[] = [];
  queue.onChange((change) => changes.push({ ...change }));
  const advance = (ms: number): void => {
    now += ms;
    for (const timer of timers.filter((t) => t.live && t.at <= now)) {
      timer.live = false;
      timer.run();
    }
  };
  return { queue, changes, advance };
}

describe("take", () => {
  test("the oldest command of the pane, once; another pane's is never handed out", () => {
    const { queue } = rig();
    expect(queue.enqueue(PANE, prompt("req-aaaaaaa1"))).toEqual({ ok: true });
    expect(queue.enqueue(PANE, prompt("req-aaaaaaa2"))).toEqual({ ok: true });
    expect(queue.enqueue(OTHER, prompt("req-bbbbbbb1"))).toEqual({ ok: true });
    expect(queue.take(PANE)?.command.id).toBe("req-aaaaaaa1");
    expect(queue.take(PANE)?.command.id).toBe("req-aaaaaaa2");
    expect(queue.take(PANE)).toBeNull();
    expect(queue.stateOf("req-aaaaaaa1")).toBe("taken");
    expect(queue.stateOf("req-bbbbbbb1")).toBe("queued");
  });

  test("an answer goes only to the poll that waits on its ask, and the main poll never takes one", () => {
    const { queue } = rig();
    queue.enqueue(PANE, { id: "ans-aaaaaaa1", kind: "answer", ask: "a1", decision: "allow" });
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    expect(queue.take(PANE)?.command.id).toBe("req-aaaaaaa1");
    expect(queue.take(PANE)).toBeNull();
    expect(queue.take(PANE, "a2")).toBeNull();
    expect(queue.take(PANE, "a1")?.command.id).toBe("ans-aaaaaaa1");
  });

  test("a long poll gets a command queued while it waits, at once", async () => {
    const { queue } = rig();
    const waiting = queue.wait(PANE, null, 25_000);
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    expect((await waiting)?.command.id).toBe("req-aaaaaaa1");
    expect(queue.stateOf("req-aaaaaaa1")).toBe("taken");
  });

  test("a long poll with nothing to take ends empty at its limit, and a newer poll replaces it", async () => {
    const { queue, advance } = rig();
    const first = queue.wait(PANE, null, 25_000);
    const second = queue.wait(PANE, null, 25_000);
    expect(await first).toBeNull();
    advance(25_000);
    expect(await second).toBeNull();
  });

  test("release ends every wait of the pane and keeps its queued commands", async () => {
    const { queue } = rig();
    const waiting = queue.wait(PANE, null, 25_000);
    queue.release(PANE);
    expect(await waiting).toBeNull();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    expect(queue.stateOf("req-aaaaaaa1")).toBe("queued");
  });

  test("an aborted poll ends empty and takes nothing", async () => {
    const { queue } = rig();
    const abort = new AbortController();
    const waiting = queue.wait(PANE, null, 25_000, abort.signal);
    abort.abort();
    expect(await waiting).toBeNull();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    expect(queue.stateOf("req-aaaaaaa1")).toBe("queued");
  });
});

describe("withdraw before take", () => {
  test("a queued command is withdrawn and never handed out after", () => {
    const { queue } = rig();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    expect(queue.withdraw("req-aaaaaaa1", "timeout")).toBe(true);
    expect(queue.stateOf("req-aaaaaaa1")).toBe("withdrawn");
    expect(queue.take(PANE)).toBeNull();
    expect(queue.withdraw("req-aaaaaaa1")).toBe(false);
  });

  test("a queued command nobody takes is withdrawn by age", () => {
    const { queue, advance } = rig();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    advance(QUEUED_TTL_MS);
    expect(queue.get("req-aaaaaaa1")).toMatchObject({ state: "withdrawn", reason: "expired" });
  });
});

describe("never twice after take", () => {
  test("a taken command cannot be withdrawn, taken again, or queued again under its id", () => {
    const { queue } = rig();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    expect(queue.take(PANE)?.command.id).toBe("req-aaaaaaa1");
    expect(queue.withdraw("req-aaaaaaa1")).toBe(false);
    expect(queue.take(PANE)).toBeNull();
    expect(queue.enqueue(PANE, prompt("req-aaaaaaa1"))).toEqual({ ok: false, reason: "duplicate" });
    expect(queue.stateOf("req-aaaaaaa1")).toBe("taken");
  });

  test("the part's word settles it once, from taken only, from its own pane only", () => {
    const { queue } = rig();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    expect(queue.settle("req-aaaaaaa1", PANE, "sent")).toBe(false);
    queue.take(PANE);
    expect(queue.settle("req-aaaaaaa1", OTHER, "sent")).toBe(false);
    expect(queue.settle("req-aaaaaaa1", PANE, "failed", "submit")).toBe(true);
    expect(queue.settle("req-aaaaaaa1", PANE, "sent")).toBe(false);
    expect(queue.get("req-aaaaaaa1")).toMatchObject({ state: "failed", reason: "submit", detail: null });
  });

  test("a failed keeps the part's detail; a sent keeps none", () => {
    const { queue } = rig();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    queue.enqueue(PANE, prompt("req-aaaaaaa2"));
    queue.take(PANE);
    queue.take(PANE);
    expect(queue.settle("req-aaaaaaa1", PANE, "failed", "dropped", "blocked by a hook")).toBe(true);
    expect(queue.settle("req-aaaaaaa2", PANE, "sent", null, "ignored")).toBe(true);
    expect(queue.get("req-aaaaaaa1")).toMatchObject({ state: "failed", reason: "dropped", detail: "blocked by a hook" });
    expect(queue.get("req-aaaaaaa2")).toMatchObject({ state: "sent", detail: null });
  });

  test("a taken command with no word stays taken; the age limit never withdraws it", () => {
    const { queue, advance } = rig();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    queue.take(PANE);
    advance(QUEUED_TTL_MS * 5);
    expect(queue.stateOf("req-aaaaaaa1")).toBe("taken");
  });

  test("the changes name each state once, in order", () => {
    const { queue, changes } = rig();
    queue.enqueue(PANE, prompt("req-aaaaaaa1"));
    queue.take(PANE);
    queue.settle("req-aaaaaaa1", PANE, "sent");
    expect(changes.map((change) => change.state)).toEqual(["queued", "taken", "sent"]);
  });
});

describe("limits", () => {
  test("a pane holds at most QUEUE_PER_PANE_MAX waiting commands", () => {
    const { queue } = rig();
    for (let i = 0; i < QUEUE_PER_PANE_MAX; i += 1) expect(queue.enqueue(PANE, prompt(`req-${String(i).padStart(8, "0")}`)).ok).toBe(true);
    expect(queue.enqueue(PANE, prompt("req-overflow1"))).toEqual({ ok: false, reason: "full" });
    expect(queue.enqueue(OTHER, prompt("req-otherpane"))).toEqual({ ok: true });
  });
});
