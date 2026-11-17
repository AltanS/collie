// The local API socket: its life (decision 14), its framing, its caps (decision 18). Each test makes a
// socket in its own temp folder under the system's temp dir and removes it; no TCP port is opened.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, lstatSync, existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/bus.ts";
import { encodeSessionId } from "../events/session-id.ts";
import type { JsonObject } from "../json.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { CONNECTIONS_MAX, IDLE_MS, REQUEST_LINE_MAX, REQUEST_LINE_MS, REQUESTS_PER_CONNECTION, WAITS_PER_CONNECTION, WAITS_TOTAL } from "./limits.ts";
import { buildTable, LOCAL_TIER_RIGHTS, type OpResult, type ReadHandlers } from "./operations.ts";
import { ApiSocket, apiSocketPath } from "./socket.ts";

const roots: string[] = [];
const sockets: ApiSocket[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const socket of sockets.splice(0)) await socket.stop();
});
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SESSION = encodeSessionId({ machine: "inst-test-a1", paneId: "w1:p2", instance: "k3f9" });

/** A gate a stub handler waits on, so a test decides when it answers. */
interface Gate {
  readonly wait: Promise<void>;
  readonly open: () => void;
}

function gate(): Gate {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

interface Rig {
  readonly path: string;
  readonly dir: string;
  readonly bus: EventBus;
  readonly api: ApiSocket;
  readonly logs: string[];
  readonly briefGate: Gate;
}

interface RigOptions {
  readonly platform?: NodeJS.Platform;
  readonly lineMs?: number;
  readonly idleMs?: number;
  readonly sessions?: () => Promise<OpResult>;
}

function rig(opts: RigOptions = {}): Rig {
  const root = mkdtempSync(join(tmpdir(), "collie-api-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const path = apiSocketPath(stateDir);
  const bus = new EventBus({ machine: () => "inst-test-a1", bootId: "boot1" });
  const briefGate = gate();
  const reads: ReadHandlers = {
    sessions: opts.sessions ?? (async () => ({ ok: true, answer: { sessions: [] } })),
    brief: async (args) => {
      await briefGate.wait;
      return { ok: true, answer: { session: args.session, state: "idle" } };
    },
    read: async () => {
      throw new Error("a stub that fails");
    },
    accounts: async () => ({ ok: true, answer: { accounts: [] } }),
    "hill.list": async () => ({ ok: true, answer: { decisions: [] } }),
  };
  const logs: string[] = [];
  const api = new ApiSocket({
    socketPath: path,
    table: buildTable({ version: () => "9.9.9-test", bus, reads }),
    granted: LOCAL_TIER_RIGHTS,
    log: (line) => logs.push(line),
    platform: opts.platform ?? process.platform,
    lineMs: opts.lineMs ?? REQUEST_LINE_MS,
    idleMs: opts.idleMs ?? IDLE_MS,
  });
  sockets.push(api);
  return { path, dir: join(stateDir, "api"), bus, api, logs, briefGate };
}

/** A line client over the socket. */
class Client {
  private buffer = "";
  private readonly lines: JsonObject[] = [];
  private readonly waiting: ((line: JsonObject) => void)[] = [];
  readonly ended: Promise<void>;

  private constructor(readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("error", () => undefined);
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let at = this.buffer.indexOf("\n"); at >= 0; at = this.buffer.indexOf("\n")) {
        const line = parseJsonObject(this.buffer.slice(0, at));
        this.buffer = this.buffer.slice(at + 1);
        if (line === undefined) throw new Error("the server wrote a line that is not JSON");
        const next = this.waiting.shift();
        if (next === undefined) this.lines.push(line);
        else next(line);
      }
    });
    this.ended = new Promise((resolve) => {
      socket.on("close", () => resolve());
    });
  }

  static async open(path: string): Promise<Client> {
    const socket = createConnection({ path });
    await once(socket, "connect");
    const client = new Client(socket);
    clients.push(client);
    return client;
  }

  send(request: JsonObject): void {
    this.socket.write(`${JSON.stringify(request)}\n`);
  }

  sendRaw(text: string): void {
    this.socket.write(text);
  }

  next(ms = 3000): Promise<JsonObject> {
    const held = this.lines.shift();
    if (held !== undefined) return Promise.resolve(held);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no line in time")), ms);
      this.waiting.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  async ask(request: JsonObject): Promise<JsonObject> {
    this.send(request);
    return this.next();
  }

  close(): void {
    this.socket.destroy();
  }
}

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function codeOf(line: JsonObject): string | undefined {
  return asJsonString(asJsonObject(line.error)?.code);
}

function messageOf(line: JsonObject): string | undefined {
  return asJsonString(asJsonObject(line.error)?.message);
}

describe("the socket's life", () => {
  test("no socket until started: a bridge with no trick on has none", () => {
    const r = rig();
    expect(existsSync(r.path)).toBe(false);
    expect(r.api.running()).toBe(false);
  });

  test("started: a socket of mode 0600 in a folder of mode 0700; stopped: gone", async () => {
    const r = rig();
    expect(await r.api.start()).toBe(true);
    expect(lstatSync(r.path).isSocket()).toBe(true);
    expect(modeOf(r.path)).toBe(0o600);
    expect(modeOf(r.dir)).toBe(0o700);
    await r.api.stop();
    expect(existsSync(r.path)).toBe(false);
    expect(r.api.running()).toBe(false);
  });

  test("a folder that was wider is made 0700", async () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true, mode: 0o755 });
    expect(await r.api.start()).toBe(true);
    expect(modeOf(r.dir)).toBe(0o700);
  });

  test("the count drives it as bridge/index.ts wires it: above zero on, zero off", async () => {
    const r = rig();
    const told = async (count: number): Promise<void> => {
      if (count > 0) await r.api.start();
      else await r.api.stop();
    };
    await told(0);
    expect(existsSync(r.path)).toBe(false);
    await told(2);
    expect(existsSync(r.path)).toBe(true);
    await told(1);
    expect(existsSync(r.path)).toBe(true);
    await told(0);
    expect(existsSync(r.path)).toBe(false);
  });

  test("start and stop are idempotent", async () => {
    const r = rig();
    expect(await r.api.start()).toBe(true);
    const ino = lstatSync(r.path).ino;
    expect(await r.api.start()).toBe(true);
    expect(lstatSync(r.path).ino).toBe(ino);
    await r.api.stop();
    await r.api.stop();
    expect(existsSync(r.path)).toBe(false);
  });

  test("on, off, on at once: one server, on its own socket file, answering", async () => {
    const r = rig();
    const a = r.api.start();
    const b = r.api.stop();
    const c = r.api.start();
    expect([await a, await c]).toEqual([true, true]);
    await b;
    expect(r.api.running()).toBe(true);
    expect(lstatSync(r.path).isSocket()).toBe(true);
    const client = await Client.open(r.path);
    expect(await client.ask({ id: "h", op: "hello" })).toMatchObject({ id: "h", ok: true });
    // And off, on, off at once ends with no socket.
    const d = r.api.stop();
    const e = r.api.start();
    const f = r.api.stop();
    await Promise.all([d, e, f]);
    expect(r.api.running()).toBe(false);
    expect(existsSync(r.path)).toBe(false);
  });

  test("a dead socket file left behind is replaced", async () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true, mode: 0o700 });
    // A socket file nobody listens on: bind one elsewhere, move the file to the path, close the server.
    const aside = join(r.dir, "aside");
    const stale = createServer();
    await new Promise<void>((resolve) => stale.listen(aside, resolve));
    renameSync(aside, r.path);
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    expect(lstatSync(r.path).isSocket()).toBe(true);
    const before = lstatSync(r.path).ino;
    expect(await r.api.start()).toBe(true);
    expect(lstatSync(r.path).ino).not.toBe(before);
    const client = await Client.open(r.path);
    expect(await client.ask({ op: "hello" })).toMatchObject({ ok: true });
  });

  test("a socket another process answers on is left alone, and no server starts", async () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true, mode: 0o700 });
    const other = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => other.listen(r.path, resolve));
    try {
      expect(await r.api.start()).toBe(false);
      expect(r.api.running()).toBe(false);
      expect(r.logs.some((line) => line.includes("another process listens"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });

  test("a file at the path that is not a socket is refused and left as it is", async () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true, mode: 0o700 });
    writeFileSync(r.path, "not a socket");
    expect(await r.api.start()).toBe(false);
    expect(readFileSync(r.path, "utf8")).toBe("not a socket");
    expect(r.logs.some((line) => line.includes("is not a socket"))).toBe(true);
  });

  test("Windows: no socket, said once", async () => {
    const r = rig({ platform: "win32" });
    expect(await r.api.start()).toBe(false);
    expect(await r.api.start()).toBe(false);
    expect(existsSync(r.dir)).toBe(false);
    expect(r.logs.filter((line) => line.includes("needs a Unix socket"))).toHaveLength(1);
  });

  test("stop removes the socket file at once, before the next start runs", async () => {
    // The runtime unlinks a Unix server's path inside close(), at once and by name (a probe on Bun 1.4,
    // 2026-11-17): so a stop never leaves the file behind, and a later start in the chain never has its
    // fresh file removed by an earlier close that finished late.
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    const stopping = r.api.stop();
    const starting = r.api.start();
    await stopping;
    expect(await starting).toBe(true);
    await client.ended;
    await Bun.sleep(50);
    expect(lstatSync(r.path).isSocket()).toBe(true);
    const fresh = await Client.open(r.path);
    expect(await fresh.ask({ op: "hello" })).toMatchObject({ ok: true });
  });
});

