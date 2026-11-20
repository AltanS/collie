import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dataDescribe } from "./data-rig.ts";
import { fakeEdgeTarget, fakeLiveness, FakePart } from "./fake-part.ts";
import { InsideHub, type InsideListener } from "./hub.ts";
import { placeHello } from "./place.ts";
import { CommandQueue } from "./queue.ts";
import { PartRegistry } from "./registry.ts";
import { InsideServer, insideSocketPath } from "./server.ts";
import type { WireEvent } from "./wire.ts";

const PANE = { session: "main", paneId: "w1:p1" };
const ENV = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/herdr.sock" };

const target = fakeEdgeTarget({ session: "main", panes: ["w1:p1", "w1:p2"], foreground: [process.pid] });
const liveness = fakeLiveness(new Map([[process.pid, 7]]));

const servers: InsideServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

async function rig() {
  const hub = new InsideHub({ registry: new PartRegistry({ log: () => {} }), queue: new CommandQueue(), place: (hello) => placeHello(hello, [target], liveness) });
  const events: WireEvent[] = [];
  const listener: InsideListener = { event: (_part, event) => events.push(event) };
  hub.listen(listener);
  const socket = insideSocketPath(mkdtempSync(join(tmpdir(), "rd-")));
  const server = new InsideServer({ socketPath: socket, hub, log: () => {} });
  expect(await server.start()).toBe(true);
  servers.push(server);
  return { hub, events, socket };
}

dataDescribe("a whole round with the fake part", () => {
  test("hello, a prompt handed over and reported sent, wake events, a draft, bye", async () => {
    const { hub, events, socket } = await rig();
    const part = new FakePart(socket, { env: ENV, pidStartTime: 7 });

    const hello = await part.hello();
    expect(hello.body).toMatchObject({ wire: 1, mine: true, capabilities: ["send", "mail", "draft", "draft.state", "wake"], asks: ["permission"] });
    expect(hub.partOf(PANE)?.partId).toBe(part.partId!);

    // A prompt: queued by the bridge, taken by the part's poll, reported sent.
    expect(hub.enqueue(PANE, { id: "req-round001", kind: "prompt", text: "Reply with pong." })).toEqual({ ok: true });
    const settled = hub.waitFor("req-round001", ["sent", "failed"], 5000);
    expect(await part.serveOnce()).toEqual({ id: "req-round001", kind: "prompt", text: "Reply with pong." });
    expect(await settled).toBe("sent");

    // Wake events reach the listener; the row carries its door and id, never text.
    expect((await part.event("turn.start", { turn: "t1" })).status).toBe(204);
    expect((await part.event("row", { door: "response", row: "u-1", text: "never kept" })).status).toBe(204);
    expect((await part.event("turn.end", { turn: "t1", reason: "answer" })).status).toBe(204);
    expect(events.filter((event) => ["turn.start", "row", "turn.end"].includes(event.kind))).toEqual([
      { ok: true, part: part.partId!, kind: "turn.start", turn: "t1", seq: null },
      { ok: true, part: part.partId!, kind: "row", door: "response", row: "u-1" },
      { ok: true, part: part.partId!, kind: "turn.end", turn: "t1", reason: "answer", seq: null },
    ]);

    // A draft question, answered with the box's text.
    expect(hub.enqueue(PANE, { id: "drf-round001", kind: "draft" })).toEqual({ ok: true });
    await part.serveOnce({ draftText: "half a thought" });
    expect(events.find((event) => event.kind === "draft")).toMatchObject({ cmd: "drf-round001", text: "half a thought", caret: 14 });
    expect(hub.stateOf("drf-round001")).toBe("sent");

    // Bye: the pane has no part, and the screen path holds again.
    expect((await part.bye()).status).toBe(204);
    expect(hub.partOf(PANE)).toBeNull();
    expect(hub.enqueue(PANE, { id: "req-round002", kind: "prompt", text: "x" })).toEqual({ ok: false, reason: "no-part" });
  });

  test("a hello for a pane of no session here is not mine, and binds nothing", async () => {
    const { hub, socket } = await rig();
    const part = new FakePart(socket, { env: { ...ENV, HERDR_PANE_ID: "w9:p9" }, pidStartTime: 7 });
    expect((await part.hello()).body).toEqual({ wire: 1, mine: false, reason: "no-pane" });
    expect(hub.partOf(PANE)).toBeNull();
  });

  test("capabilities fail closed: an undeclared command is not queued, undeclared wake events reach nobody", async () => {
    const { hub, events, socket } = await rig();
    const part = new FakePart(socket, { env: ENV, pidStartTime: 7, capabilities: ["send"], asks: [] });
    await part.hello();
    expect(hub.enqueue(PANE, { id: "req-mail0001", kind: "mail", text: "hi" })).toEqual({ ok: false, reason: "not-declared" });
    expect(hub.enqueue(PANE, { id: "req-steer001", kind: "steer", text: "hi" })).toEqual({ ok: false, reason: "not-declared" });
    await part.event("turn.start");
    expect(events).toEqual([]);
    const ask = await part.event("ask.open", { ask: "a1", askKind: "permission", tool: "Bash" });
    expect(ask.body).toEqual({ wait: false });
  });

  test("ask.close withdraws an answer still queued for that ask, and only that one", async () => {
    const { hub, socket } = await rig();
    const part = new FakePart(socket, { env: ENV, pidStartTime: 7 });
    await part.hello();
    hub.listen({ ask: () => ({ wait: true, waitMs: 60_000 }) });
    await part.event("ask.open", { ask: "a1", askKind: "permission", tool: "Bash" });
    await part.event("ask.open", { ask: "a2", askKind: "permission", tool: "Bash" });
    hub.enqueue(PANE, { id: "ans-close001", kind: "answer", ask: "a1", decision: "allow" });
    hub.enqueue(PANE, { id: "ans-close002", kind: "answer", ask: "a2", decision: "deny" });
    expect((await part.event("ask.close", { ask: "a1", how: "desk" })).status).toBe(204);
    expect(hub.stateOf("ans-close001")).toBe("withdrawn");
    expect(hub.stateOf("ans-close002")).toBe("queued");
  });

  test("a reload: the new hello replaces the part, the old id is dead, a queued command waits for the new part", async () => {
    const { hub, socket } = await rig();
    const before = new FakePart(socket, { env: ENV, pidStartTime: 7 });
    await before.hello();
    const oldPoll = before.next({ waitMs: 5000 });
    const after = new FakePart(socket, { env: ENV, pidStartTime: 7 });
    await after.hello();
    expect((await oldPoll).status).toBe(410);
    hub.enqueue(PANE, { id: "req-reload01", kind: "prompt", text: "once" });
    expect((await before.next({ waitMs: 1000 })).status).toBe(410);
    expect((await after.serveOnce())?.id).toBe("req-reload01");
    expect(hub.stateOf("req-reload01")).toBe("sent");
  });
});
