// `ReceiptStore.claim` (core/receipts.ts): the atomic first step for a store several processes share. The memory store
// implements it over its map, and `Receipts.run` uses it when a store has it.
import { describe, expect, test } from "bun:test";
import { api, type Dial } from "./client.ts";
import {
  type Claim,
  createCore,
  MemoryReceiptStore,
  type ReceiptRecord,
  Receipts,
  type ReceiptStore,
} from "../../../packages/durable-sdk/src/core/index.ts";

/** A store with a `claim` the test scripts: the answers come off a queue, the last one repeats. */
function scripted(answers: Claim[]) {
  const asked: [string, string, string][] = [];
  const kept = new Map<string, ReceiptRecord>();
  let get = 0;
  const store: ReceiptStore = {
    get: () => void get++ as never,
    put: (id, record) => void kept.set(id, record),
    claim: (id, digest, group) => {
      asked.push([id, digest, group]);
      return answers.length > 1 ? answers.shift()! : answers[0]!;
    },
  };
  return { store, asked, kept, gets: () => get };
}

describe("the memory store's claim", () => {
  test("new for an id nobody used, done with the reply after a put, dropped past the cap", () => {
    const m = new MemoryReceiptStore(500);
    expect(m.claim("r1", "d", "g")).toEqual({ state: "new" });
    m.put("r1", { digest: "d", reply: { ok: true } }, "g");
    expect(m.claim("r1", "d", "g")).toEqual({ state: "done", digest: "d", reply: { ok: true } });
    for (let i = 0; i < 600; i++) m.put(`x${i}`, { digest: "dx", reply: {} }, "p");
    expect(m.claim("x0", "dx", "p")).toEqual({ state: "dropped", digest: "dx" });
  });

  test("claiming does not record anything: the memory store keeps no pending", () => {
    const m = new MemoryReceiptStore(500);
    m.claim("r1", "d", "g");
    expect(m.get("r1")).toBeUndefined();
    expect(m.size).toBe(0);
  });
});