describe("the framing", () => {
  test("several requests on one connection, answered by id, out of order", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    client.send({ id: "slow", op: "brief", args: { session: SESSION } });
    client.send({ id: "fast", op: "sessions" });
    expect(await client.next()).toEqual({ id: "fast", ok: true, sessions: [] });
    r.briefGate.open();
    expect(await client.next()).toEqual({ id: "slow", ok: true, session: SESSION, state: "idle" });
  });

  test("two requests in one write, and one request split over writes", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    client.sendRaw(`${JSON.stringify({ id: "1", op: "accounts" })}\n${JSON.stringify({ id: "2", op: "hill.list" })}\n{"id":"3",`);
    expect(await client.next()).toMatchObject({ id: "1", ok: true });
    expect(await client.next()).toMatchObject({ id: "2", ok: true });
    client.sendRaw(`"op":"hello"}\n`);
    expect(await client.next()).toMatchObject({ id: "3", ok: true, api: 1 });
  });

  test("a request with no id gets an answer with no id key", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    const answer = await client.ask({ op: "accounts" });
    expect(answer).toEqual({ ok: true, accounts: [] });
  });

  test("a line that is no request answers bad_request and the connection stays usable", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    client.sendRaw("{not json\n");
    const bad = await client.next();
    expect(Object.keys(bad)).toEqual(["ok", "error"]);
    expect(bad).toMatchObject({ ok: false, error: { code: "api.bad_request" } });
    expect(messageOf(bad)).toContain("the line is not a JSON object");
    for (const line of ["[1]\n", '"op"\n', '{"op":"hello","extra":1}\n', '{"op":3}\n', '{"op":"hello","args":[1]}\n', '{"id":"x".repeat(1),"op":"hello"}\n']) {
      client.sendRaw(line);
      expect(codeOf(await client.next())).toBe("api.bad_request");
    }
    // An id that is not one is never echoed.
    client.sendRaw(`${JSON.stringify({ id: "i".repeat(65), op: "hello" })}\n`);
    expect(await client.next()).toEqual({ ok: false, error: expect.objectContaining({ code: "api.bad_request" }) });
    client.sendRaw(`${JSON.stringify({ id: 7, op: "hello" })}\n`);
    expect("id" in (await client.next())).toBe(false);
    expect(await client.ask({ id: "after", op: "hello" })).toMatchObject({ id: "after", ok: true });
  });

  test("an unknown op answers unknown_op with its id, and the message names the next step", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    const answer = await client.ask({ id: "u", op: "send", args: { session: SESSION, text: "hi" } });
    expect(answer).toEqual({ id: "u", ok: false, error: { code: "api.unknown_op", message: "the local API has no such operation here; send hello to see the operations it offers" } });
  });

  test("a handler that throws answers failed, and says nothing of why", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    const answer = await client.ask({ id: "r", op: "read", args: { session: SESSION } });
    expect(answer).toMatchObject({ id: "r", ok: false, error: { code: "api.failed" } });
    expect(JSON.stringify(answer)).not.toContain("a stub that fails");
    expect(r.logs.some((line) => line.includes("a stub that fails"))).toBe(true);
  });

  test("a line past 16 KiB answers bad_request and closes the connection", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    client.sendRaw("x".repeat(REQUEST_LINE_MAX + 1));
    expect(await client.next()).toMatchObject({ ok: false, error: { code: "api.bad_request" } });
    await client.ended;
    // A line just at the cap is read.
    const second = await Client.open(r.path);
    const request = JSON.stringify({ op: "hello", id: "c" });
    second.sendRaw(`${request}${" ".repeat(REQUEST_LINE_MAX - request.length)}\n`);
    expect(await second.next()).toMatchObject({ id: "c", ok: true });
  });

  test("a line that does not end in time closes the connection; an idle connection stays", async () => {
    const r = rig({ lineMs: 100 });
    await r.api.start();
    const slow = await Client.open(r.path);
    const idle = await Client.open(r.path);
    slow.sendRaw('{"op":');
    expect(await slow.next()).toMatchObject({ ok: false, error: { code: "api.bad_request" } });
    await slow.ended;
    await Bun.sleep(150);
    expect(await idle.ask({ op: "hello" })).toMatchObject({ ok: true });
  });

  test("an answer past 1 MiB becomes answer_too_large, with its id", async () => {
    const r = rig({ sessions: async () => ({ ok: true, answer: { sessions: ["s".repeat(1024 * 1024)] } }) });
    await r.api.start();
    const client = await Client.open(r.path);
    expect(await client.ask({ id: "big", op: "sessions" })).toEqual({
      id: "big",
      ok: false,
      error: { code: "api.answer_too_large", message: "the answer is larger than 1048576 bytes; ask for less" },
    });
  });

  test("an answer cannot overwrite id, ok or error", async () => {
    const r = rig({ sessions: async () => ({ ok: true, answer: { ok: false, id: "forged" } }) });
    await r.api.start();
    const client = await Client.open(r.path);
    expect(await client.ask({ id: "real", op: "sessions" })).toMatchObject({ id: "real", ok: false, error: { code: "api.failed" } });
  });

  test("past 32 connections one more gets one line and is closed", async () => {
    const r = rig();
    await r.api.start();
    const held: Client[] = [];
    for (let i = 0; i < CONNECTIONS_MAX; i += 1) held.push(await Client.open(r.path));
    expect(await held[0]!.ask({ op: "hello" })).toMatchObject({ ok: true });
    const extra = await Client.open(r.path);
    expect(await extra.next()).toMatchObject({ ok: false, error: { code: "api.too_many_connections" } });
    await extra.ended;
    held[1]!.close();
    await Bun.sleep(30);
    const again = await Client.open(r.path);
    expect(await again.ask({ op: "hello" })).toMatchObject({ ok: true });
  });
});

