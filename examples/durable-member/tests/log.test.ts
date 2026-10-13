// The bounded event log, SDK only: compacted items, a raw tail of N events, reset for a cursor that fell behind.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { api, call, type Dial } from "./client.ts";
import { type AskInput, openCollie, type ProgramEvent } from "../../../packages/durable-sdk/src/index.ts";
import { Store } from "../../../packages/durable-sdk/src/core/layout.ts";
import { cleanup, tmp } from "./util.ts";

afterAll(cleanup);
const item = (id: string, text: string): ProgramEvent => ({ type: "item", item: { id, kind: "reply", text } });
const ask = (id: string): AskInput & { id: string } => ({
  id,
  kind: "permission",
  toolCallId: `call-${id}`,
  title: "t",
  itemId: `call-${id}`,
  options: [{ id: "ok", label: "ok", effect: "allow" }],
});

describe("bounded log, N = 10", async () => {
  const collie = await openCollie({ callerCheck: "off", socket: join(tmp(), "s.sock"), hostName: "t", tailLimit: 10 });
  const d: Dial = { socket: collie.address, version: 1 };
  const pane = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
  collie.ready();
  afterAll(() => collie.close());

  // 100 events over 40 items: items 0..39, each rewritten, so 60 of the events are newer versions.
  pane.state("working");
  for (let i = 0; i < 100; i++) pane.event(item(`i${i % 40}`, `v${i}`));
  void pane.ask(ask("a1")); // stays open
  const total = 103; // state, 100 items, ask, state waiting

  test("a cursor at 0 gets reset, every item once at its latest version, the open ask, state, synced", async () => {
    const r = (await api.events(d, "p", 0)).body;
    expect(r.reset).toBe(true);
    const types = r.events.map((e) => e.type);
    expect(types[0]).toBe("reset");
    expect(types.slice(-3)).toEqual(["ask", "state", "synced"]);
    const items = r.events.flatMap((e) => (e.type === "item" ? [e.item] : []));
    expect(items.map((i) => i.id)).toEqual(Array.from({ length: 40 }, (_, i) => `i${i}`)); // order of first appearance, no duplicates
    expect(items.map((i) => (i as { text: string }).text)).toEqual(Array.from({ length: 40 }, (_, i) => `v${i < 20 ? i + 80 : i + 40}`));
    expect(r.events.filter((e) => e.type === "ask")).toHaveLength(1);
    expect(r.events.at(-2)).toMatchObject({ type: "state", state: "waiting" });
    expect(r.next).toBe(total);
  });

  test("a cursor inside the tail gets plain events, no reset", async () => {
    const r = (await api.events(d, "p", total - 3)).body;
    expect(r.reset).toBeUndefined();
    expect(r.events.map((e) => e.type)).toEqual(["item", "ask", "state"]);
    expect(r.more).toBeUndefined();
    expect((await api.events(d, "p", total)).body.events).toEqual([]);
  });

  test("a cursor past the pane's count is a reset, not an empty reply", async () => {
    const r = (await api.events(d, "p", 9999)).body;
    expect(r.reset).toBe(true);
    expect(r.next).toBe(total);
  });

  test("the edge: the oldest cursor the tail still holds is plain, one older is a reset", async () => {
    expect((await api.events(d, "p", total - 10)).body.reset).toBeUndefined();
    expect((await api.events(d, "p", total - 11)).body.reset).toBe(true);
  });

  test("a reset event from the program empties the compacted history, and a remove drops an item", async () => {
    const p2 = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p2", { title: "P2", harness: "x" });
    for (let i = 0; i < 15; i++) p2.event(item(`x${i}`, "old"));
    p2.event({ type: "reset" });
    p2.event(item("y1", "new"));
    p2.event(item("y2", "new"));
    p2.event({ type: "remove", id: "y1" });
    const r = (await api.events(d, "p2", 0)).body;
    expect(r.events.flatMap((e) => (e.type === "item" ? [e.item.id] : []))).toEqual(["y2"]);
  });
});

describe("memory", () => {
  test("the tail never grows past N, however many events come", () => {
    const store = new Store(10);
    const p = store.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    const pane = store.panes.get(p.id)!;
    let longest = 0;
    for (let i = 0; i < 5000; i++) {
      p.event(item(`i${i % 7}`, String(i)));
      longest = Math.max(longest, pane.tail.length);
    }
    expect(longest).toBe(10);
    expect(pane.eventsAfter(0, false).events.length).toBe(1 + 7 + 2); // reset, 7 items, state, synced
  });
  test("the default is 500", () => {
    const store = new Store();
    const p = store.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    for (let i = 0; i < 600; i++) p.event(item(`i${i}`, "x"));
    expect(store.panes.get(p.id)!.tail.length).toBe(500);
  });
});

