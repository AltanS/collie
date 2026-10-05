import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AuditEntry } from "./audit.ts";
import { leadStore, member, T0 } from "./crew/fixtures.ts";
import { crewStatusBody } from "./crew/status-wire.ts";
import { MACHINE_ALERTS_FILE, MachineAlertStore } from "./machine-alerts.ts";
import { MachineHistory, MINUTE_MS, minuteOf } from "./machine-history.ts";
import { machineRosterOf, MachineWatch, SOLO_MACHINE_ID, type MachineRosterEntry } from "./machines.ts";
import { isReservedAuthPath, serveMachinesRoute, serveStatic, type MachineRouteCaller } from "./server.ts";
import type { MachineHistoryResponse, MachinesResponse } from "./types.ts";
import { NAVIGATION_NETWORK_ONLY } from "../web/src/lib/sw-routes.ts";

// The three `/api/machines*` routes (ADR 0084), driven through the exported handler with a fake
// caller, plus the two promises the Machines pages rest on: a row's id is the crew member id, and
// `/machines` and `/machines/:id` are app pages the bridge answers with the app shell.

const NOW = T0 + 10 * MINUTE_MS;

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-machines-routes-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** The lead's roster exactly as index.ts builds it: from the `GET /api/crew` body. */
function crewRoster(): MachineRosterEntry[] {
  const status = crewStatusBody({
    store: leadStore({ peers: [member({ memberId: "laptop" })] }),
    self: { id: "desk", name: "desk.lan" },
    version: "1.17.0",
    peers: [
      {
        state: {
          memberId: "laptop",
          health: "unreachable",
          lastSeenAt: T0,
          reason: "timed out",
          version: null,
          conflict: null,
          preflight: null,
        },
        name: "laptop",
        body: null,
      },
    ],
    now: NOW,
  });
  return machineRosterOf(status, { id: "desk", name: "desk.lan" });
}

async function watchOver(roster: MachineRosterEntry[]) {
  const dir = await tempDir();
  const watch = new MachineWatch({
    now: () => NOW,
    roster: () => roster,
    history: new MachineHistory(),
    alerts: await MachineAlertStore.load(dir),
    saveHistory: async () => {},
    muted: () => false,
    enabled: () => true,
    send: () => {},
  });
  return { watch, dir };
}

function caller(refuse?: "read" | "write") {
  const levels: string[] = [];
  const audited: AuditEntry[] = [];
  const c: MachineRouteCaller = {
    gate: (level) => {
      levels.push(level);
      return level === refuse ? new Response("device not paired", { status: 403 }) : null;
    },
    device: () => "phone",
    audit: (entry) => audited.push(entry),
  };
  return { c, levels, audited };
}

const get = (path: string) => new Request(`http://127.0.0.1${path}`);
const post = (path: string, body: string) =>
  new Request(`http://127.0.0.1${path}`, { method: "POST", body, headers: { "content-type": "application/json" } });

async function answer(req: Request, c: MachineRouteCaller, watch: MachineWatch | undefined): Promise<Response> {
  const res = await serveMachinesRoute(req, new URL(req.url).pathname, c, watch);
  if (res === null) throw new Error(`no machine route answered ${req.url}`);
  return res;
}

describe("a row's id is the crew member id", () => {
  test("the lead's own row and every member's, in the crew overview's order", async () => {
    const { watch } = await watchOver(crewRoster());
    // SAFETY: the handler emits `MachinesResponse` (server.ts, `serveMachinesRoute`).
    const body = (await (await answer(get("/api/machines"), caller().c, watch)).json()) as MachinesResponse;
    expect(body.machines.map((m) => m.id)).toEqual(["desk", "laptop"]);
    expect(body.machines.map((m) => [m.name, m.isLead, m.health])).toEqual([
      ["desk.lan", true, "reachable"],
      ["laptop", false, "unreachable"],
    ]);
  });

  test("a solo collie that never enrolled is one row, `local`, and it is the lead", () => {
    expect(machineRosterOf(null, { id: SOLO_MACHINE_ID, name: "bluefin" })).toEqual([
      { id: "local", name: "bluefin", isLead: true, health: "reachable" },
    ]);
  });
});

