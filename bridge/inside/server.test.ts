import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostFor } from "../host.ts";

import { dataDescribe } from "./data-rig.ts";
import { FakePart, fakeEdgeTarget, fakeLiveness } from "./fake-part.ts";
import { insideGate } from "./gate.ts";
import { placeHello } from "./place.ts";
import { InsideHub, type Placer } from "./hub.ts";
import { CommandQueue } from "./queue.ts";
import { PartRegistry } from "./registry.ts";
import { HELLO_RATE_BURST, holderOf, InsideServer, insideSocketPath } from "./server.ts";
import { BODY_MAX } from "./wire.ts";

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

// Every test below that opens the socket is `dataDescribe`, a skip on win32: the data path is off on
// Windows in 1.29.0 (ADR 0140, decision 15). This one runs on every platform and proves that refusal
// with an injected host. The gate half is also in gate.test.ts.
describe("Windows keeps the screen path (ADR 0140, decision 15)", () => {
  test("start answers false and logs why, binds and creates nothing; the gate says `platform`", async () => {
    const dir = scratch();
    const lines: string[] = [];
    const hub = new InsideHub({ registry: new PartRegistry({ log: (line) => lines.push(line) }), queue: new CommandQueue(), place: owning(["w1:p1"]) });
    const server = new InsideServer({ socketPath: insideSocketPath(dir), hub, log: (line) => lines.push(line), host: hostFor("win32") });
    expect(await server.start()).toBe(false);
    expect(server.listening).toBe(false);
    expect(lines.join("\n")).toContain("not built for Windows");
    expect(existsSync(join(dir, "inside"))).toBe(false);
    expect(insideGate({ setting: true, linked: true, edges: true, platform: "win32" })).toBe("platform");
    expect(insideGate({ setting: null, linked: true, edges: true, platform: "linux" })).toBe("open");
  });
});

dataDescribe("the socket", () => {
  test("lives in an owner-only folder, mode 0700, and is itself 0600", async () => {
    const dir = scratch();
    const { started, socket } = await start(dir);
    expect(started).toBe(true);
    expect(lstatSync(join(dir, "inside")).mode & 0o777).toBe(0o700);
    expect(lstatSync(socket).isSocket()).toBe(true);
    expect(lstatSync(socket).mode & 0o777).toBe(0o600);
  });

  test("an existing folder with a looser mode is tightened", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "inside"), { mode: 0o755 });
    chmodSync(join(dir, "inside"), 0o755);
    expect((await start(dir)).started).toBe(true);
    expect(lstatSync(join(dir, "inside")).mode & 0o777).toBe(0o700);
  });

  test("a folder that is a link is refused: no socket", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "elsewhere"));
    symlinkSync(join(dir, "elsewhere"), join(dir, "inside"));
    const { started, lines } = await start(dir);
    expect(started).toBe(false);
    expect(lines.join("\n")).toContain("not a folder this user owns");
  });

  test("a folder another user owns is refused", async () => {
    const dir = scratch();
    const hub = new InsideHub({ registry: new PartRegistry({ log: () => {} }), queue: new CommandQueue(), place: owning([]) });
    const lines: string[] = [];
    const server = new InsideServer({ socketPath: insideSocketPath(dir), hub, log: (line) => lines.push(line), uid: (process.getuid?.() ?? 0) + 1 });
    expect(await server.start()).toBe(false);
    expect(lines.join("\n")).toContain("not a folder this user owns");
  });

  test("a stale socket a dead bridge left is removed on start", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "inside"), { mode: 0o700 });
    const path = insideSocketPath(dir);
    // A bridge that dies hard leaves its socket file: a child listens, then is killed with SIGKILL.
    const child = Bun.spawn([process.execPath, "-e", `Bun.serve({ unix: ${JSON.stringify(path)}, fetch: () => new Response("x") }); setInterval(() => {}, 1000);`]);
    for (let i = 0; i < 100 && !existsSync(path); i += 1) await Bun.sleep(20);
    child.kill("SIGKILL");
    await child.exited;
    expect(lstatSync(path).isSocket()).toBe(true);
    // Bun's unix fetch names a dead holder by the exact codes the probe reads (review item 7).
    expect(await holderOf(path)).toBe("dead");
    expect(await holderOf(join(dir, "inside", "missing"))).toBe("dead");
    const { started } = await start(dir);
    expect(started).toBe(true);
    expect(await new FakePart(path).request("GET", "/v1/ping")).toEqual({ status: 200, body: { wire: 1 } });
  });

  test("a socket another live bridge answers on is left alone, and this bridge runs with none", async () => {
    const dir = scratch();
    const first = await start(dir);
    const second = await start(dir);
    expect(first.started).toBe(true);
    expect(second.started).toBe(false);
    expect(second.lines.join("\n")).toContain("another bridge listens");
    expect((await new FakePart(first.socket).request("GET", "/v1/ping")).status).toBe(200);
  });

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

  test("a file that is not a socket is refused and left in place", async () => {
    const dir = scratch();
    mkdirSync(join(dir, "inside"), { mode: 0o700 });
    writeFileSync(insideSocketPath(dir), "not a socket");
    const { started, lines } = await start(dir);
    expect(started).toBe(false);
    expect(lines.join("\n")).toContain("not a socket");
    expect(existsSync(insideSocketPath(dir))).toBe(true);
  });

  test("stop closes the socket and removes the file; a second stop is harmless", async () => {
    const dir = scratch();
    const { server, socket } = await start(dir);
    server.stop();
    server.stop();
    expect(existsSync(socket)).toBe(false);
    expect(server.listening).toBe(false);
  });
});

