/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { BusyModel, classify, NAV_BAR_MS, POLL_BAR_MS, startBusyTracking, STALLED_MS, type Timers } from "./busy";

/** A clock the test turns by hand. */
function fakeClock(): Timers & { advance(ms: number): void } {
  let now = 0;
  let next = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    set(run, ms) {
      const id = next++;
      pending.set(id, { at: now + ms, run });
      return id;
    },
    clear(handle) {
      pending.delete(handle);
    },
    advance(ms) {
      const to = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= to).toSorted((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = to;
    },
  };
}

function counted(model: BusyModel): () => number {
  let n = 0;
  model.addEventListener("change", () => n++);
  return () => n;
}

describe("BusyModel: the orbit channel", () => {
  test("work turns the orbit and never the bar", () => {
    const model = new BusyModel(fakeClock());
    const release = model.beginWork();
    expect(model.view).toEqual({ orbit: true, bar: false, stalled: false });
    release();
    expect(model.view.orbit).toBe(false);
  });

  test("a release called twice releases once, and nested work holds to the last", () => {
    const model = new BusyModel(fakeClock());
    const a = model.beginWork();
    const b = model.beginWork();
    a();
    a();
    expect(model.view.orbit).toBe(true);
    b();
    expect(model.view.orbit).toBe(false);
  });

  test("a first read (nav load) turns the orbit at once, a poll never does", () => {
    const model = new BusyModel(fakeClock());
    const poll = model.beginLoad("poll");
    expect(model.view.orbit).toBe(false);
    const nav = model.beginLoad("nav");
    expect(model.view.orbit).toBe(true);
    nav();
    poll();
    expect(model.view.orbit).toBe(false);
  });
});

describe("BusyModel: the bar channel", () => {
  test("a write shows the bar for its whole flight", () => {
    const model = new BusyModel(fakeClock());
    const release = model.beginWrite();
    expect(model.view.bar).toBe(true);
    release();
    expect(model.view.bar).toBe(false);
  });

  test("a promise tracked as a write clears on a rejection too", async () => {
    const model = new BusyModel(fakeClock());
    const failing = model.track(Promise.reject(new Error("refused")));
    expect(model.view.bar).toBe(true);
    await failing.catch(() => undefined);
    expect(model.view.bar).toBe(false);
  });

  test("a navigation shows the bar only past NAV_BAR_MS", () => {
    const clock = fakeClock();
    const model = new BusyModel(clock);
    const release = model.beginLoad("nav");
    clock.advance(NAV_BAR_MS - 1);
    expect(model.view.bar).toBe(false);
    clock.advance(1);
    expect(model.view.bar).toBe(true);
    release();
    expect(model.view.bar).toBe(false);
  });

  test("a fast navigation never trips the bar", () => {
    const clock = fakeClock();
    const model = new BusyModel(clock);
    const release = model.beginLoad("nav");
    clock.advance(300);
    release();
    clock.advance(10_000);
    expect(model.view.bar).toBe(false);
  });

  test("a poll shows the bar only once it has hung, past POLL_BAR_MS", () => {
    const clock = fakeClock();
    const model = new BusyModel(clock);
    const release = model.beginLoad("poll");
    clock.advance(POLL_BAR_MS - 1);
    expect(model.view.bar).toBe(false);
    clock.advance(1);
    expect(model.view.bar).toBe(true);
    release();
    expect(model.view.bar).toBe(false);
  });

  test("the bar clears only when BOTH a slow poll and a write have settled", () => {
    const clock = fakeClock();
    const model = new BusyModel(clock);
    const poll = model.beginLoad("poll");
    clock.advance(POLL_BAR_MS);
    const write = model.beginWrite();
    poll();
    expect(model.view.bar).toBe(true);
    write();
    expect(model.view.bar).toBe(false);
  });
});

