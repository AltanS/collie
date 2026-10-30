import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asJsonObject, asJsonString, parseJsonObject } from "../../../web/src/lib/json.ts";
import type { JsonObject, JsonValue } from "../../json.ts";
import { defaultHcSocket, HcClient, HcError, HcTimeout, readHcCore, type WireEvent } from "./client.ts";

// A unix-socket stand-in for the core, speaking the two modes HC_API.md records: plain JSON-RPC
// lines, and framed mode after `hello {framed:true}`. Enough of each to prove the client's wire.

type Handler = (socket: Socket, message: JsonObject) => void;

interface Stand {
  readonly path: string;
  readonly framesIn: { channel: number; kind: number; payload: Buffer }[];
  close(): void;
}

let opened: Stand[] = [];

afterEach(() => {
  for (const one of opened) one.close();
  opened = [];
});

function frame(channel: number, kind: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(9);
  header.writeUInt32LE(channel, 0);
  header.writeUInt8(kind, 4);
  header.writeUInt32LE(payload.length, 5);
  return Buffer.concat([header, payload]);
}

function reply(socket: Socket, id: JsonValue | undefined, result: JsonValue): void {
  socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function stand(onPlain: Handler, size = { cols: 70, rows: 30 }): Stand {
  const dir = mkdtempSync(join(tmpdir(), "hc-client-"));
  const path = join(dir, "core.sock");
  const framesIn: { channel: number; kind: number; payload: Buffer }[] = [];
  const server: Server = createServer((socket) => {
    let framed = false;
    let text = "";
    let bin: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (!framed) {
        text += chunk.toString("utf8");
        let nl = text.indexOf("\n");
        while (nl >= 0 && !framed) {
          const message = parseJsonObject(text.slice(0, nl)) ?? {};
          text = text.slice(nl + 1);
          const params = asJsonObject(message.params) ?? {};
          if (message.method === "hello" && params.framed === true) {
            reply(socket, message.id, { generation: 1, version: "0.1.14", framed: true, core: { id: "x", name: "h" } });
            framed = true;
            break;
          }
          onPlain(socket, message);
          nl = text.indexOf("\n");
        }
        return;
      }
      bin = Buffer.concat([bin, chunk]);
      while (bin.length >= 9) {
        const length = bin.readUInt32LE(5);
        if (bin.length < 9 + length) break;
        const got = { channel: bin.readUInt32LE(0), kind: bin.readUInt8(4), payload: bin.subarray(9, 9 + length) };
        bin = bin.subarray(9 + length);
        framesIn.push(got);
        if (got.channel === 0) {
          const message = parseJsonObject(got.payload.toString("utf8")) ?? {};
          if (message.method === "terminal.get") {
            socket.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { address: "t1", state: "live", ...size } }))));
          } else if (message.method === "terminal.attach") {
            socket.write(frame(0, 0, Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { channel: 1, terminal: {} } }))));
            socket.write(frame(1, 0, Buffer.from("\u001b[2Jfirst paint")));
          }
        } else if (got.kind === 2) {
          socket.write(frame(got.channel, 2, Buffer.alloc(0)));
        }
      }
    });
  });
  server.listen(path);
  const made: Stand = {
    path,
    framesIn,
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  opened.push(made);
  return made;
}

