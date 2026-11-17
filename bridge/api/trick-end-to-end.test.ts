// M105 specs 04 and 05, end to end: a trick's helper (`t.api`, helper v8) against the REAL local socket, the
// real operation table, the real reads over the fixture world and the trick runner's REAL run-token table.
// The level a trick declares decides what the helper sends: `see` gets `machines` and is refused `read`
// before any dial; `read` gets the screen. A run whose token died, or facts with no token, read nothing.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { join } from "node:path";

import { Trick, type ApiAnswer, type Facts } from "../../cli/trick-kit/trick.ts";
import { asJsonObject, asJsonString, parseJsonObject } from "../../web/src/lib/json.ts";
import { depsOf, keyOf, world } from "./fixtures/reads-world.ts";
import { buildTable, LOCAL_TIER_RIGHTS } from "./operations.ts";
import { buildReads } from "./reads.ts";
import { ApiSocket, apiSocketPath } from "./socket.ts";
import { RunTokens } from "../tricks/run-tokens.ts";

const dirs: string[] = [];
const sockets: ApiSocket[] = [];
afterAll(async () => {
  for (const api of sockets) await api.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function standing(): Promise<{ path: string; logs: string[]; w: ReturnType<typeof world>; tokens: RunTokens; api: ApiSocket }> {
  const stateDir = mkdtempSync(join(tmpdir(), "collie-api-e2e-"));
  dirs.push(stateDir);
  const w = world();
  w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: "the lodge build is green\n", truncated: false });
  const logs: string[] = [];
  // The table tells the socket every death, as bridge/index.ts wires it (`runTokenEnded` to `endToken`).
  const tokens = new RunTokens((key) => api.endToken(key));
  const path = apiSocketPath(stateDir);
  const api = new ApiSocket({
    socketPath: path,
    table: buildTable({ version: () => "9.9.9-test", bus: w.bus, reads: buildReads(depsOf(w)) }),
    granted: LOCAL_TIER_RIGHTS,
    tokens,
    log: (line) => logs.push(line),
    platform: process.platform,
  });
  sockets.push(api);
  expect(await api.start()).toBe(true);
  return { path, logs, w, tokens, api };
}

/** The ids of the sessions a `sessions` answer lists, read off its JSON with no assertion. */
function sessionIds(answer: ApiAnswer): string[] {
  if (!answer.ok) return [];
  const list = answer.sessions;
  if (!Array.isArray(list)) return [];
  return list.flatMap((row) => {
    const id = asJsonString(asJsonObject(row)?.id);
    return id === undefined ? [] : [id];
  });
}

function trick(socket: string, access: "see" | "read", token: string): Trick {
  const dir = mkdtempSync(join(tmpdir(), "collie-trick-e2e-"));
  dirs.push(dir);
  const facts: Facts = {
    contract: 2,
    trigger: { kind: "start" },
    trick: { id: "lodge", dir, state: join(dir, "state") },
    host: "workshop",
    memberId: "m_abcdefghij",
    sessions: [],
    spaces: [],
    api: { socket, access, token },
  };
  return new Trick(facts);
}

describe.skipIf(process.platform === "win32")("a trick reads through the local API, end to end", () => {
  test("a `see` trick lists machines and sessions and is refused `read` before the dial; its token is in no log line", async () => {
    const { path, logs, tokens } = await standing();
    const token = tokens.mint("lodge", "see", "run-1");
    const t = trick(path, "see", token);
    const machines = await t.api("machines");
    expect(machines.ok).toBe(true);
    expect(machines.ok && Array.isArray(machines.machines)).toBe(true);
    const ids = sessionIds(await t.api("sessions"));
    expect(ids.length).toBeGreaterThan(0);
    const refused = await t.api("read", { session: ids[0] ?? "" });
    expect(refused).toMatchObject({ ok: false, error: { code: "trick.api_level" } });
    expect(logs.join("\n")).not.toContain(token);
  });

  test("the bridge holds the level too: a `see` token is refused `read` even when the facts claim `read`", async () => {
    const { path, tokens } = await standing();
    const t = trick(path, "read", tokens.mint("lodge", "see", "run-1"));
    const first = sessionIds(await t.api("sessions"))[0];
    expect(await t.api("read", { session: first ?? "" })).toMatchObject({ ok: false, error: { code: "api.denied" } });
  });

  test("a run whose token died reads nothing: the helper reports the bridge's refusal", async () => {
    const { path, tokens } = await standing();
    const t = trick(path, "see", tokens.mint("lodge", "see", "run-1"));
    expect((await t.api("machines")).ok).toBe(true);
    tokens.end("run-1");
    expect(await t.api("machines")).toMatchObject({ ok: false, error: { code: "api.no_run_token" } });
  });

  test("a `read` trick reads a session's screen", async () => {
    const { path, tokens, logs } = await standing();
    const t = trick(path, "read", tokens.mint("lodge", "read", "run-2"));
    const first = sessionIds(await t.api("sessions"))[0];
    expect(first).toBeDefined();
    const read = await t.api("read", { session: first ?? "" });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).toContain("the lodge build is green");
    // The log names the trick the token belongs to (spec 05, decision 5).
    expect(logs.filter((line) => line.startsWith("[api] read by="))).toEqual([`[api] read by=trick:lodge session=${first ?? ""} result=ok`]);
  });

  test("an events wait open when its run ends answers no_run_token at once, closes, and gives its slot back", async () => {
    const { path, tokens, api } = await standing();
    const token = tokens.mint("lodge", "see", "run-3");
    const socket = createConnection({ path });
    socket.setEncoding("utf8");
    let text = "";
    socket.on("data", (chunk: string) => {
      text += chunk;
    });
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.write(`${JSON.stringify({ id: "hi", op: "hello", args: { token } })}\n`);
    socket.write(`${JSON.stringify({ id: "wait", op: "events", args: { wait: 25 } })}\n`);
    for (let tries = 0; tries < 100 && api.counts().waits === 0; tries += 1) await Bun.sleep(10);
    expect(api.counts().waits).toBe(1);
    const started = Date.now();
    tokens.end("run-3");
    await closed;
    expect(Date.now() - started).toBeLessThan(1000);
    const lines = text.trim().split("\n").map((line) => parseJsonObject(line));
    expect(lines.at(-1)).toMatchObject({ id: "wait", ok: false, error: { code: "api.no_run_token" } });
    expect(api.counts()).toEqual({ connections: 0, waits: 0 });
  });
});