describe("GET /api/machines", () => {
  test("a sample and its time ride together, and a machine without one has neither key", async () => {
    const { watch } = await watchOver(crewRoster());
    const sample = { cpu: 0.3, cores: 8, memUsed: 2e9, memTotal: 8e9, load1: 0.7 };
    watch.observe("desk", sample, NOW - 4000);
    const { c, levels } = caller();
    const res = await answer(get("/api/machines"), c, watch);
    expect(res.status).toBe(200);
    expect(levels).toEqual(["read"]);
    expect(await res.json()).toEqual({
      ts: NOW,
      machines: [
        { id: "desk", name: "desk.lan", isLead: true, health: "reachable", sample, sampledAt: NOW - 4000, alerts: {}, firing: [] },
        { id: "laptop", name: "laptop", isLead: false, health: "unreachable", alerts: {}, firing: [] },
      ],
    });
  });

  test("?spark=N adds each row's last N complete minutes; without it, or with a bad N, the answer is unchanged", async () => {
    const { watch } = await watchOver(crewRoster());
    for (let m = 3; m >= 1; m--) {
      watch.observe("desk", { cpu: 0.1 * m, cores: 8, memUsed: m * 1e9, memTotal: 8e9 }, NOW - m * MINUTE_MS);
    }
    const plain = await (await answer(get("/api/machines"), caller().c, watch)).text();
    for (const bad of ["0", "61", "abc", "-1", "1.5", ""]) {
      expect(await (await answer(get(`/api/machines?spark=${bad}`), caller().c, watch)).text()).toBe(plain);
    }
    // SAFETY: the handler emits `MachinesResponse` (server.ts, `serveMachinesRoute`).
    const body = (await (await answer(get("/api/machines?spark=30"), caller().c, watch)).json()) as MachinesResponse;
    expect(body.machines[0]!.spark).toEqual({ stepMs: 60000, cpu: [0.3, 0.2, 0.1], mem: [0.38, 0.25, 0.13] });
    // A machine with no minute recorded carries no spark at all.
    expect("spark" in body.machines[1]!).toBe(false);
    // SAFETY: as above.
    const two = (await (await answer(get("/api/machines?spark=2"), caller().c, watch)).json()) as MachinesResponse;
    expect(two.machines[0]!.spark?.cpu).toEqual([0.2, 0.1]);
  });

  test("a peer has no watch and answers the /api/crew refusal on all three routes", async () => {
    for (const req of [get("/api/machines"), get("/api/machines/desk/history"), post("/api/machines/desk/alerts", "{}")]) {
      const res = await answer(req, caller().c, undefined);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('"code":"crew.not_lead"');
    }
  });

  test("the read gate runs first, and its refusal is the answer", async () => {
    const { watch } = await watchOver(crewRoster());
    expect((await answer(get("/api/machines"), caller("read").c, watch)).status).toBe(403);
  });

  test("anything else under /api is not a machine route", async () => {
    const { watch } = await watchOver(crewRoster());
    expect(await serveMachinesRoute(get("/api/machines/desk"), "/api/machines/desk", caller().c, watch)).toBeNull();
    expect(await serveMachinesRoute(get("/api/crew"), "/api/crew", caller().c, watch)).toBeNull();
  });
});

describe("GET /api/machines/:id/history", () => {
  test("one point per minute, oldest first, with the step on the wire", async () => {
    const { watch } = await watchOver(crewRoster());
    watch.observe("laptop", { cpu: 0.5, cores: 4, memUsed: 2e9, memTotal: 8e9, rxBps: 10, txBps: 20 }, NOW - 2 * MINUTE_MS);
    watch.observe("laptop", { cpu: 0.7, cores: 4, memUsed: 4e9, memTotal: 8e9 }, NOW - MINUTE_MS);
    // SAFETY: the handler emits `MachineHistoryResponse` (server.ts, `serveMachinesRoute`).
    const body = (await (await answer(get("/api/machines/laptop/history"), caller().c, watch)).json()) as MachineHistoryResponse;
    expect(body).toEqual({
      ts: NOW,
      stepMs: 60000,
      points: [
        // Each point is stamped with the start of its minute, not the time of the sample.
        [minuteOf(NOW - 2 * MINUTE_MS), 0.5, 0.5, 0.25, 10, 20, null],
        [minuteOf(NOW - MINUTE_MS), 0.7, 0.7, 0.5, null, null, null],
      ],
    });
  });

  test("?since keeps the minutes starting at or after it, and a bad value is ignored", async () => {
    const { watch } = await watchOver(crewRoster());
    for (let m = 3; m >= 1; m--) watch.observe("laptop", { cpu: 0.1 * m, cores: 4, memUsed: 2e9, memTotal: 8e9 }, NOW - m * MINUTE_MS);
    const read = async (q: string) =>
      // SAFETY: the handler emits `MachineHistoryResponse` (server.ts, `serveMachinesRoute`).
      ((await (await answer(get(`/api/machines/laptop/history${q}`), caller().c, watch)).json()) as MachineHistoryResponse).points.map((p) => p[0]);
    const all = await read("");
    expect(all).toHaveLength(3);
    expect(await read(`?since=${all[1]}`)).toEqual(all.slice(1));
    expect(await read(`?since=${NOW}`)).toEqual([]);
    expect(await read("?since=soon")).toEqual(all);
    expect(await read("?since=-5")).toEqual(all);
  });

  test("an unknown machine is a 404 naming it", async () => {
    const { watch } = await watchOver(crewRoster());
    const res = await answer(get("/api/machines/nas/history"), caller().c, watch);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "host.unknown", detail: { host: "nas" } });
  });

  test("only GET", async () => {
    const { watch } = await watchOver(crewRoster());
    expect((await answer(post("/api/machines/desk/history", "{}"), caller().c, watch)).status).toBe(405);
  });
});