describe("the waits", () => {
  test("an events wait wakes on a publish, and a sessions answer on the same connection is not held up", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    client.send({ id: "w", op: "events", args: { wait: 10 } });
    expect(await client.ask({ id: "s", op: "sessions" })).toMatchObject({ id: "s", ok: true });
    r.bus.publish({ type: "turn.end", session: SESSION });
    const answer = await client.next();
    expect(answer).toMatchObject({ id: "w", ok: true, next: "boot1.1", events: [{ type: "turn.end", session: SESSION }] });
    expect(r.bus.listeners().waits).toBe(0);
  });

  test("an events wait times out with no events and the same cursor", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    const answer = await client.ask({ id: "t", op: "events", args: { after: "boot1.0", wait: 1 } });
    expect(answer).toEqual({ id: "t", ok: true, events: [], next: "boot1.0" });
    expect(r.api.counts().waits).toBe(0);
  });

  test("the fifth wait on one connection is refused at once", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    for (let i = 0; i < WAITS_PER_CONNECTION; i += 1) client.send({ id: `w${String(i)}`, op: "events", args: { wait: 25 } });
    await Bun.sleep(30);
    expect(r.api.counts().waits).toBe(WAITS_PER_CONNECTION);
    expect(await client.ask({ id: "fifth", op: "events", args: { wait: 25 } })).toMatchObject({ id: "fifth", ok: false, error: { code: "api.too_many_waits" } });
    // A poll with no wait still answers.
    expect(await client.ask({ id: "poll", op: "events" })).toMatchObject({ id: "poll", ok: true });
  });

  test("the seventeenth wait in all is refused at once", async () => {
    const r = rig();
    await r.api.start();
    const owners: Client[] = [];
    for (let c = 0; c < WAITS_TOTAL / WAITS_PER_CONNECTION; c += 1) {
      const client = await Client.open(r.path);
      owners.push(client);
      for (let i = 0; i < WAITS_PER_CONNECTION; i += 1) client.send({ op: "events", args: { wait: 25 } });
    }
    await Bun.sleep(30);
    expect([r.api.counts().waits, r.bus.listeners().waits]).toEqual([WAITS_TOTAL, WAITS_TOTAL]);
    const late = await Client.open(r.path);
    expect(await late.ask({ id: "17", op: "events", args: { wait: 25 } })).toMatchObject({ id: "17", ok: false, error: { code: "api.too_many_waits" } });
  });

  test("stop ends every open wait at once with closing, closes the connections and leaves no listener", async () => {
    const r = rig();
    await r.api.start();
    const a = await Client.open(r.path);
    const b = await Client.open(r.path);
    a.send({ id: "a1", op: "events", args: { wait: 25 } });
    a.send({ id: "a2", op: "events", args: { wait: 25 } });
    b.send({ id: "b1", op: "events", args: { wait: 25 } });
    await Bun.sleep(30);
    expect(r.bus.listeners().waits).toBe(3);
    const started = Date.now();
    await r.api.stop();
    const closing = { ok: false, error: { code: "api.closing", message: "the local API is closing: it is on only while a trick is switched on; switch one on and connect again" } };
    const aLines = [await a.next(), await a.next()].map((line) => line.id).toSorted();
    expect(aLines).toEqual(["a1", "a2"]);
    expect(await b.next()).toEqual({ id: "b1", ...closing });
    await Promise.all([a.ended, b.ended]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.bus.listeners().waits).toBe(0);
    expect(r.api.counts()).toEqual({ connections: 0, waits: 0 });
    expect(existsSync(r.path)).toBe(false);
  });

  test("a client that closes aborts its waits: no listener and no slot leaks", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    for (let i = 0; i < 3; i += 1) client.send({ op: "events", args: { wait: 25 } });
    await Bun.sleep(30);
    expect(r.bus.listeners().waits).toBe(3);
    client.close();
    await Bun.sleep(30);
    expect(r.bus.listeners().waits).toBe(0);
    expect(r.api.counts()).toEqual({ connections: 0, waits: 0 });
  });

  test("a wait that wakes after its socket file was removed answers closing", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    client.send({ id: "w", op: "events", args: { wait: 10 } });
    await Bun.sleep(30);
    unlinkSync(r.path);
    r.bus.publish({ type: "turn.end", session: SESSION });
    expect(await client.next()).toMatchObject({ id: "w", ok: false, error: { code: "api.closing" } });
  });
});

