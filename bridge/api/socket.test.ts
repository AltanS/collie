// The local API socket: its life (decision 14), its framing, its caps (decision 18). Each test makes a
// socket in its own temp folder under the system's temp dir and removes it; no TCP port is opened.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, linkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, lstatSync, existsSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventBus } from "../events/bus.ts";
import { encodeSessionId } from "../events/session-id.ts";
import type { JsonObject } from "../json.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import {
  ANSWER_MAX_BYTES,
  BUSY_RETRY_MS,
  CONNECTIONS_MAX,
  IDLE_MS,
  REQUEST_LINE_MAX,
  REQUEST_LINE_MS,
  REQUESTS_PER_CONNECTION,
  SCREEN_READS_MAX,
  WAITS_PER_CONNECTION,
  WAITS_TOTAL,
  WRITE_BUFFER_MAX,
  WRITE_STALL_MS,
} from "./limits.ts";
import { buildTable, LOCAL_TIER_RIGHTS, type OpResult, type ReadHandlers } from "./operations.ts";
import { apiSocketDescribe, apiSocketTest } from "./skip.ts";
import { ApiSocket, apiSocketPath, type RunTokenHolder } from "./socket.ts";

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

// The run tokens of the rigs (spec 05): 43 base64url characters each, as the trick runner mints them. A
// rig's table holds TOKEN (trick `lodge`, level `read`) and SEE_TOKEN (trick `workshop`, level `see`);
// DEAD_TOKEN reads as a token and is in no table. A client opens with `hello` and TOKEN unless told not to.
const TOKEN = "A".repeat(43);
const SEE_TOKEN = "B".repeat(43);
const DEAD_TOKEN = "C".repeat(43);
const HELLO_ARGS = { token: TOKEN };

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

/** The rig's key of a token: a stand-in for the table's hash, never the token itself. */
function keyOf(token: string): string {
  return `key-of-${token.length}-${token.slice(-4)}`;
}

interface Rig {
  readonly path: string;
  readonly dir: string;
  readonly bus: EventBus;
  readonly api: ApiSocket;
  readonly logs: string[];
  readonly briefGate: Gate;
  /** The rig's run-token table: a test ends a token by deleting it (and, for an ending the table tells, `api.endToken(keyOf(token))`). */
  readonly tokens: Map<string, Omit<RunTokenHolder, "key">>;
}

