// The slow cases of round.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

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
  test("an ask: no listener means do not wait; with one, the answer goes to the poll on that ask only", async () => {
    const { hub, socket } = await rig();
    const part = new FakePart(socket, { env: ENV, pidStartTime: 7 });
    await part.hello();
    expect((await part.event("ask.open", { ask: "a0", askKind: "permission", tool: "Bash" })).body).toEqual({ wait: false });

    hub.listen({ ask: () => ({ wait: true, waitMs: 60_000 }) });
    expect((await part.event("ask.open", { ask: "a1", askKind: "permission", tool: "Bash", input: { command: "touch x" } })).body).toEqual({ wait: true, waitMs: 60_000 });
    const main = part.next({ waitMs: 1500 });
    const onAsk = part.next({ ask: "a1", waitMs: 5000 });
    expect(hub.enqueue(PANE, { id: "ans-round001", kind: "answer", ask: "a1", decision: "deny" })).toEqual({ ok: true });
    expect((await onAsk).command).toMatchObject({ kind: "answer", ask: "a1", decision: "deny" });
    expect((await main).status).toBe(204);
    expect(hub.enqueue(PANE, { id: "ans-round002", kind: "answer", ask: "nope", decision: "allow" })).toEqual({ ok: false, reason: "no-ask" });
    expect((await part.next({ ask: "never-opened", waitMs: 1000 })).status).toBe(404);
  });

  test("withdraw before take: the part never sees it; after take: withdraw is refused", async () => {
    const { hub, socket } = await rig();
    const part = new FakePart(socket, { env: ENV, pidStartTime: 7 });
    await part.hello();
    hub.enqueue(PANE, { id: "req-wdraw001", kind: "prompt", text: "one" });
    expect(hub.withdraw("req-wdraw001")).toBe(true);
    expect((await part.next({ waitMs: 1000 })).status).toBe(204);
    hub.enqueue(PANE, { id: "req-wdraw002", kind: "prompt", text: "two" });
    await part.serveOnce({ silent: true });
    expect(hub.withdraw("req-wdraw002")).toBe(false);
    expect(hub.stateOf("req-wdraw002")).toBe("taken");
  });
});