dataDescribe("several bridges on one machine", () => {
  test("each owns its own socket; the one that owns the pane says mine, the other says not mine", async () => {
    const a = await start(scratch(), ["w1:p1"]);
    const b = await start(scratch(), ["w7:p7"]);
    expect(a.socket).not.toBe(b.socket);
    const env = { HERDR_PANE_ID: "w7:p7", HERDR_SOCKET_PATH: "/run/h.sock" };
    const toA = await new FakePart(a.socket, { env }).hello();
    const toB = await new FakePart(b.socket, { env }).hello();
    expect(toA.body).toEqual({ wire: 1, mine: false, reason: "no-pane" });
    expect(toB.body).toMatchObject({ wire: 1, mine: true });
    expect(b.hub.partOf({ session: "main", paneId: "w7:p7" })).not.toBeNull();
    expect(a.hub.partOf({ session: "main", paneId: "w7:p7" })).toBeNull();
  });
});

dataDescribe("several bridges, the real placement (M99, review of spec 09)", () => {
  test("a part binds to the bridge whose session holds its pane; the other bridge refuses it", async () => {
    const dirA = scratch();
    const dirB = scratch();
    const place = (session: string, panes: string[], scope = "/run/herdr.sock") => (hello: Parameters<Placer>[0]) => placeHello(hello, [fakeEdgeTarget({ session, panes, scope })], fakeLiveness(new Map([[4242, 7]])));
    const hubA = new InsideHub({ registry: new PartRegistry({ log: () => undefined }), queue: new CommandQueue(), place: place("release", ["w1:p1"]) });
    const hubB = new InsideHub({ registry: new PartRegistry({ log: () => undefined }), queue: new CommandQueue(), place: place("next", ["w2:p3"]) });
    for (const [dir, hub] of [[dirA, hubA], [dirB, hubB]] as const) {
      const server = new InsideServer({ socketPath: insideSocketPath(dir), hub, log: () => undefined });
      expect(await server.start()).toBe(true);
      servers.push(server);
    }
    const env = { HERDR_PANE_ID: "w2:p3", HERDR_SOCKET_PATH: "/run/herdr.sock" };
    const fields = { pid: 4242, pidStartTime: 7, env };
    expect((await new FakePart(insideSocketPath(dirA), fields).hello()).body).toEqual({ wire: 1, mine: false, reason: "no-pane" });
    expect((await new FakePart(insideSocketPath(dirB), fields).hello()).body).toMatchObject({ wire: 1, mine: true });
    expect(hubB.partOf({ session: "next", paneId: "w2:p3" })).not.toBeNull();
    expect(hubA.partOf({ session: "release", paneId: "w2:p3" })).toBeNull();
    // The same pane id on another multiplexer server is not this pane: refused too.
    const elsewhere = new InsideHub({ registry: new PartRegistry({ log: () => undefined }), queue: new CommandQueue(), place: place("next", ["w2:p3"], "/run/other-herdr.sock") });
    const dirC = scratch();
    const serverC = new InsideServer({ socketPath: insideSocketPath(dirC), hub: elsewhere, log: () => undefined });
    expect(await serverC.start()).toBe(true);
    servers.push(serverC);
    expect((await new FakePart(insideSocketPath(dirC), fields).hello()).body).toMatchObject({ mine: false });
    // A part of a later wire is refused by both.
    expect((await new FakePart(insideSocketPath(dirB), { ...fields, wire: 2 }).hello()).status).not.toBe(200);
  });
});