interface RigOptions {
  readonly platform?: NodeJS.Platform;
  readonly lineMs?: number;
  readonly idleMs?: number;
  readonly sessions?: () => Promise<OpResult>;
  readonly read?: ReadHandlers["read"];
  readonly stallMs?: number;
  readonly uid?: number;
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
    read:
      opts.read ??
      (async () => {
        throw new Error("a stub that fails");
      }),
    accounts: async () => ({ ok: true, answer: { accounts: [] } }),
    "hill.list": async () => ({ ok: true, answer: { decisions: [] } }),
    machines: async () => ({ ok: true, answer: { machines: [] } }),
  };
  const logs: string[] = [];
  const tokens = new Map<string, Omit<RunTokenHolder, "key">>([
    [TOKEN, { trickId: "lodge", level: "read" }],
    [SEE_TOKEN, { trickId: "workshop", level: "see" }],
  ]);
  const api = new ApiSocket({
    socketPath: path,
    table: buildTable({ version: () => "9.9.9-test", bus, reads }),
    granted: LOCAL_TIER_RIGHTS,
    tokens: {
      resolve: (token) => {
        const holder = tokens.get(token);
        return holder === undefined ? null : { ...holder, key: keyOf(token) };
      },
      alive: (key) => [...tokens.keys()].some((token) => keyOf(token) === key),
    },
    log: (line) => logs.push(line),
    platform: opts.platform ?? process.platform,
    lineMs: opts.lineMs ?? REQUEST_LINE_MS,
    idleMs: opts.idleMs ?? IDLE_MS,
    stallMs: opts.stallMs ?? WRITE_STALL_MS,
    uid: opts.uid ?? process.getuid?.() ?? 0,
  });
  sockets.push(api);
  return { path, dir: join(stateDir, "api"), bus, api, logs, briefGate, tokens };
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

  /** Connect, then say `hello` with `token` (default TOKEN) and take its answer; `null` connects with no hello. */
  static async open(path: string, token: string | null = TOKEN): Promise<Client> {
    const socket = createConnection({ path });
    await once(socket, "connect");
    const client = new Client(socket);
    clients.push(client);
    if (token === null) return client;
    const hello = await client.ask({ id: "open", op: "hello", args: { token } });
    if (hello.ok !== true) throw new Error(`hello refused: ${JSON.stringify(hello)}`);
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

  apiSocketTest("started: a socket of mode 0600 in a folder of mode 0700; stopped: gone", async () => {
    const r = rig();
    expect(await r.api.start()).toBe(true);
    expect(lstatSync(r.path).isSocket()).toBe(true);
    expect(modeOf(r.path)).toBe(0o600);
    expect(modeOf(r.dir)).toBe(0o700);
    await r.api.stop();
    expect(existsSync(r.path)).toBe(false);
    expect(r.api.running()).toBe(false);
  });

  apiSocketTest("a folder that was wider is made 0700", async () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true, mode: 0o755 });
    expect(await r.api.start()).toBe(true);
    expect(modeOf(r.dir)).toBe(0o700);
  });

  apiSocketTest("the count drives it as bridge/index.ts wires it: above zero on, zero off", async () => {
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

  apiSocketTest("start and stop are idempotent", async () => {
    const r = rig();
    expect(await r.api.start()).toBe(true);
    const ino = lstatSync(r.path).ino;
    expect(await r.api.start()).toBe(true);
    expect(lstatSync(r.path).ino).toBe(ino);
    await r.api.stop();
    await r.api.stop();
    expect(existsSync(r.path)).toBe(false);
  });

  apiSocketTest("on, off, on at once: one server, on its own socket file, answering", async () => {
    const r = rig();
    const a = r.api.start();
    const b = r.api.stop();
    const c = r.api.start();
    expect([await a, await c]).toEqual([true, true]);
    await b;
    expect(r.api.running()).toBe(true);
    expect(lstatSync(r.path).isSocket()).toBe(true);
    const client = await Client.open(r.path);
    expect(await client.ask({ id: "h", op: "hello", args: HELLO_ARGS })).toMatchObject({ id: "h", ok: true });
    // And off, on, off at once ends with no socket.
    const d = r.api.stop();
    const e = r.api.start();
    const f = r.api.stop();
    await Promise.all([d, e, f]);
    expect(r.api.running()).toBe(false);
    expect(existsSync(r.path)).toBe(false);
  });

  apiSocketTest("a dead socket file left behind is replaced", async () => {
    const r = rig();
    mkdirSync(r.dir, { recursive: true, mode: 0o700 });
    // A socket file nobody listens on: bind one elsewhere, move the file to the path, close the server.
    const aside = join(r.dir, "aside");
    const stale = createServer();
    await new Promise<void>((resolve) => stale.listen(aside, resolve));
    renameSync(aside, r.path);
    await new Promise<void>((resolve) => stale.close(() => resolve()));
    expect(lstatSync(r.path).isSocket()).toBe(true);
    // Pin the old file by a second name. A freed inode number can be handed to the next file at once
    // (CI did, 2026-11-17), so comparing numbers proves nothing; a pinned inode cannot be reused.
    const pinned = join(r.dir, "pinned");
    linkSync(r.path, pinned);
    const before = lstatSync(pinned).ino;
    expect(lstatSync(r.path).ino).toBe(before);
    expect(await r.api.start()).toBe(true);
    expect(lstatSync(pinned).ino).toBe(before);
    expect(lstatSync(r.path).ino).not.toBe(before);
    const client = await Client.open(r.path);
    expect(await client.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
  });

  apiSocketTest("a socket another process answers on is left alone, and no server starts", async () => {
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

  apiSocketTest("a file at the path that is not a socket is refused and left as it is", async () => {
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

  apiSocketTest("stop removes the socket file at once, before the next start runs", async () => {
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
    expect(await fresh.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
  });
});

apiSocketDescribe("the framing", () => {
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
    client.sendRaw(`"op":"hello","args":${JSON.stringify(HELLO_ARGS)}}\n`);
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
    client.sendRaw(`${JSON.stringify({ id: "i".repeat(65), op: "hello", args: HELLO_ARGS })}\n`);
    expect(await client.next()).toEqual({ ok: false, error: expect.objectContaining({ code: "api.bad_request" }) });
    client.sendRaw(`${JSON.stringify({ id: 7, op: "hello", args: HELLO_ARGS })}\n`);
    expect("id" in (await client.next())).toBe(false);
    expect(await client.ask({ id: "after", op: "hello", args: HELLO_ARGS })).toMatchObject({ id: "after", ok: true });
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

  test("the trick named by the token goes on the connection's later log lines", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    await client.ask({ op: "read", args: { session: SESSION } });
    expect(r.logs.some((line) => line.includes("read failed (trick:lodge): a stub that fails"))).toBe(true);
    expect(r.logs.join("\n")).not.toContain(TOKEN);
  });

  describe("the log line of a read", () => {
    const SCREEN_TEXT = "please deploy the vault";
    const readLines = (r: Rig): string[] => r.logs.filter((line) => line.startsWith("[api] read by="));

    test("a read that succeeds logs one line: the trick of the token, the session id and ok, and none of the screen", async () => {
      const r = rig({ read: async () => ({ ok: true, answer: { session: SESSION, text: SCREEN_TEXT, lines: 10, truncated: false } }) });
      await r.api.start();
      const client = await Client.open(r.path);
      expect(await client.ask({ op: "read", args: { session: SESSION } })).toMatchObject({ ok: true });
      expect(readLines(r)).toEqual([`[api] read by=trick:lodge session=${SESSION} result=ok`]);
      expect(r.logs.join("\n")).not.toContain(SCREEN_TEXT);
      expect(r.logs.join("\n")).not.toContain(TOKEN);
    });

    test("50 reads before any hello are refused, close their connections, and write no read line", async () => {
      const r = rig({ read: async () => ({ ok: true, answer: { session: SESSION, text: SCREEN_TEXT, lines: 10, truncated: false } }) });
      await r.api.start();
      for (let i = 0; i < 50; i += 1) {
        const client = await Client.open(r.path, null);
        expect(codeOf(await client.ask({ op: "read", args: { session: SESSION, lines: 5 } }))).toBe("api.no_run_token");
        await client.ended;
      }
      expect(readLines(r)).toEqual([]);
      expect(r.logs.some((line) => line.startsWith("[api] read"))).toBe(false);
      // A read after a good hello still leaves its line.
      const named = await Client.open(r.path);
      expect(await named.ask({ op: "read", args: { session: SESSION } })).toMatchObject({ ok: true });
      expect(readLines(r)).toEqual([`[api] read by=trick:lodge session=${SESSION} result=ok`]);
    });

    test("a refused read logs the error code", async () => {
      const r = rig({ read: async () => ({ ok: false, code: "api.session_unknown" }) });
      await r.api.start();
      const client = await Client.open(r.path);
      await client.ask({ op: "read", args: { session: SESSION } });
      expect(readLines(r)).toEqual([`[api] read by=trick:lodge session=${SESSION} result=api.session_unknown`]);
    });

    test("a read the table refuses for its arguments logs bad_request, and a session that is no id's shape is `invalid`", async () => {
      const r = rig();
      await r.api.start();
      const client = await Client.open(r.path);
      await client.ask({ op: "read", args: { session: "ses_x\n[api] forged line", lines: 0 } });
      await client.ask({ op: "read", args: { session: 7 } });
      await client.ask({ op: "read", args: "text" });
      expect(readLines(r)).toEqual([
        "[api] read by=trick:lodge session=invalid result=api.bad_request",
        "[api] read by=trick:lodge session=invalid result=api.bad_request",
        "[api] read by=trick:lodge session=invalid result=api.bad_request",
      ]);
      expect(r.logs.some((line) => line.startsWith("[api] forged"))).toBe(false);
    });

    test("only a read logs: the other operations leave no such line", async () => {
      const r = rig();
      await r.api.start();
      const client = await Client.open(r.path);
      await client.ask({ op: "sessions" });
      await client.ask({ op: "accounts" });
      await client.ask({ op: "hello", args: HELLO_ARGS });
      expect(readLines(r)).toEqual([]);
    });
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
    const request = JSON.stringify({ op: "hello", id: "c", args: HELLO_ARGS });
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
    expect(await idle.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
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
    expect(await held[0]!.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
    const extra = await Client.open(r.path, null);
    expect(await extra.next()).toMatchObject({ ok: false, error: { code: "api.too_many_connections" } });
    await extra.ended;
    held[1]!.close();
    await Bun.sleep(30);
    const again = await Client.open(r.path);
    expect(await again.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
  });
});

apiSocketDescribe("the waits", () => {
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

apiSocketDescribe("requests in flight and idle connections", () => {
  test("the ninth request in flight on one connection, waits included, is refused at once; answers free the places", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    for (let i = 0; i < WAITS_PER_CONNECTION; i += 1) client.send({ id: `w${String(i)}`, op: "events", args: { wait: 25 } });
    for (let i = WAITS_PER_CONNECTION; i < REQUESTS_PER_CONNECTION; i += 1) client.send({ id: `b${String(i)}`, op: "brief", args: { session: SESSION } });
    expect(await client.ask({ id: "ninth", op: "hello", args: HELLO_ARGS })).toEqual({
      id: "ninth",
      ok: false,
      error: { code: "api.too_many_requests", message: "too many requests are in flight on this connection (at most 8); wait for an answer before you send more" },
    });
    // Another connection is not counted against this one.
    const other = await Client.open(r.path);
    expect(await other.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
    r.briefGate.open();
    const answered = [];
    for (let i = WAITS_PER_CONNECTION; i < REQUESTS_PER_CONNECTION; i += 1) answered.push((await client.next()).id);
    expect(answered.toSorted()).toEqual(["b4", "b5", "b6", "b7"]);
    expect(await client.ask({ id: "after", op: "hello", args: HELLO_ARGS })).toMatchObject({ id: "after", ok: true });
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
    typing.sendRaw(`"op":"hello","args":${JSON.stringify(HELLO_ARGS)}}\n`);
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
      expect(await client.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
    }
    expect(client.socket.destroyed).toBe(false);
  });
});

apiSocketDescribe("the api folder is the user's own (security read 1, item 6)", () => {
  test("a symlinked api folder is refused, and nothing is made through it", async () => {
    const r = rig();
    const elsewhere = join(r.dir, "..", "..", "elsewhere");
    mkdirSync(elsewhere, { recursive: true, mode: 0o755 });
    mkdirSync(join(r.dir, ".."), { recursive: true });
    symlinkSync(elsewhere, r.dir);
    expect(await r.api.start()).toBe(false);
    expect(r.api.running()).toBe(false);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(modeOf(elsewhere)).toBe(0o755);
    expect(lstatSync(r.dir).isSymbolicLink()).toBe(true);
    expect(r.logs.some((line) => line.includes("is a symbolic link"))).toBe(true);
  });

  test("a file where the folder should be is refused", async () => {
    const r = rig();
    mkdirSync(join(r.dir, ".."), { recursive: true });
    writeFileSync(r.dir, "not a folder");
    expect(await r.api.start()).toBe(false);
    expect(readFileSync(r.dir, "utf8")).toBe("not a folder");
    expect(r.logs.some((line) => line.includes("is not a folder"))).toBe(true);
  });

  test("a folder another uid owns is refused, its mode left alone", async () => {
    const r = rig({ uid: (process.getuid?.() ?? 0) + 1 });
    mkdirSync(r.dir, { recursive: true, mode: 0o755 });
    expect(await r.api.start()).toBe(false);
    expect(existsSync(r.path)).toBe(false);
    expect(modeOf(r.dir)).toBe(0o755);
    expect(r.logs.some((line) => line.includes("not owned by this user"))).toBe(true);
  });

  test("an absent folder is made with mode 0700", async () => {
    const r = rig();
    expect(existsSync(r.dir)).toBe(false);
    expect(await r.api.start()).toBe(true);
    expect(lstatSync(r.dir).isDirectory()).toBe(true);
    expect(modeOf(r.dir)).toBe(0o700);
  });
});

/** A `read` stub whose answer is about `kib` KiB of text; counts its calls. */
function bigRead(kib: number, calls: { n: number }): ReadHandlers["read"] {
  const text = "x".repeat(kib * 1024);
  return async (args) => {
    calls.n += 1;
    return { ok: true, answer: { session: args.session, text, lines: 1, truncated: false } };
  };
}

apiSocketDescribe("the write budget (security read 1, item 1)", () => {
  test("1,000 reads never read: the bytes held stay bounded, the connection is dropped, another connection is served", async () => {
    const calls = { n: 0 };
    const r = rig({ read: bigRead(900, calls), stallMs: 600 });
    await r.api.start();
    const greedy = await Client.open(r.path);
    // The caller never reads: its socket takes nothing in.
    greedy.socket.pause();
    const line = `${JSON.stringify({ op: "read", args: { session: SESSION } })}\n`;
    greedy.sendRaw(line.repeat(1000));
    const bound = WRITE_BUFFER_MAX + REQUESTS_PER_CONNECTION * ANSWER_MAX_BYTES;
    let most = 0;
    const until = Date.now() + 3000;
    while (Date.now() < until && r.api.counts().connections > 0) {
      most = Math.max(most, r.api.bufferedMax());
      await Bun.sleep(20);
    }
    // Above the budget, then held there: no new request was taken.
    expect(most).toBeGreaterThan(WRITE_BUFFER_MAX);
    expect(most).toBeLessThanOrEqual(bound);
    expect(calls.n).toBeLessThanOrEqual(REQUESTS_PER_CONNECTION);
    // Above the budget for the stall time: dropped.
    expect(r.api.counts().connections).toBe(0);
    expect(r.logs.some((one) => one.includes("did not read its answers"))).toBe(true);
    // The bridge still answers another connection.
    const other = await Client.open(r.path);
    expect(await other.ask({ op: "hello", args: HELLO_ARGS })).toMatchObject({ ok: true });
  });

  test("the other connection is answered while a greedy one is paused", async () => {
    const r = rig({ read: bigRead(900, { n: 0 }), stallMs: 60_000 });
    await r.api.start();
    const greedy = await Client.open(r.path);
    greedy.socket.pause();
    greedy.sendRaw(`${JSON.stringify({ op: "read", args: { session: SESSION } })}\n`.repeat(1000));
    for (let i = 0; i < 100 && r.api.bufferedMax() <= WRITE_BUFFER_MAX; i += 1) await Bun.sleep(10);
    expect(r.api.bufferedMax()).toBeGreaterThan(WRITE_BUFFER_MAX);
    const other = await Client.open(r.path);
    expect(await other.ask({ op: "sessions" })).toMatchObject({ ok: true });
  });

  test("a caller that reads late is served in full: the lines sent while paused wait, then each gets its answer", async () => {
    const sessions = { n: 0 };
    const r = rig({
      read: bigRead(900, { n: 0 }),
      stallMs: 60_000,
      sessions: async () => {
        sessions.n += 1;
        return { ok: true, answer: { sessions: [] } };
      },
    });
    await r.api.start();
    const late = await Client.open(r.path);
    late.socket.pause();
    let text = "";
    for (let i = 0; i < SCREEN_READS_MAX; i += 1) text += `${JSON.stringify({ id: `r${String(i)}`, op: "read", args: { session: SESSION } })}\n`;
    late.sendRaw(text);
    for (let i = 0; i < 100 && r.api.bufferedMax() <= WRITE_BUFFER_MAX; i += 1) await Bun.sleep(10);
    expect(r.api.bufferedMax()).toBeGreaterThan(WRITE_BUFFER_MAX);
    // Sent while the bridge does not read: not one is taken.
    for (let i = 0; i < 6; i += 1) late.send({ id: `s${String(i)}`, op: "sessions" });
    await Bun.sleep(100);
    expect(sessions.n).toBe(0);
    late.socket.resume();
    const ids = new Set<string>();
    for (let i = 0; i < SCREEN_READS_MAX + 6; i += 1) ids.add(asJsonString((await late.next(5000)).id) ?? "");
    expect(ids.size).toBe(SCREEN_READS_MAX + 6);
    expect(sessions.n).toBe(6);
  });
});

apiSocketDescribe("the screen reads of the whole socket (security read 1, item 5)", () => {
  test("at most 4 reads in progress across connections; one more answers api.busy with a retry hint", async () => {
    const held = gate();
    let running = 0;
    let most = 0;
    const r = rig({
      read: async (args) => {
        running += 1;
        most = Math.max(most, running);
        await held.wait;
        running -= 1;
        return { ok: true, answer: { session: args.session, text: "", lines: 1, truncated: false } };
      },
    });
    await r.api.start();
    const a = await Client.open(r.path);
    const b = await Client.open(r.path);
    for (let i = 0; i < 2; i += 1) a.send({ id: `a${String(i)}`, op: "read", args: { session: SESSION } });
    for (let i = 0; i < 2; i += 1) b.send({ id: `b${String(i)}`, op: "read", args: { session: SESSION } });
    for (let i = 0; i < 50; i += 1) {
      if (running >= SCREEN_READS_MAX) break;
      await Bun.sleep(5);
    }
    expect(running).toBe(SCREEN_READS_MAX);
    const c = await Client.open(r.path);
    const busy = await c.ask({ id: "c", op: "read", args: { session: SESSION } });
    expect(codeOf(busy)).toBe("api.busy");
    expect(messageOf(busy)).toContain(String(BUSY_RETRY_MS));
    // Other operations are not held by the cap.
    expect(await c.ask({ op: "sessions" })).toMatchObject({ ok: true });
    held.open();
    for (let i = 0; i < 2; i += 1) expect(await a.next()).toMatchObject({ ok: true });
    for (let i = 0; i < 2; i += 1) expect(await b.next()).toMatchObject({ ok: true });
    expect(most).toBe(SCREEN_READS_MAX);
    // The places are given back.
    expect(await c.ask({ id: "c2", op: "read", args: { session: SESSION } })).toMatchObject({ id: "c2", ok: true });
  });

  test("a read that fails gives its place back", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    for (let i = 0; i < SCREEN_READS_MAX + 2; i += 1) expect(codeOf(await client.ask({ op: "read", args: { session: SESSION } }))).toBe("api.failed");
  });
});

apiSocketDescribe("hello over the socket", () => {
  test("lists the operations the local tier offers, in table order", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    expect(await client.ask({ id: "h", op: "hello", args: HELLO_ARGS })).toEqual({
      id: "h",
      ok: true,
      api: 1,
      collie: "9.9.9-test",
      experimental: true,
      operations: ["hello", "sessions", "brief", "read", "accounts", "hill.list", "machines", "events"],
    });
  });
});

// THE RUN TOKEN (M105 spec 05, decisions 1 to 5): only a connection whose `hello` names a live token is
// answered, at the token's level; everything else gets one error and is closed.
apiSocketDescribe("the run token", () => {
  test("a request before hello gets one no_run_token line and the connection closes; nothing ran", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path, null);
    const answer = await client.ask({ id: "s", op: "sessions" });
    expect(answer).toEqual({ id: "s", ok: false, error: { code: "api.no_run_token", message: "the local API answers a trick's own run in this release; send hello first, with the run token from the trick's facts" } });
    await client.ended;
    expect(r.api.counts().connections).toBe(0);
  });

  test("a hello with no token, an unknown token or one of another shape is refused and closed", async () => {
    const r = rig();
    await r.api.start();
    for (const args of [undefined, {}, { token: DEAD_TOKEN }, { token: "x" }, { token: 7 }, { token: TOKEN.toLowerCase() }]) {
      const client = await Client.open(r.path, null);
      expect(codeOf(await client.ask(args === undefined ? { op: "hello" } : { op: "hello", args }))).toBe("api.no_run_token");
      await client.ended;
    }
  });

  test("a line that is no request before hello is a bad request, and the connection closes", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path, null);
    client.sendRaw("{not json\n");
    expect(codeOf(await client.next())).toBe("api.bad_request");
    await client.ended;
  });

  test("helper v7's hello (a client name, no token) hears no_run_token, not a bad request", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path, null);
    // The v7 helper writes hello and its call in one go, as here.
    client.sendRaw(`${JSON.stringify({ id: "h", op: "hello", args: { client: "trick:lodge" } })}\n${JSON.stringify({ id: "r", op: "sessions" })}\n`);
    expect(await client.next()).toMatchObject({ id: "h", ok: false, error: { code: "api.no_run_token" } });
    await client.ended;
  });

  test("a good token with an argument hello does not take is a bad request, and binds nothing", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path, null);
    expect(codeOf(await client.ask({ op: "hello", args: { token: TOKEN, client: "trick:lodge" } }))).toBe("api.bad_request");
    await client.ended;
  });

  test("hello and a call in one write: the call is answered at the token's level", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path, null);
    client.sendRaw(`${JSON.stringify({ id: "h", op: "hello", args: HELLO_ARGS })}\n${JSON.stringify({ id: "s", op: "sessions" })}\n`);
    const answers = [await client.next(), await client.next()];
    expect(answers).toContainEqual({ id: "s", ok: true, sessions: [] });
    expect(answers).toContainEqual(expect.objectContaining({ id: "h", ok: true }));
  });

  test("a `see` token is refused `read` with the existing refusal, and hello offers it no read", async () => {
    const r = rig({ read: async () => ({ ok: true, answer: { session: SESSION, text: "screen", lines: 1, truncated: false } }) });
    await r.api.start();
    const client = await Client.open(r.path, null);
    const hello = await client.ask({ op: "hello", args: { token: SEE_TOKEN } });
    expect(hello).toMatchObject({ ok: true, operations: ["hello", "sessions", "brief", "accounts", "hill.list", "machines", "events"] });
    expect(await client.ask({ id: "r", op: "read", args: { session: SESSION } })).toEqual({ id: "r", ok: false, error: { code: "api.denied", message: "the local API does not grant the right this operation needs; send hello to see the operations it offers" } });
    // The refusal leaves the connection usable: a `see` operation still answers.
    expect(await client.ask({ op: "accounts" })).toEqual({ ok: true, accounts: [] });
    expect(r.logs.filter((line) => line.startsWith("[api] read by="))).toEqual([`[api] read by=trick:workshop session=${SESSION} result=api.denied`]);
  });

  test("a token that dies (its run ended) answers no more: the next request is refused and the connection closes", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    expect(await client.ask({ op: "accounts" })).toMatchObject({ ok: true });
    r.tokens.delete(TOKEN);
    expect(codeOf(await client.ask({ op: "accounts" }))).toBe("api.no_run_token");
    await client.ended;
    // And a new connection with the dead token is refused at its hello.
    const again = await Client.open(r.path, null);
    expect(codeOf(await again.ask({ op: "hello", args: HELLO_ARGS }))).toBe("api.no_run_token");
  });

  test("a token that dies while an operation runs gets no answer of substance", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    client.send({ id: "slow", op: "brief", args: { session: SESSION } });
    await Bun.sleep(20);
    r.tokens.delete(TOKEN);
    r.briefGate.open();
    expect(await client.next()).toEqual({ id: "slow", ok: false, error: expect.objectContaining({ code: "api.no_run_token" }) });
    await client.ended;
  });

  test("a token that dies ends its open events wait at once: no_run_token, the close, and the slot back", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    const other = await Client.open(r.path, SEE_TOKEN);
    client.send({ id: "wait", op: "events", args: { wait: 25 } });
    other.send({ id: "stays", op: "events", args: { wait: 25 } });
    await Bun.sleep(30);
    expect(r.api.counts().waits).toBe(2);
    const started = Date.now();
    // The table drops the token and tells the socket its key (bridge/index.ts wires `endToken`).
    r.tokens.delete(TOKEN);
    r.api.endToken(keyOf(TOKEN));
    expect(await client.next()).toEqual({ id: "wait", ok: false, error: expect.objectContaining({ code: "api.no_run_token" }) });
    await client.ended;
    expect(Date.now() - started).toBeLessThan(1000);
    await Bun.sleep(10);
    // The other run's wait and connection stay.
    expect(r.api.counts()).toEqual({ connections: 1, waits: 1 });
    expect(r.bus.listeners().waits).toBe(1);
    r.tokens.delete(SEE_TOKEN);
    r.api.endToken(keyOf(SEE_TOKEN));
    expect(codeOf(await other.next())).toBe("api.no_run_token");
    await other.ended;
    await Bun.sleep(10);
    expect(r.api.counts()).toEqual({ connections: 0, waits: 0 });
    expect(r.bus.listeners().waits).toBe(0);
  });

  test("after hello the connection asks by the token's key only: the raw token is never asked again", async () => {
    const asked: string[] = [];
    const aliveAsked: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "collie-api-"));
    roots.push(root);
    const path = apiSocketPath(join(root, "state"));
    const bus = new EventBus({ machine: () => "inst-test-a1", bootId: "boot1" });
    const api = new ApiSocket({
      socketPath: path,
      table: buildTable({ version: () => "9.9.9-test", bus, reads: { accounts: async () => ({ ok: true, answer: { accounts: [] } }) } }),
      granted: LOCAL_TIER_RIGHTS,
      tokens: {
        resolve: (token) => {
          asked.push(token);
          return token === TOKEN ? { trickId: "lodge", level: "read", key: keyOf(TOKEN) } : null;
        },
        alive: (key) => {
          aliveAsked.push(key);
          return key === keyOf(TOKEN);
        },
      },
      log: () => undefined,
      platform: process.platform,
      uid: process.getuid?.() ?? 0,
    });
    sockets.push(api);
    await api.start();
    const client = await Client.open(path);
    expect(await client.ask({ op: "accounts" })).toMatchObject({ ok: true });
    expect(await client.ask({ op: "accounts" })).toMatchObject({ ok: true });
    expect(asked).toEqual([TOKEN]);
    expect(aliveAsked.length).toBeGreaterThanOrEqual(4);
    expect(aliveAsked.every((key) => key === keyOf(TOKEN))).toBe(true);
  });

  test("two runs, two tokens, two connections: each is its own trick, at its own level", async () => {
    const r = rig({ read: async () => ({ ok: true, answer: { session: SESSION, text: "screen", lines: 1, truncated: false } }) });
    await r.api.start();
    const lodge = await Client.open(r.path, TOKEN);
    const workshop = await Client.open(r.path, SEE_TOKEN);
    expect(await lodge.ask({ id: "1", op: "read", args: { session: SESSION } })).toMatchObject({ id: "1", ok: true });
    expect(codeOf(await workshop.ask({ id: "2", op: "read", args: { session: SESSION } }))).toBe("api.denied");
    expect(r.logs.filter((line) => line.startsWith("[api] read by="))).toEqual([
      `[api] read by=trick:lodge session=${SESSION} result=ok`,
      `[api] read by=trick:workshop session=${SESSION} result=api.denied`,
    ]);
    // One run ending leaves the other's connection answered.
    r.tokens.delete(SEE_TOKEN);
    expect(codeOf(await workshop.ask({ op: "accounts" }))).toBe("api.no_run_token");
    expect(await lodge.ask({ op: "accounts" })).toMatchObject({ ok: true });
  });

  test("a token of trick A never reads as trick B: a connection holds one token, a second hello with another is refused and closed", async () => {
    const r = rig({ read: async () => ({ ok: true, answer: { session: SESSION, text: "screen", lines: 1, truncated: false } }) });
    await r.api.start();
    const client = await Client.open(r.path, SEE_TOKEN);
    // The same token again is a hello like the first.
    expect(await client.ask({ op: "hello", args: { token: SEE_TOKEN } })).toMatchObject({ ok: true });
    const swapped = await client.ask({ op: "hello", args: HELLO_ARGS });
    expect(swapped).toMatchObject({ ok: false, error: { code: "api.bad_request" } });
    expect(messageOf(swapped)).toContain("a connection holds one run token");
    await client.ended;
    expect(r.logs.some((line) => line.includes("trick:lodge"))).toBe(false);
  });

  test("the token is in no answer and no log line", async () => {
    const r = rig({ read: async () => ({ ok: true, answer: { session: SESSION, text: "screen", lines: 1, truncated: false } }) });
    await r.api.start();
    const seen: JsonObject[] = [];
    const client = await Client.open(r.path, null);
    seen.push(await client.ask({ id: "h", op: "hello", args: HELLO_ARGS }));
    for (const op of ["sessions", "accounts", "hill.list", "machines"]) seen.push(await client.ask({ op }));
    seen.push(await client.ask({ op: "read", args: { session: SESSION } }));
    seen.push(await client.ask({ op: "events" }));
    seen.push(await client.ask({ op: "hello", args: { token: TOKEN, extra: 1 } }));
    const refused = await Client.open(r.path, null);
    seen.push(await refused.ask({ op: "hello", args: { token: DEAD_TOKEN } }));
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    expect(JSON.stringify(seen)).not.toContain(DEAD_TOKEN);
    expect(r.logs.join("\n")).not.toContain(TOKEN);
    expect(r.logs.join("\n")).not.toContain(DEAD_TOKEN);
  });

  test("a caller with no good hello within the line limit of its connect gets one no_run_token line and is closed", async () => {
    const r = rig({ lineMs: 150, idleMs: IDLE_MS });
    await r.api.start();
    const silent = await Client.open(r.path, null);
    const started = performance.now();
    expect(codeOf(await silent.next(1000))).toBe("api.no_run_token");
    await silent.ended;
    expect(performance.now() - started).toBeLessThan(900);
    // A good hello in time stops the deadline: the connection is still answered after it.
    const named = await Client.open(r.path);
    await Bun.sleep(300);
    expect(await named.ask({ op: "accounts" })).toEqual({ ok: true, accounts: [] });
    expect(r.api.counts().connections).toBe(1);
  });

  test("a silent caller and a slow partial line before hello are both closed within the line limit", async () => {
    const r = rig({ idleMs: IDLE_MS, lineMs: 100 });
    await r.api.start();
    const silent = await Client.open(r.path, null);
    const slow = await Client.open(r.path, null);
    slow.sendRaw('{"op":"hello",');
    await silent.ended;
    // The hello deadline and the line clock both run 100 ms here: whichever fires first sends its one line.
    expect(["api.no_run_token", "api.bad_request"]).toContain(codeOf(await slow.next()) ?? "");
    await slow.ended;
    expect(r.api.counts().connections).toBe(0);
  });
});