describe("events reply limits", () => {
  const open = async (opts: { tailLimit?: number } = {}) => {
    const collie = await openCollie({ callerCheck: "off", socket: join(tmp(), "s.sock"), hostName: "t", ...opts });
    const d: Dial = { socket: collie.address, version: 1 };
    const pane = collie.workspace("w", { title: "W" }).tab("t", { title: "T" }).pane("p", { title: "P", harness: "x" });
    collie.ready();
    return { collie, d, pane };
  };

  test("the tail is at most 1000, whatever tailLimit asks for, and one reply carries at most 1000", async () => {
    const { collie, d, pane } = await open({ tailLimit: 5000 });
    for (let i = 0; i < 1500; i++) pane.event(item(`i${i}`, "x"));
    const total = (await api.events(d, "p", 0)).body.next; // 1500 events: a reset, since 0 left the tail
    expect(total).toBe(1500);
    const r = (await api.events(d, "p", total - 1000)).body; // the oldest cursor the tail holds
    expect(r.reset).toBeUndefined();
    expect(r.events).toHaveLength(1000);
    expect(r.more).toBeUndefined();
    expect(r.next).toBe(1500);
    expect((await api.events(d, "p", total - 1001)).body.reset).toBe(true);
    await collie.close();
  });

  test("a reply over 8 MiB stops early with more, next is the cursor after the last event sent, and a loop reads it all", async () => {
    const { collie, d, pane } = await open({ tailLimit: 1000 });
    const big = "é".repeat(30_000); // 60 000 bytes each, so 200 of them are 12 MB
    for (let i = 0; i < 200; i++) pane.event(item(`b${i}`, big));
    const first = (await api.events(d, "p", 0)).body;
    expect(first.reset).toBeUndefined();
    expect(first.more).toBe(true);
    expect(first.events.length).toBeLessThan(200);
    expect(first.next).toBe(first.events.length);
    expect(JSON.stringify(first).length).toBeLessThan(8 * 1024 * 1024);
    let got = first.events.length;
    for (let r = first; r.more; ) {
      r = (await api.events(d, "p", got)).body;
      expect(r.next).toBe(got + r.events.length);
      got += r.events.length;
    }
    expect(got).toBe(200);
    await collie.close();
  });

  test("a reset view holds at most the newest 2000 items and counts the rest in trimmed", async () => {
    const { collie, d, pane } = await open();
    for (let i = 0; i < 2500; i++) pane.event(item(`i${i}`, "x"));
    const r = (await api.events(d, "p", 0)).body;
    expect(r.reset).toBe(true);
    const ids = r.events.flatMap((e) => (e.type === "item" ? [e.item.id] : []));
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toBe("i500"); // the oldest 500 were left out
    expect(ids.at(-1)).toBe("i2499");
    expect(r.trimmed).toBe(500);
    expect(r.events.map((e) => e.type).slice(-2)).toEqual(["state", "synced"]);
    const small = await open();
    small.pane.event(item("only", "x"));
    expect((await api.events(small.d, "p", 0)).body.trimmed).toBeUndefined();
    await collie.close();
    await small.collie.close();
  });

  test("a reset view stays inside 8 MiB too: older items are trimmed to fit", async () => {
    const { collie, d, pane } = await open();
    const big = "x".repeat(60_000);
    for (let i = 0; i < 300; i++) pane.event(item(`b${i}`, big)); // 18 MB of latest versions
    const r = (await api.events(d, "p", 0, "an-old-epoch")).body;
    expect(r.reset).toBe(true);
    expect(JSON.stringify(r).length).toBeLessThan(8 * 1024 * 1024);
    const ids = r.events.flatMap((e) => (e.type === "item" ? [e.item.id] : []));
    expect(ids.at(-1)).toBe("b299"); // the newest items stay
    expect(r.trimmed).toBe(300 - ids.length);
    expect(r.trimmed).toBeGreaterThan(0);
    await collie.close();
  });

  test("events needs the epoch and a clean cursor: 400 bad-cursor", async () => {
    const { collie, d } = await open();
    for (const q of ["after=0", "epoch=x", "after=-1&epoch=x", "after=1.5&epoch=x", "after=abc&epoch=x", "after=0&epoch="]) {
      const r = await call(d, "GET", `/pane/p/events?${q}`);
      expect([q, r.status, r.body.code]).toEqual([q, 400, "bad-cursor"]);
    }
    await collie.close();
  });
});