describe("BusyModel: stalled", () => {
  test("any load past STALLED_MS is stalled, and settling clears it", () => {
    const clock = fakeClock();
    const model = new BusyModel(clock);
    const release = model.beginLoad("poll");
    clock.advance(STALLED_MS - 1);
    expect(model.view.stalled).toBe(false);
    clock.advance(1);
    expect(model.view.stalled).toBe(true);
    release();
    expect(model.view.stalled).toBe(false);
  });

  test("an unchanged reading wakes nobody", () => {
    const model = new BusyModel(fakeClock());
    const changes = counted(model);
    const a = model.beginWork();
    const b = model.beginWork();
    expect(changes()).toBe(1);
    a();
    expect(changes()).toBe(1);
    b();
    expect(changes()).toBe(2);
  });
});

describe("classify", () => {
  const seen = new Set<string>();
  const at = (path: string): URL => new URL(path, "http://localhost/");

  test("every non-GET under /api/ is a write", () => {
    expect(classify("POST", at("/api/pane/w1:p1/keys"), seen).kind).toBe("write");
    expect(classify("delete", at("/api/pane/w1:p1"), seen).kind).toBe("write");
  });

  test("a mount prefix does not hide the API path", () => {
    expect(classify("POST", at("/collie/api/reply"), seen).kind).toBe("write");
  });

  test("a screen's read is a first read until it has been answered once", () => {
    const url = at("/api/pane/w1:p1?lines=600&host=m1");
    const first = classify("GET", url, seen);
    expect(first.kind).toBe("first-read");
    expect(classify("GET", url, new Set([first.key])).kind).toBe("other");
  });

  test("the same pane on another machine is its own first read", () => {
    const a = classify("GET", at("/api/pane/w1:p1?host=m1"), seen);
    const b = classify("GET", at("/api/pane/w1:p1?host=m2"), seen);
    expect(a.key).not.toBe(b.key);
  });

  test("the snapshot, the config and a pane's sub-resources are never a first read", () => {
    for (const path of ["/api/snapshot", "/api/config", "/api/pane/w1:p1/chat", "/api/update/check", "/assets/app.js"]) {
      expect(classify("GET", at(path), seen).kind).toBe("other");
    }
  });
});

describe("startBusyTracking", () => {
  function harness(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    const target = {
      location: { href: "http://localhost/" },
      fetch: (input: string | URL | Request, init?: RequestInit) => handler(String(input), init),
    };
    const model = new BusyModel(fakeClock());
    startBusyTracking(model, target);
    return { target, model };
  }

  test("a write holds the bar until the answer, then lets go", async () => {
    let answer: (res: Response) => void = () => undefined;
    const { target, model } = harness(() => new Promise((resolve) => (answer = resolve)));
    const call = target.fetch("/api/pane/w1:p1/keys", { method: "POST" });
    expect(model.view.bar).toBe(true);
    answer(new Response("{}"));
    await call;
    await Promise.resolve();
    expect(model.view.bar).toBe(false);
  });

  test("a first read turns the orbit; the second read of the same pane does not", async () => {
    let answer: (res: Response) => void = () => undefined;
    const { target, model } = harness(() => new Promise((resolve) => (answer = resolve)));
    const first = target.fetch("/api/pane/w1:p1?lines=600");
    expect(model.view.orbit).toBe(true);
    answer(new Response("{}"));
    await first;
    await Promise.resolve();
    expect(model.view.orbit).toBe(false);
    void target.fetch("/api/pane/w1:p1?lines=600");
    expect(model.view.orbit).toBe(false);
  });

  test("a failed first read lets go and stays a first read", async () => {
    const { target, model } = harness(() => Promise.reject(new TypeError("network")));
    await target.fetch("/api/history?limit=8").catch(() => undefined);
    await Promise.resolve();
    expect(model.view.orbit).toBe(false);
    void target.fetch("/api/history?limit=8").catch(() => undefined);
    expect(model.view.orbit).toBe(true);
  });
});
