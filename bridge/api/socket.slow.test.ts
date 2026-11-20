// The slow cases of socket.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "../events/bus.ts";
import type { JsonObject } from "../json.ts";
import { parseJsonObject } from "../../web/src/lib/json.ts";
import { IDLE_MS, REQUEST_LINE_MS, WRITE_STALL_MS } from "./limits.ts";
import { buildTable, LOCAL_TIER_RIGHTS, type OpResult, type ReadHandlers } from "./operations.ts";
import { apiSocketDescribe } from "./skip.ts";
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

// The run tokens of the rigs (spec 05): 43 base64url characters each, as the trick runner mints them. A
// rig's table holds TOKEN (trick `lodge`, level `read`) and SEE_TOKEN (trick `workshop`, level `see`);
// DEAD_TOKEN reads as a token and is in no table. A client opens with `hello` and TOKEN unless told not to.
const TOKEN = "A".repeat(43);

const SEE_TOKEN = "B".repeat(43);

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

apiSocketDescribe("the waits", () => {
  test("an events wait times out with no events and the same cursor", async () => {
    const r = rig();
    await r.api.start();
    const client = await Client.open(r.path);
    const answer = await client.ask({ id: "t", op: "events", args: { after: "boot1.0", wait: 1 } });
    expect(answer).toEqual({ id: "t", ok: true, events: [], next: "boot1.0" });
    expect(r.api.counts().waits).toBe(0);
  });
});

