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

// `t.api` (helper v7, M105 spec 04): the level is checked before any dial, a missing socket is a plain
// answer, one call takes a short time, and a call against a real Unix socket server in a temp folder works.
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
    const t = await trickWith({ socket: server.socket, access: "see" });
    const answer = await t.api("read", { session: "lodge:1" });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.code).toBe("trick.api_level");
    expect(server.connections).toBe(0);
    // `read` is allowed at the level `read`, and `machines` at `see`.
    const reader = await trickWith({ socket: server.socket, access: "read" });
    expect((await reader.api("read", { session: "lodge:1" })).ok).toBe(true);
    expect((await t.api("machines")).ok).toBe(true);
  });

  test("a name the local API does not have is refused before any dial", async () => {
    const server = await scratch(() => ({ id: "r", ok: true }));
    const t = await trickWith({ socket: server.socket, access: "read" });
    const answer = await t.api("send", { text: "x" });
    expect(answer.ok).toBe(false);
    if (!answer.ok) expect(answer.error.code).toBe("trick.api_unknown");
    expect(server.connections).toBe(0);
  });

  test("a socket path with nothing behind it is a plain answer", async () => {
    const dir = await tempDir();
    const t = await trickWith({ socket: join(dir, "gone.sock"), access: "see" });
    const answer = await t.api("sessions");
    expect(answer).toEqual({ ok: false, error: { code: "trick.api_unreachable", message: "Collie's local API did not answer." } });
  });

  test("a call names the trick in hello, then asks once, and returns the socket's answer", async () => {
    const server = await scratch((request): Reply => {
      const id = request.id ?? null;
      if (request.op === "hello") return { id, ok: true };
      return { id, ok: true, machines: [{ id: "m_one", label: "workshop" }] };
    });
    const t = await trickWith({ socket: server.socket, access: "see" });
    const answer = await t.api("machines", {});
    expect(answer).toEqual({ ok: true, id: "r", machines: [{ id: "m_one", label: "workshop" }] });
    expect(server.lines).toEqual([
      { id: "h", op: "hello", args: { client: "trick:lodge" } },
      { id: "r", op: "machines", args: {} },
    ]);
  });

  test("the socket's own refusal comes back with its code and message", async () => {
    const server = await scratch((request): Reply => {
      const id = request.id ?? null;
      if (request.op === "hello") return { id, ok: true };
      return { id, ok: false, error: { code: "api.session_unknown", message: "No such session." } };
    });
    const t = await trickWith({ socket: server.socket, access: "read" });
    expect(await t.api("brief", { session: "lodge:9" })).toEqual({ ok: false, error: { code: "api.session_unknown", message: "No such session." } });
  });

  test("a server that never answers ends the call at the limit with a plain answer", async () => {
    const server = await scratch(() => null);
    const t = await trickWith({ socket: server.socket, access: "see" });
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