describe("POST /api/machines/:id/alerts — a write, gated and audited", () => {
  test("it takes the WRITE gate, and a refusal stores nothing", async () => {
    const { watch, dir } = await watchOver(crewRoster());
    const { c, levels, audited } = caller("write");
    const res = await answer(post("/api/machines/laptop/alerts", JSON.stringify({ cpu: { above: 0.9, forMin: 10 } })), c, watch);
    expect(res.status).toBe(403);
    expect(levels).toEqual(["write"]);
    expect(audited).toEqual([]);
    expect(watch.rows().machines[1]!.alerts).toEqual({});
    await expect(readFile(join(dir, MACHINE_ALERTS_FILE), "utf8")).rejects.toThrow();
  });

  test("the whole rule set is stored, answered, shown on the row, and audited with the machine", async () => {
    const { watch } = await watchOver(crewRoster());
    const { c, audited } = caller();
    const rules = { cpu: { above: 0.9, forMin: 10 }, mem: { above: 0.8, forMin: 30 } };
    const res = await answer(post("/api/machines/laptop/alerts", JSON.stringify(rules)), c, watch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ alerts: rules });
    expect(watch.rows().machines[1]!.alerts).toEqual(rules);
    expect(audited).toEqual([
      {
        action: "machine.alerts",
        device: "phone",
        host: "laptop",
        detail: { cpuAbove: 0.9, cpuForMin: 10, memAbove: 0.8, memForMin: 30 },
      },
    ]);

    // A missing key removes that rule. The lead's own machine carries no `host`, as on every line.
    await answer(post("/api/machines/desk/alerts", JSON.stringify({ mem: { above: 0.95, forMin: 5 } })), c, watch);
    await answer(post("/api/machines/laptop/alerts", JSON.stringify({ mem: rules.mem })), c, watch);
    expect(watch.rows().machines.map((m) => m.alerts)).toEqual([{ mem: { above: 0.95, forMin: 5 } }, { mem: rules.mem }]);
    expect(audited[1]).toEqual({ action: "machine.alerts", device: "phone", detail: { memAbove: 0.95, memForMin: 5 } });
  });

  test("a body outside the bounds is a 400, an unknown machine a 404, and neither is audited", async () => {
    const { watch } = await watchOver(crewRoster());
    const { c, audited } = caller();
    expect((await answer(post("/api/machines/laptop/alerts", JSON.stringify({ cpu: { above: 1, forMin: 10 } })), c, watch)).status).toBe(400);
    expect((await answer(post("/api/machines/laptop/alerts", "{not json"), c, watch)).status).toBe(400);
    expect((await answer(post("/api/machines/nas/alerts", "{}"), c, watch)).status).toBe(404);
    expect((await answer(get("/api/machines/laptop/alerts"), c, watch)).status).toBe(405);
    expect(audited).toEqual([]);
  });
});

describe("/machines and /machines/:id are app pages", () => {
  test("the bridge answers both with the app shell, like every other client route", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "index.html"), "<!doctype html><title>Collie</title>");
    for (const path of ["/machines", "/machines/peer-7f3a2c", "/machines/local", "/crew"]) {
      const res = await serveStatic(path, null, dir);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("<title>Collie</title>");
      // Not claimed by a fronting proxy's namespace, and not refused the cached shell offline.
      expect(isReservedAuthPath(path)).toBe(false);
      expect(NAVIGATION_NETWORK_ONLY.some((re) => re.test(path))).toBe(false);
    }
  });
});