describe("HcClient over a unix socket", () => {
  test("a plain call resolves its result, and an error carries the core's kind", async () => {
    const core = stand((socket, message) => {
      if (message.method === "terminal.list") reply(socket, message.id, { terminals: [{ address: "t1", state: "live", labels: { where: "x / 1" } }] });
      else socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "no terminal", data: { kind: "not_found" } } })}\n`);
    });
    const client = new HcClient(core.path, 2000);
    const listed = await client.listTerminals();
    expect(listed.map((t) => [t.address, t.labels.where])).toEqual([["t1", "x / 1"]]);
    let kind = "";
    try {
      await client.getTerminal("t9");
    } catch (err) {
      if (err instanceof HcError) kind = err.kind;
    }
    expect(kind).toBe("not_found");
  });

  test("typing attaches at the terminal's own size, sends the text as one DATA frame, and waits for the core's CLOSE", async () => {
    const core = stand(() => {}, { cols: 70, rows: 30 });
    const client = new HcClient(core.path, 2000);
    await client.typeRaw("t1", "echo \"$HOME\" ä");
    const rpc = core.framesIn.filter((f) => f.channel === 0).map((f) => parseJsonObject(f.payload.toString("utf8")) ?? {});
    expect(rpc.map((m) => asJsonString(m.method))).toEqual(["terminal.get", "terminal.attach"]);
    expect(rpc[1]?.params).toEqual({ terminal: "t1", cols: 70, rows: 30 });
    const onStream = core.framesIn.filter((f) => f.channel === 1);
    expect(onStream.map((f) => f.kind)).toEqual([0, 2]);
    expect(onStream[0]?.payload.toString("utf8")).toBe("echo \"$HOME\" ä");
  });

  test("a stream comes up on the snapshot answer, reports events and `missed`, and drops what `missed` covered", async () => {
    const sockets: Socket[] = [];
    const core = stand((socket, message) => {
      sockets.push(socket);
      reply(socket, message.id, { seq: 3, terminals: [] });
    });
    const client = new HcClient(core.path, 2000, 5000);
    const events: WireEvent[] = [];
    const ups: number[] = [];
    const downs: string[] = [];
    const stream = client.subscribe({ onUp: () => ups.push(1), onEvent: (e) => events.push(e), onDown: (r) => downs.push(r) });
    for (let i = 0; i < 100 && ups.length === 0; i += 1) await Bun.sleep(5);
    expect(ups).toEqual([1]);
    const send = (method: string, params: JsonObject) => sockets[0]?.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    send("event", { seq: 4, type: "status", terminal: "t1", data: {} });
    send("heartbeat", { seq: 4 });
    send("missed", { seq: 9, terminals: [] });
    send("event", { seq: 8, type: "title", terminal: "t1", data: {} });
    send("event", { seq: 10, type: "created", terminal: "t2", data: {} });
    for (let i = 0; i < 100 && events.length < 3; i += 1) await Bun.sleep(5);
    expect(events).toEqual([
      { type: "status", terminal: "t1", seq: 4 },
      { type: "missed", terminal: "", seq: 9 },
      { type: "created", terminal: "t2", seq: 10 },
    ]);
    stream.close();
    stream.close();
    expect(downs).toEqual(["closed"]);
  });

  test("a stream that goes silent past its bound comes down once", async () => {
    const core = stand((socket, message) => reply(socket, message.id, { seq: 0, terminals: [] }));
    const client = new HcClient(core.path, 2000, 60);
    const downs: string[] = [];
    client.subscribe({ onUp: () => {}, onEvent: () => {}, onDown: (r) => downs.push(r) });
    for (let i = 0; i < 100 && downs.length === 0; i += 1) await Bun.sleep(10);
    expect(downs).toEqual(["no heartbeat from herdr-core"]);
  });

  test("a socket with nobody behind it rejects as a transport failure, not a core answer", async () => {
    const client = new HcClient(join(tmpdir(), "no-such-hc-core.sock"), 500);
    let caught = "";
    try {
      await client.hello();
    } catch (err) {
      caught = err instanceof HcError ? "core" : err instanceof Error ? "transport" : "other";
    }
    expect(caught).toBe("transport");
  });
});

describe("the doctor dial (M74 spec 04)", () => {
  test("readHcCore asks hello then server.status and reports version, generation and live count", async () => {
    const seen: string[] = [];
    const core = stand((socket, message) => {
      seen.push(String(message.method));
      if (message.method === "hello") reply(socket, message.id, { generation: 1, version: "0.1.14", core: { id: "x", name: "h" } });
      else reply(socket, message.id, { version: "0.1.14", live: 3, finished: 1 });
    });
    expect(await readHcCore(core.path, 2000)).toEqual({ version: "0.1.14", generation: 1, live: 3 });
    expect(seen).toEqual(["hello", "server.status"]);
  });

  test("a core that never answers is a timeout, not a hang", async () => {
    const core = stand(() => undefined);
    let said = "";
    try {
      await readHcCore(core.path, 100);
    } catch (err) {
      said = err instanceof Error ? err.message : "";
    }
    expect(said).toContain("timed out");
  });

  test("a key call the core never answers is an HcTimeout, which the adapter reads as not confirmed", async () => {
    const core = stand(() => undefined);
    let caught = "";
    try {
      await new HcClient(core.path, 100).pressKeys("t1", ["down"]);
    } catch (err) {
      caught = err instanceof HcTimeout ? err.message : `not an HcTimeout: ${String(err)}`;
    }
    expect(caught).toBe("herdr-core terminal.keys: timed out after 100ms");
  });
});

describe("the default socket", () => {
  const runUserExists = (path: string) => path === "/run/user/1000";
  test.each([
    [{ HC_SOCKET: "/x/y.sock", HC_SESSION: "lab", XDG_RUNTIME_DIR: "/run/user/7" }, "/x/y.sock"],
    [{ HC_SESSION: "lab", XDG_RUNTIME_DIR: "/run/user/7" }, "/run/user/7/herdr-core/lab.sock"],
    [{ XDG_RUNTIME_DIR: "/run/user/7" }, "/run/user/7/herdr-core/default.sock"],
    [{}, "/run/user/1000/herdr-core/default.sock"],
    [{ HERDR_SOCKET_PATH: "/home/u/.config/herdr/herdr.sock" }, "/run/user/1000/herdr-core/default.sock"],
  ])("%j dials %s", (env, path) => {
    expect(defaultHcSocket(env, 1000, runUserExists, "/home/u")).toBe(path);
  });

  test.each([
    [{}, "/Users/u/.local/state/herdr-core/default/default.sock"],
    [{ HC_SESSION: "lab" }, "/Users/u/.local/state/herdr-core/lab/lab.sock"],
    [{ XDG_STATE_HOME: "/s" }, "/s/herdr-core/default/default.sock"],
    [{ XDG_RUNTIME_DIR: "/r" }, "/r/herdr-core/default.sock"],
  ])("with no /run/user/<uid> (macOS), %j dials %s", (env, path) => {
    expect(defaultHcSocket(env, 501, () => false, "/Users/u")).toBe(path);
  });
});
