import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MachineAlertStore } from "./machine-alerts.ts";
import { MachineHistory, MINUTE_MS, minuteOf } from "./machine-history.ts";
import { MachineWatch, SOLO_MACHINE_ID, type MachineRosterEntry } from "./machines.ts";
import { serveMachinesRoute, type MachineRouteCaller } from "./server.ts";
import { ALERT_DURATIONS, ALERT_THRESHOLDS } from "../web/src/lib/machine-alerts.ts";
import { pointsInRange, runsOf } from "../web/src/lib/machine-chart.ts";
import { fetchMachineHistory, fetchMachines, apiErrorFields, setMachineAlerts } from "../web/src/lib/api.ts";

// THE MACHINES PAGES' TWO HALVES, ASKED OF EACH OTHER (ADR 0084).
//
// The phone's fetchers and chart functions were written against fixtures. This file serves the
// bridge's REAL machine routes (`serveMachinesRoute` over a real `MachineWatch`, real history and a
// real rule store) to the phone's REAL fetchers, so a renamed field, a reordered history tuple or a
// rule the phone offers and the bridge refuses fails here. It imports across the boundary on purpose,
// as `auth-path-contract.test.ts` does.

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
let fetchSpy: ReturnType<typeof spyOn> | undefined;
let dir: string;

// The phone's transport reads the mount off the page's `<meta>` and the device token out of
// `localStorage`. There is no page here: a root mount and no token is what a bare bridge sees.
Object.defineProperty(globalThis, "document", { value: { querySelector: () => null }, configurable: true });
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  configurable: true,
});

// The loaders import the build stamp vite bakes in at build time. Give it a value, then load them.
Object.defineProperty(globalThis, "__BUILD_INFO__", { value: { version: "0.0.0", channel: "dev" }, configurable: true });
const { machinesLoader } = await import("../web/src/lib/loaders.ts");

const ROSTER: MachineRosterEntry[] = [
  { id: "desk", name: "desk.lan", isLead: true, health: "reachable" },
  { id: "laptop", name: "laptop", isLead: false, health: "unreachable" },
];

const caller: MachineRouteCaller = { gate: () => null, device: () => "phone", audit: () => {} };

async function watchOf(roster: MachineRosterEntry[]): Promise<MachineWatch> {
  return new MachineWatch({
    now: () => NOW,
    roster: () => roster,
    history: new MachineHistory(),
    alerts: await MachineAlertStore.load(dir),
    saveHistory: async () => {},
    muted: () => false,
    enabled: () => true,
    send: () => {},
  });
}

/** The phone asks, the bridge's route handler answers. */
function serve(watch: MachineWatch | undefined): void {
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
        const url = new URL(input instanceof Request ? input.url : String(input), "http://bridge.test");
        const res = await serveMachinesRoute(new Request(url, init), url.pathname, caller, watch);
        return res ?? new Response("not found", { status: 404 });
      },
      // Bun's `fetch` type carries `preconnect`; a stand-in has nothing to connect to.
      { preconnect: () => {} },
    ),
  );
}