dataDescribe("caps", () => {
  test("a body past the socket's cap is refused with 413, and the server keeps serving", async () => {
    const { socket } = await start(scratch());
    const part = new FakePart(socket);
    const big = await part.request("POST", "/v1/event", "x".repeat(BODY_MAX + 10)).catch(() => ({ status: 413, body: null }));
    expect(big.status).toBe(413);
    const hello = await part.request("POST", "/v1/hello", { wire: 1, harness: "fake", pid: 1, pad: "x".repeat(20_000) });
    expect(hello.status).toBe(413);
    expect((await part.request("GET", "/v1/ping")).status).toBe(200);
  });

  test("hellos past the rate cap answer 429", async () => {
    const { socket } = await start(scratch());
    const part = new FakePart(socket, { env: { HERDR_PANE_ID: "w1:p1" } });
    const statuses: number[] = [];
    for (let i = 0; i < HELLO_RATE_BURST + 5; i += 1) statuses.push((await part.hello()).status);
    expect(statuses.slice(0, HELLO_RATE_BURST).every((status) => status === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  test("an unknown part id answers 410, so a part knows to say hello again", async () => {
    const { socket } = await start(scratch());
    const part = new FakePart(socket);
    part.partId = "z".repeat(22);
    expect((await part.event("turn.start")).status).toBe(410);
    expect((await part.next({ waitMs: 1000 })).status).toBe(410);
  });

  test("bad input answers 400 and 404, never a crash", async () => {
    const { socket } = await start(scratch());
    const part = new FakePart(socket);
    expect((await part.request("POST", "/v1/hello", "{")).status).toBe(400);
    expect((await part.request("POST", "/v1/event", { kind: "bye" })).status).toBe(400);
    expect((await part.request("GET", "/v1/next?part=x")).status).toBe(400);
    expect((await part.request("GET", "/v1/elsewhere")).status).toBe(404);
  });

  test("no body text reaches the log", async () => {
    const { socket, lines, hub } = await start(scratch());
    const part = new FakePart(socket, { env: { HERDR_PANE_ID: "w1:p1" } });
    await part.hello();
    hub.enqueue({ session: "main", paneId: "w1:p1" }, { id: "req-secret01", kind: "prompt", text: "my password is placeholder-hunter2" });
    await part.serveOnce();
    await part.event("ask.open", { ask: "a1", askKind: "permission", tool: "Bash", input: { command: "cat placeholder-secret" } });
    const log = lines.join("\n");
    expect(log).toContain("cmd=req-secret01 kind=prompt");
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain("placeholder-secret");
  });

  test("the part's sent and failed are logged with the command id, the reason and its own words, never the text", async () => {
    const { socket, lines, hub } = await start(scratch());
    const part = new FakePart(socket, { env: { HERDR_PANE_ID: "w1:p1" } });
    await part.hello();
    const address = { session: "main", paneId: "w1:p1" };
    hub.enqueue(address, { id: "req-logsent1", kind: "prompt", text: "placeholder-hunter2 went" });
    await part.serveOnce();
    hub.enqueue(address, { id: "req-logfail1", kind: "prompt", text: "placeholder-hunter3 stayed" });
    await part.serveOnce({ failReason: "dropped", failDetail: "blocked by a hook\nsecond line" });
    const log = lines.join("\n");
    expect(log).toMatch(/\[inside\] sent part=\S{6} cmd=req-logsent1$/mu);
    expect(log).toMatch(/\[inside\] failed part=\S{6} cmd=req-logfail1 reason=dropped detail="blocked by a hook second line"$/mu);
    expect(hub.failReasonOf("req-logfail1")).toBe("dropped");
    expect(hub.failDetailOf("req-logfail1")).toBe("blocked by a hook second line");
    expect(log).not.toContain("hunter2");
    expect(log).not.toContain("hunter3");
  });

  test("a failed word from an older part, with no detail, is logged and kept with none", async () => {
    const { socket, lines, hub } = await start(scratch());
    const part = new FakePart(socket, { env: { HERDR_PANE_ID: "w1:p1" } });
    await part.hello();
    hub.enqueue({ session: "main", paneId: "w1:p1" }, { id: "req-logfail2", kind: "prompt", text: "hi" });
    await part.serveOnce({ failReason: "submit" });
    expect(lines.join("\n")).toMatch(/\[inside\] failed part=\S{6} cmd=req-logfail2 reason=submit$/mu);
    expect(hub.failDetailOf("req-logfail2")).toBeNull();
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
