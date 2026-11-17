import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Trick, type Facts, type Json } from "./trick.ts";

/** One JSON line of the wire, as an object of JSON values. */
type Line = { [key: string]: Json };
/** One answer line the scratch server sends. */
interface Reply {
  id: Json;
  ok: boolean;
  machines?: { id: string; label: string }[];
  error?: { code: string; message: string };
}

// `t.api` (helper v8, M105 specs 04 and 05): the level is checked before any dial, facts with no run token
// dial nothing, a missing socket is a plain answer, one call takes a short time, and a call against a real Unix socket server in a temp folder works.
// The server here is a scratch one of this test; it speaks the local API's wire (one JSON line each way).

const dirs: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) server.close();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-api-"));
  dirs.push(dir);
  return dir;
}

interface Scratch {
  socket: string;
  /** Every line a connection sent, parsed. */
  lines: Line[];
  connections: number;
}

/** A scratch server on a Unix socket. `answer` gets each request and returns the line to send, or null for none. */
async function scratch(answer: (request: Line) => Reply | null): Promise<Scratch> {
  const dir = await tempDir();
  const out: Scratch = { socket: join(dir, "sock"), lines: [], connections: 0 };
  const server = createServer((conn: Socket) => {
    out.connections += 1;
    let held = "";
    conn.setEncoding("utf8");
    conn.on("error", () => {});
    conn.on("data", (chunk: string) => {
      held += chunk;
      for (let end = held.indexOf("\n"); end >= 0; end = held.indexOf("\n")) {
        const line = held.slice(0, end);
        held = held.slice(end + 1);
        const request: Line = JSON.parse(line);
        out.lines.push(request);
        const reply = answer(request);
        if (reply !== null) conn.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(out.socket, resolve));
  return out;
}

/** A scratch server that answers the first bytes of a connection with `payload` as it is, then ends the connection when `end` says so. */
async function hostile(payload: string, end: boolean): Promise<string> {
  const dir = await tempDir();
  const socket = join(dir, "sock");
  const server = createServer((conn: Socket) => {
    conn.on("error", () => {});
    conn.once("data", () => {
      if (end) conn.end(payload);
      else conn.write(payload);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return socket;
}

/** A run token as the bridge puts it in the facts: 43 base64url characters. */
const TOKEN = "Tk".repeat(21) + "x";

async function trickWith(api: Facts["api"]): Promise<Trick> {
  const dir = await tempDir();
  const facts: Facts = {
    contract: 2,
    trigger: { kind: "start" },
    trick: { id: "lodge", dir, state: join(dir, "state") },
    host: "workshop",
    memberId: "m_abcdefghij",
    sessions: [],
    spaces: [],
  };
  if (api !== undefined) facts.api = api;
  return new Trick(facts);
}

describe("t.api", () => {
  test("a trick with no api in its facts gets a plain answer and dials nothing", async () => {
    const t = await trickWith(undefined);
    expect(await t.api("machines")).toEqual({ ok: false, error: { code: "trick.api_off", message: "Collie's local API is off here." } });
  });

  test("an operation above the declared level is refused before any dial", async () => {
    const server = await scratch(() => ({ id: "r", ok: true }));
    const t = await trickWith({ socket: server.socket, access: "see", token: TOKEN });
    const answer = await t.api("read", { session: "lodge:1" });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.code).toBe("trick.api_level");
    expect(server.connections).toBe(0);
    // `read` is allowed at the level `read`, and `machines` at `see`.
    const reader = await trickWith({ socket: server.socket, access: "read", token: TOKEN });
    expect((await reader.api("read", { session: "lodge:1" })).ok).toBe(true);
    expect((await t.api("machines")).ok).toBe(true);
  });

  test("a name the local API does not have is refused before any dial", async () => {
    const server = await scratch(() => ({ id: "r", ok: true }));
    const t = await trickWith({ socket: server.socket, access: "read", token: TOKEN });
    const answer = await t.api("send", { text: "x" });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.code).toBe("trick.api_unknown");
    expect(server.connections).toBe(0);
  });

  test("a socket path with nothing behind it is a plain answer", async () => {
    const dir = await tempDir();
    const t = await trickWith({ socket: join(dir, "gone.sock"), access: "see", token: TOKEN });
    const answer = await t.api("sessions");
    expect(answer).toEqual({ ok: false, error: { code: "trick.api_unreachable", message: "Collie's local API did not answer." } });
  });

  test("facts whose api has no token dial nothing: the local API is off here", async () => {
    const server = await scratch(() => ({ id: "r", ok: true }));
    // A copy of facts from before spec 05, read loosely: no token.
    const t = await trickWith(JSON.parse(JSON.stringify({ socket: server.socket, access: "see" })));
    expect(await t.api("machines")).toEqual({ ok: false, error: { code: "trick.api_off", message: "Collie's local API is off here." } });
    expect(server.connections).toBe(0);
  });

  test("a refused hello is the answer: the bridge's code and message come back", async () => {
    const server = await scratch((request): Reply => ({ id: request.id ?? null, ok: false, error: { code: "api.no_run_token", message: "the local API answers a trick's own run in this release" } }));
    const t = await trickWith({ socket: server.socket, access: "see", token: TOKEN });
    expect(await t.api("machines")).toEqual({ ok: false, error: { code: "api.no_run_token", message: "the local API answers a trick's own run in this release" } });
  });

  test("a call names the run's token in hello, then asks once, and returns the socket's answer", async () => {
    const server = await scratch((request): Reply => {
      const id = request.id ?? null;
      if (request.op === "hello") return { id, ok: true };
      return { id, ok: true, machines: [{ id: "m_one", label: "workshop" }] };
    });
    const t = await trickWith({ socket: server.socket, access: "see", token: TOKEN });
    const answer = await t.api("machines", {});
    expect(answer).toEqual({ ok: true, id: "r", machines: [{ id: "m_one", label: "workshop" }] });
    expect(server.lines).toEqual([
      { id: "h", op: "hello", args: { token: TOKEN } },
      { id: "r", op: "machines", args: {} },
    ]);
  });

  test("the socket's own refusal comes back with its code and message", async () => {
    const server = await scratch((request): Reply => {
      const id = request.id ?? null;
      if (request.op === "hello") return { id, ok: true };
      return { id, ok: false, error: { code: "api.session_unknown", message: "No such session." } };
    });
    const t = await trickWith({ socket: server.socket, access: "read", token: TOKEN });
    expect(await t.api("brief", { session: "lodge:9" })).toEqual({ ok: false, error: { code: "api.session_unknown", message: "No such session." } });
  });

  // Review 3, item 5: a hostile answer is a plain error, never a throw.
  test("an answer too large is a plain error, and the call ends at once", async () => {
    const socket = await hostile("x".repeat(3 * 1024 * 1024), false);
    const t = await trickWith({ socket, access: "see", token: TOKEN });
    const started = performance.now();
    expect(await t.api("sessions")).toEqual({ ok: false, error: { code: "trick.api_failed", message: "Collie's local API sent an answer that is too large." } });
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("an answer that is not JSON, or JSON that is not an object, is a plain error", async () => {
    const socket = await hostile('not json\nnull\n[1,2]\n"r"\n{"id":"r","ok":tru\n', true);
    const t = await trickWith({ socket, access: "see", token: TOKEN });
    expect(await t.api("machines")).toEqual({ ok: false, error: { code: "trick.api_unreachable", message: "Collie's local API closed the connection." } });
  });

  test("a server that never answers ends the call at the limit with a plain answer", async () => {
    const server = await scratch(() => null);
    const t = await trickWith({ socket: server.socket, access: "see", token: TOKEN });
    const before = process.env.TRICK_API_MS;
    process.env.TRICK_API_MS = "150";
    try {
      const started = performance.now();
      const answer = await t.api("sessions");
      const took = performance.now() - started;
      expect(answer.ok).toBe(false);
      if (!answer.ok) expect(answer.error.code).toBe("trick.api_timeout");
      expect(took).toBeGreaterThanOrEqual(140);
      expect(took).toBeLessThan(2000);
    } finally {
      if (before === undefined) delete process.env.TRICK_API_MS;
      else process.env.TRICK_API_MS = before;
    }
  });
});