/** The error fields the phone reads off a refused call, or `undefined` when it did not fail. */
async function failureOf<T>(call: Promise<T>): Promise<ReturnType<typeof apiErrorFields>> {
  try {
    await call;
    return undefined;
  } catch (thrown) {
    return apiErrorFields(thrown);
  }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "collie-machines-contract-"));
});
afterAll(async () => {
  fetchSpy?.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("the phone's Machines fetchers read the bridge's real answers", () => {
  test("the census: a stale sample stays on an unreachable row, an older member has neither key", async () => {
    const watch = await watchOf([...ROSTER, { id: "pantry", name: "pantry", isLead: false, health: "reachable" }]);
    const sample = { cpu: 0.4, cores: 8, memUsed: 3e9, memTotal: 8e9, load1: 1.2, rxBps: 1000, txBps: 200 };
    watch.observe("desk", sample, NOW - 4000);
    watch.observe("laptop", { cpu: 0.1, cores: 2, memUsed: 1e9, memTotal: 4e9 }, NOW - 20 * MINUTE_MS);
    serve(watch);
    const census = await fetchMachines();
    expect(census.ts).toBe(NOW);
    const [desk, laptop, pantry] = census.machines;
    expect(desk).toMatchObject({ id: "desk", name: "desk.lan", isLead: true, health: "reachable", sample, sampledAt: NOW - 4000, alerts: {}, firing: [] });
    expect(laptop).toMatchObject({ id: "laptop", health: "unreachable", sampledAt: NOW - 20 * MINUTE_MS });
    expect(laptop!.sample).toEqual({ cpu: 0.1, cores: 2, memUsed: 1e9, memTotal: 4e9 });
    expect(pantry).toEqual({ id: "pantry", name: "pantry", isLead: false, health: "reachable", alerts: {}, firing: [] });
    expect("sample" in pantry!).toBe(false);
  });

  test("a solo collie is one row with the id `local`, and the loader reads it as a census", async () => {
    serve(await watchOf([{ id: SOLO_MACHINE_ID, name: "bluefin", isLead: true, health: "reachable" }]));
    const data = await machinesLoader();
    expect(data.error).toBe(false);
    expect(data.census?.machines.map((m) => [m.id, m.isLead])).toEqual([["local", true]]);
  });

  test("a peer's 404 crew.not_lead is no census, not a failure", async () => {
    serve(undefined);
    expect(await machinesLoader()).toEqual({ census: null, error: false });
  });

  test("the history tuple reads in the order the chart functions pick, and a missing minute is a gap", async () => {
    const watch = await watchOf(ROSTER);
    const start = minuteOf(NOW) - 10 * MINUTE_MS;
    // Minutes 0..2 and 5..8 are recorded; 3 and 4 are the hole a restart leaves.
    for (const m of [0, 1, 2, 5, 6, 7, 8]) {
      watch.observe("desk", { cpu: 0.1 * (m + 1), cores: 4, memUsed: 2e9, memTotal: 8e9, rxBps: 100 * (m + 1), txBps: 10 }, start + m * MINUTE_MS + 5000);
    }
    serve(watch);
    const history = await fetchMachineHistory("desk");
    expect(history.stepMs).toBe(MINUTE_MS);
    const inRange = pointsInRange(history.points, history.ts, "day");
    expect(inRange).toHaveLength(7);
    // [t, cpuAvg, cpuMax, memFrac, rx, tx]
    const cpu = runsOf(inRange, (p) => p[1], history.stepMs);
    expect(cpu.map((run) => run.map((pt) => pt.v))).toEqual([[0.1, 0.2, 0.3], [0.6, 0.7, 0.8, 0.9]]);
    expect(runsOf(inRange, (p) => p[3], history.stepMs).flat().every((pt) => pt.v === 0.25)).toBe(true);
    expect(runsOf(inRange, (p) => p[4], history.stepMs)[0]![0]!.v).toBe(100);
    expect(runsOf(inRange, (p) => p[2], history.stepMs).flat().length).toBe(7);
  });

  test("a machine the lead does not know is a 404 with the host.unknown code, on history and on alerts", async () => {
    serve(await watchOf(ROSTER));
    expect((await failureOf(fetchMachineHistory("ghost")))?.code).toBe("host.unknown");
    expect((await failureOf(setMachineAlerts("ghost", {})))?.code).toBe("host.unknown");
  });
});

describe("the rules the phone posts are the rules the bridge keeps", () => {
  test("every threshold and duration the control offers is accepted and read back unchanged", async () => {
    const watch = await watchOf(ROSTER);
    serve(watch);
    for (const above of ALERT_THRESHOLDS) {
      for (const forMin of ALERT_DURATIONS) {
        const stored = await setMachineAlerts("desk", { cpu: { above, forMin }, mem: { above, forMin } });
        expect(stored).toEqual({ alerts: { cpu: { above, forMin }, mem: { above, forMin } } });
      }
    }
    const census = await fetchMachines();
    expect(census.machines[0]!.alerts).toEqual({
      cpu: { above: 0.95, forMin: 60 },
      mem: { above: 0.95, forMin: 60 },
    });
  });

  test("the body is the WHOLE rule set: a missing key removes that rule, and {} removes both", async () => {
    const watch = await watchOf(ROSTER);
    serve(watch);
    await setMachineAlerts("laptop", { cpu: { above: 0.9, forMin: 10 }, mem: { above: 0.9, forMin: 10 } });
    expect(await setMachineAlerts("laptop", { mem: { above: 0.8, forMin: 5 } })).toEqual({ alerts: { mem: { above: 0.8, forMin: 5 } } });
    expect((await fetchMachines()).machines[1]!.alerts).toEqual({ mem: { above: 0.8, forMin: 5 } });
    expect(await setMachineAlerts("laptop", {})).toEqual({ alerts: {} });
    expect((await fetchMachines()).machines[1]!.alerts).toEqual({});
  });
});
