// The slow cases of server.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDescribe } from "./data-rig.ts";
import { FakePart } from "./fake-part.ts";
import { InsideHub, type Placer } from "./hub.ts";
import { CommandQueue } from "./queue.ts";
import { PartRegistry } from "./registry.ts";
import { InsideServer, insideSocketPath } from "./server.ts";

const servers: InsideServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

/** A placer that owns the panes named, by the raw HERDR_PANE_ID a part sends. */
const owning =
  (panes: string[]): Placer =>
  (hello) => {
    const pane = hello.env.HERDR_PANE_ID;
    return Promise.resolve(pane !== undefined && panes.includes(pane) ? { kind: "placed", address: { session: "main", paneId: pane }, pidStartTime: 7 } : { kind: "not-mine", reason: "no-pane" });
  };

async function start(stateDir: string, panes: string[] = ["w1:p1"]) {
  const lines: string[] = [];
  const hub = new InsideHub({ registry: new PartRegistry({ log: (line) => lines.push(line) }), queue: new CommandQueue(), place: owning(panes), log: (line) => lines.push(line) });
  const server = new InsideServer({ socketPath: insideSocketPath(stateDir), hub, log: (line) => lines.push(line) });
  const started = await server.start();
  if (started) servers.push(server);
  return { hub, server, started, lines, socket: insideSocketPath(stateDir) };
}

const scratch = (): string => mkdtempSync(join(tmpdir(), "in-"));

dataDescribe("the socket", () => {
  test("a socket whose holder accepts but does not answer in time is left alone: no start, no delete", async () => {
    const dir = scratch();
    const path = insideSocketPath(dir);
    mkdirSync(join(dir, "inside"), { recursive: true, mode: 0o700 });
    // A frozen bridge: the kernel accepts the connection, nothing answers.
    const { createServer } = await import("node:net");
    const frozen = createServer(() => {});
    await new Promise<void>((done) => frozen.listen(path, done));
    try {
      const second = await start(dir);
      expect(second.started).toBe(false);
      expect(second.lines.join("\n")).toContain("no clear answer from");
      expect(lstatSync(path).isSocket()).toBe(true);
    } finally {
      frozen.close();
    }
  });
});

dataDescribe("the long poll", () => {
  // Bun checks its idle limit on a coarse timer: a request past its 10 s default is cut after 10 to 12 s. A
  // wait of 11.5 s passed inside that window while every real 25 s poll was cut (`server.timeout()` does
  // nothing on a Unix socket in Bun 1.4), so the wait here is well past it.
  test("outlives Bun's 10 s default request timeout and ends empty at its own limit", async () => {
    const { socket } = await start(scratch());
    const part = new FakePart(socket, { env: { HERDR_PANE_ID: "w1:p1" } });
    await part.hello();
    const started = Date.now();
    const answer = await part.next({ waitMs: 20_000 });
    expect(answer.status).toBe(204);
    expect(Date.now() - started).toBeGreaterThanOrEqual(19_500);
  }, 30_000);
});
