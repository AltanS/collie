// M105 spec 04, end to end: a trick's helper (`t.api`, helper v7) against the REAL local socket, the real
// operation table and the real reads over the fixture world. The level a trick declares decides what the
// helper sends: `see` gets `machines` and is refused `read` before any dial; `read` gets the screen.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Trick, type ApiAnswer, type Facts } from "../../cli/trick-kit/trick.ts";
import { asJsonObject, asJsonString } from "../../web/src/lib/json.ts";
import { depsOf, keyOf, world } from "./fixtures/reads-world.ts";
import { buildTable, LOCAL_TIER_RIGHTS } from "./operations.ts";
import { buildReads } from "./reads.ts";
import { ApiSocket, apiSocketPath } from "./socket.ts";

const dirs: string[] = [];
const sockets: ApiSocket[] = [];
afterAll(async () => {
  for (const api of sockets) await api.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

async function standing(): Promise<{ path: string; logs: string[]; w: ReturnType<typeof world> }> {
  const stateDir = mkdtempSync(join(tmpdir(), "collie-api-e2e-"));
  dirs.push(stateDir);
  const w = world();
  w.screens.set(keyOf("main", "w1:p1"), { ok: true, text: "the lodge build is green\n", truncated: false });
  const logs: string[] = [];
  const path = apiSocketPath(stateDir);
  const api = new ApiSocket({
    socketPath: path,
    table: buildTable({ version: () => "9.9.9-test", bus: w.bus, reads: buildReads(depsOf(w)) }),
    granted: LOCAL_TIER_RIGHTS,
    log: (line) => logs.push(line),
    platform: process.platform,
  });
  sockets.push(api);
  expect(await api.start()).toBe(true);
  return { path, logs, w };
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

function trick(socket: string, access: "see" | "read"): Trick {
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
    api: { socket, access },
  };
  return new Trick(facts);
}

describe.skipIf(process.platform === "win32")("a trick reads through the local API, end to end", () => {
  test("a `see` trick lists machines and sessions, names itself in the log, and is refused `read`", async () => {
    const { path, logs } = await standing();
    const t = trick(path, "see");
    const machines = await t.api("machines");
    expect(machines.ok).toBe(true);
    expect(machines.ok && Array.isArray(machines.machines)).toBe(true);
    const ids = sessionIds(await t.api("sessions"));
    expect(ids.length).toBeGreaterThan(0);
    expect(logs.some((line) => line.includes("trick:lodge"))).toBe(true);
    const refused = await t.api("read", { session: ids[0] ?? "" });
    expect(refused).toMatchObject({ ok: false, error: { code: "trick.api_level" } });
  });

  test("a `read` trick reads a session's screen", async () => {
    const { path } = await standing();
    const t = trick(path, "read");
    const first = sessionIds(await t.api("sessions"))[0];
    expect(first).toBeDefined();
    const read = await t.api("read", { session: first ?? "" });
    expect(read.ok).toBe(true);
    expect(JSON.stringify(read)).toContain("the lodge build is green");
  });
});