describe("Receipts with a store that has claim", () => {
  test("new: the act runs once, the reply is put, and claim is asked instead of get", async () => {
    const s = scripted([{ state: "new" }]);
    let runs = 0;
    const r = new Receipts(s.store);
    expect(await r.run("r1", "d1", async () => (runs++, { ok: true }), "p1")).toEqual({ ok: true });
    expect([runs, s.asked, s.kept.get("r1"), s.gets()]).toEqual([1, [["r1", "d1", "p1"]], { digest: "d1", reply: { ok: true } }, 0]);
  });

  test("done with the same digest: the first reply comes back replayed and nothing runs", async () => {
    const s = scripted([{ state: "done", digest: "d1", reply: { ok: true } }]);
    let runs = 0;
    expect(await new Receipts(s.store).run("r1", "d1", async () => (runs++, { ok: false }))).toEqual({ ok: true, replayed: true });
    expect(runs).toBe(0);
  });

  test("done with another digest is 409 request-id-reused, and so is a pending with another digest, with no wait", async () => {
    for (const claimed of [{ state: "done", digest: "d9", reply: {} }, { state: "pending", digest: "d9" }] as Claim[]) {
      const started = Date.now();
      await expect(new Receipts(scripted([claimed]).store, { pendingWaitMs: 5000 }).run("r1", "d1", async () => ({ ok: true }))).rejects.toMatchObject({ status: 409, code: "request-id-reused" });
      expect(Date.now() - started).toBeLessThan(500);
    }
  });

  test("dropped: 500 receipt-dropped, and 409 when the digest differs; the act never runs", async () => {
    let runs = 0;
    const act = async () => (runs++, { ok: true });
    await expect(new Receipts(scripted([{ state: "dropped", digest: "d1" }]).store).run("r1", "d1", act)).rejects.toMatchObject({ status: 500, code: "receipt-dropped" });
    await expect(new Receipts(scripted([{ state: "dropped", digest: "d2" }]).store).run("r1", "d1", act)).rejects.toMatchObject({ status: 409 });
    expect(runs).toBe(0);
  });

  test("pending with the same digest waits, and a later done replays the first reply", async () => {
    const s = scripted([{ state: "pending", digest: "d1" }, { state: "pending", digest: "d1" }, { state: "done", digest: "d1", reply: { ok: true } }]);
    let runs = 0;
    const out = await new Receipts(s.store, { pollMs: 5 }).run("r1", "d1", async () => (runs++, { ok: true }));
    expect([out, runs, s.asked.length]).toEqual([{ ok: true, replayed: true }, 0, 3]);
  });

  test("pending past the wait is 500 receipt-dropped (an unknown outcome), and the act does not run", async () => {
    const s = scripted([{ state: "pending", digest: "d1" }]);
    let runs = 0;
    const started = Date.now();
    await expect(new Receipts(s.store, { pendingWaitMs: 60, pollMs: 10 }).run("r1", "d1", async () => (runs++, { ok: true }))).rejects.toMatchObject({ status: 500, code: "receipt-dropped" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    expect([runs, s.asked.length > 1]).toEqual([0, true]);
  });

  test("a store that hands a stale pending over (new on the second ask) lets the act run once", async () => {
    const s = scripted([{ state: "pending", digest: "d1" }, { state: "new" }]);
    let runs = 0;
    expect(await new Receipts(s.store, { pollMs: 5 }).run("r1", "d1", async () => (runs++, { ok: true }))).toEqual({ ok: true });
    expect([runs, s.kept.has("r1")]).toEqual([1, true]);
  });

  test("a failed act puts nothing, and leaves the claim to the store", async () => {
    const s = scripted([{ state: "new" }]);
    await expect(new Receipts(s.store).run("r1", "d1", async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(s.kept.size).toBe(0);
  });

  test("two requests with one id at once in one process still run once: the ids in flight are the Receipts's", async () => {
    const s = scripted([{ state: "new" }]);
    let runs = 0;
    const r = new Receipts(s.store);
    const act = async () => (await Bun.sleep(10), runs++, { ok: true });
    const [a, b] = await Promise.all([r.run("r1", "d1", act), r.run("r1", "d1", act)]);
    expect([a, b, runs, s.asked.length]).toEqual([{ ok: true }, { ok: true, replayed: true }, 1, 1]);
  });

  test("the default store keeps the wire as it was: a replay is the first reply, a reused id is 409", async () => {
    const r = new Receipts();
    expect(await r.run("r1", "d1", async () => ({ ok: true }))).toEqual({ ok: true });
    expect(await r.run("r1", "d1", async () => ({ ok: false }))).toEqual({ ok: true, replayed: true });
    await expect(r.run("r1", "d2", async () => ({ ok: true }))).rejects.toMatchObject({ status: 409 });
  });
});

describe("over the wire", () => {
  test("an abort whose request id another process holds pending for another payload is 409 request-id-reused, and never runs", async () => {
    const s = scripted([{ state: "pending", digest: "another-payload" }]);
    const core = createCore({ hostName: "w", receipts: s.store });
    let stops = 0;
    core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" }).onAbort(() => void stops++);
    core.ready();
    const d: Dial = { handler: (r) => core.handle(r), version: 1 };
    const turn = (await api.snapshot(d)).body.panes[0]!.turnId;
    const r = await api.abort(d, "p", { turnId: turn, requestId: "held" });
    expect([r.status, r.body.code, stops]).toEqual([409, "request-id-reused", 0]);
  });

  test("the core takes a claim store as its receipts: a replay comes back with replayed, once", async () => {
    const kept = new Map<string, ReceiptRecord>();
    const store: ReceiptStore = {
      get: () => undefined,
      put: (id, record) => void kept.set(id, record),
      claim: (id, digest): Claim => {
        const have = kept.get(id);
        return have === undefined ? { state: "new" } : { state: "done", digest: have.digest, reply: have.reply };
      },
    };
    const core = createCore({ hostName: "w", receipts: store });
    let stops = 0;
    const pane = core.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    pane.onAbort(() => void stops++);
    pane.state("working");
    core.ready();
    const d: Dial = { handler: (r) => core.handle(r), version: 1 };
    const turn = (await api.snapshot(d)).body.panes[0]!.turnId;
    expect((await api.abort(d, "p", { turnId: turn, requestId: "a1" })).body).toEqual({ ok: true });
    expect((await api.abort(d, "p", { turnId: turn, requestId: "a1" })).body).toEqual({ ok: true, replayed: true });
    expect(stops).toBe(1);
  });
});