describe("requests in flight and idle connections", () => {
  test("the ninth request in flight on one connection, waits included, is refused at once; answers free the places", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    for (let i = 0; i < WAITS_PER_CONNECTION; i += 1) client.send({ id: `w${String(i)}`, op: "events", args: { wait: 25 } });
    for (let i = WAITS_PER_CONNECTION; i < REQUESTS_PER_CONNECTION; i += 1) client.send({ id: `b${String(i)}`, op: "brief", args: { session: SESSION } });
    expect(await client.ask({ id: "ninth", op: "hello" })).toEqual({
      id: "ninth",
      ok: false,
      error: { code: "api.too_many_requests", message: "too many requests are in flight on this connection (at most 8); wait for an answer before you send more" },
    });
    // Another connection is not counted against this one.
    const other = await Client.open(r.path);
    expect(await other.ask({ op: "hello" })).toMatchObject({ ok: true });
    r.briefGate.open();
    const answered = [];
    for (let i = WAITS_PER_CONNECTION; i < REQUESTS_PER_CONNECTION; i += 1) answered.push((await client.next()).id);
    expect(answered.toSorted()).toEqual(["b4", "b5", "b6", "b7"]);
    expect(await client.ask({ id: "after", op: "hello" })).toMatchObject({ id: "after", ok: true });
  });

  test("an idle connection is closed with no line; one with a request in flight or a partial line stays", async () => {
    const r = rig({ idleMs: 100, lineMs: 2000 });
    await r.api.start();
    const idle = await Client.open(r.path);
    const busy = await Client.open(r.path);
    const typing = await Client.open(r.path);
    busy.send({ id: "b", op: "brief", args: { session: SESSION } });
    typing.sendRaw('{"id":"t",');
    await idle.ended;
    await Bun.sleep(250);
    expect([busy.socket.destroyed, typing.socket.destroyed]).toEqual([false, false]);
    expect(r.api.counts().connections).toBe(2);
    typing.sendRaw('"op":"hello"}\n');
    expect(await typing.next()).toMatchObject({ id: "t", ok: true });
    r.briefGate.open();
    expect(await busy.next()).toMatchObject({ id: "b", ok: true });
    // Answered and quiet again: the idle clock runs once more.
    await Promise.all([busy.ended, typing.ended]);
    expect(r.api.counts().connections).toBe(0);
  });

  test("a connection that keeps asking is not idle", async () => {
    const r = rig({ idleMs: 150 });
    await r.api.start();
    const client = await Client.open(r.path);
    for (let i = 0; i < 4; i += 1) {
      await Bun.sleep(80);
      expect(await client.ask({ op: "hello" })).toMatchObject({ ok: true });
    }
    expect(client.socket.destroyed).toBe(false);
  });
});

describe("hello over the socket", () => {
  test("lists the operations the local tier offers, in table order", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    expect(await client.ask({ id: "h", op: "hello" })).toEqual({
      id: "h",
      ok: true,
      api: 1,
      collie: "9.9.9-test",
      experimental: true,
      operations: ["hello", "sessions", "brief", "read", "accounts", "hill.list", "events"],
    });
  });
});
